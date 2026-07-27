/**
 * Unit tests for the pure connection state machine.
 *
 * The machine is deterministic — every scenario is expressed as a sequence of
 * events folded through `transition`, asserting on the resulting state and
 * the effects emitted along the way. No timers, no mocks, no React.
 */

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  NEGOTIATING_DEADLINE_MS,
  STARTING_DEADLINE_MS,
  backoffDelayMs,
  createInitialState,
  deriveUiState,
  describeState,
  transition,
  type ConnectionEffect,
  type ConnectionEvent,
  type ConnectionPhase,
  type ConnectionState,
} from '@/lib/ac2/connectionMachine';

/** Folds a sequence of events through the machine, collecting all effects. */
function run(
  events: ConnectionEvent[],
  from: ConnectionState = createInitialState(),
): { state: ConnectionState; effects: ConnectionEffect[] } {
  let state = from;
  const effects: ConnectionEffect[] = [];
  for (const event of events) {
    const result = transition(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

/** Asserts the phase and narrows the state type for property access. */
function expectPhase<P extends ConnectionPhase>(
  state: ConnectionState,
  phase: P,
): Extract<ConnectionState, { phase: P }> {
  expect(state.phase).toBe(phase);
  return state as Extract<ConnectionState, { phase: P }>;
}

function effectsOfType<T extends ConnectionEffect['type']>(
  effects: ConnectionEffect[],
  type: T,
): Extract<ConnectionEffect, { type: T }>[] {
  return effects.filter((e) => e.type === type) as Extract<ConnectionEffect, { type: T }>[];
}

/** START → SERVICE_READY → SOCKET_UP: service up, socket up, peer unknown. */
function bootToNegotiating(): Extract<ConnectionState, { phase: 'negotiating' }> {
  const { state } = run([{ type: 'START' }, { type: 'SERVICE_READY' }, { type: 'SOCKET_UP' }]);
  return expectPhase(state, 'negotiating');
}

function bootToConnected(): Extract<ConnectionState, { phase: 'connected' }> {
  const negotiating = bootToNegotiating();
  const { state } = run([{ type: 'ATTEMPT_OK', attemptId: negotiating.attemptId }], negotiating);
  return expectPhase(state, 'connected');
}

describe('connectionMachine', () => {
  describe('happy path', () => {
    it('walks START → SERVICE_READY → SOCKET_UP → PEER_PRESENT → ATTEMPT_OK → connected', () => {
      let result = transition(createInitialState(), { type: 'START' });
      const starting = expectPhase(result.state, 'starting');
      expect(effectsOfType(result.effects, 'startService')).toHaveLength(1);
      expect(effectsOfType(result.effects, 'armDeadline')).toEqual([
        { type: 'armDeadline', attemptId: starting.attemptId, ms: STARTING_DEADLINE_MS },
      ]);

      result = transition(result.state, { type: 'SERVICE_READY' });
      expectPhase(result.state, 'waiting');
      expect(result.state.serviceUp).toBe(true);

      // Peer presence is unknown (null) → allowed to try as soon as the
      // socket is up, matching the existing presence semantics.
      result = transition(result.state, { type: 'SOCKET_UP' });
      const negotiating = expectPhase(result.state, 'negotiating');
      expect(negotiating.mode).toBe('connect');
      expect(effectsOfType(result.effects, 'negotiate')).toEqual([
        { type: 'negotiate', attemptId: negotiating.attemptId, mode: 'connect' },
      ]);
      expect(effectsOfType(result.effects, 'armDeadline')).toEqual([
        { type: 'armDeadline', attemptId: negotiating.attemptId, ms: NEGOTIATING_DEADLINE_MS },
      ]);

      result = transition(result.state, { type: 'PEER_PRESENT' });
      expectPhase(result.state, 'negotiating');
      expect(result.state.peerPresent).toBe(true);
      expect(result.effects).toEqual([]);

      result = transition(result.state, { type: 'ATTEMPT_OK', attemptId: negotiating.attemptId });
      expectPhase(result.state, 'connected');
      expect(result.state.hadSession).toBe(true);
      expect(deriveUiState(result.state)).toMatchObject({
        isConnected: true,
        isLoading: false,
        isReconnecting: false,
      });
    });

    it('gates on a known-absent peer and negotiates once PEER_PRESENT arrives', () => {
      const { state: waiting } = run([
        { type: 'START' },
        { type: 'SERVICE_READY' },
        { type: 'PEER_ABSENT' },
        { type: 'SOCKET_UP' },
      ]);
      expectPhase(waiting, 'waiting');

      const result = transition(waiting, { type: 'PEER_PRESENT' });
      const negotiating = expectPhase(result.state, 'negotiating');
      expect(negotiating.mode).toBe('connect');
      expect(effectsOfType(result.effects, 'negotiate')).toHaveLength(1);
    });

    it('parks in waiting when the presence seed marks the peer absent DURING starting (cold launch, peer offline)', () => {
      // Regression: at a cold launch the room-join `presence` broadcast fires
      // while the native service starts, so the hook seeds PEER_ABSENT while
      // the machine is still `starting` — before SERVICE_READY. Without the
      // seed the gate stayed `null` ("unknown → allowed to try") and the
      // wallet negotiated forever into an offline peer, never showing the
      // peer-offline notice. SERVICE_READY must respect the already-closed
      // gate and park in `waiting` with no negotiation attempt.
      const { state, effects } = run([
        { type: 'START' },
        { type: 'PEER_ABSENT' },
        { type: 'SOCKET_UP' },
        { type: 'SERVICE_READY' },
      ]);
      const waiting = expectPhase(state, 'waiting');
      expect(waiting.peerPresent).toBe(false);
      expect(effectsOfType(effects, 'negotiate')).toEqual([]);
      // `waiting` + peerPresent === false is exactly what the hook surfaces
      // as the peer-offline notice (not the loading spinner).
      expect(deriveUiState(state)).toMatchObject({ isConnected: false, isReconnecting: false });

      // The peer coming online resumes the parked machine immediately.
      const result = transition(waiting, { type: 'PEER_PRESENT' });
      const negotiating = expectPhase(result.state, 'negotiating');
      expect(negotiating.mode).toBe('connect');
      expect(effectsOfType(result.effects, 'negotiate')).toHaveLength(1);
    });
  });

  describe('suspend → resume (the stuck-"Connecting" bug)', () => {
    it('reconciles a dead native side into a fresh connect attempt, ignoring the stale one', () => {
      const negotiating = bootToNegotiating();
      const staleAttemptId = negotiating.attemptId;

      let result = transition(negotiating, { type: 'APP_BACKGROUND' });
      expectPhase(result.state, 'negotiating');
      expect(result.state.foreground).toBe(false);

      result = transition(result.state, { type: 'APP_FOREGROUND' });
      expectPhase(result.state, 'negotiating');
      expect(effectsOfType(result.effects, 'queryNativeState')).toHaveLength(1);

      result = transition(result.state, {
        type: 'NATIVE_SNAPSHOT',
        alive: false,
        channelOpen: false,
      });
      const fresh = expectPhase(result.state, 'negotiating');
      expect(fresh.mode).toBe('connect');
      expect(fresh.attemptId).toBeGreaterThan(staleAttemptId);
      expect(effectsOfType(result.effects, 'teardown')).toEqual([
        { type: 'teardown', preserveNativePeer: false },
      ]);
      expect(effectsOfType(result.effects, 'negotiate')).toEqual([
        { type: 'negotiate', attemptId: fresh.attemptId, mode: 'connect' },
      ]);

      // The abandoned attempt's late results must not corrupt the new one.
      let stale = transition(result.state, {
        type: 'ATTEMPT_FAILED',
        attemptId: staleAttemptId,
        reason: 'late failure',
      });
      expect(stale.state).toBe(result.state);
      expect(stale.effects).toEqual([]);
      stale = transition(result.state, { type: 'ATTEMPT_OK', attemptId: staleAttemptId });
      expect(stale.state).toBe(result.state);
      expect(stale.effects).toEqual([]);

      const ok = transition(result.state, { type: 'ATTEMPT_OK', attemptId: fresh.attemptId });
      expectPhase(ok.state, 'connected');
    });

    it('re-attaches when the native peer survived the suspension', () => {
      const negotiating = bootToNegotiating();
      const resumed = run([{ type: 'APP_BACKGROUND' }, { type: 'APP_FOREGROUND' }], negotiating);

      const result = transition(resumed.state, {
        type: 'NATIVE_SNAPSHOT',
        alive: true,
        channelOpen: true,
      });
      const attach = expectPhase(result.state, 'negotiating');
      expect(attach.mode).toBe('attach');
      expect(attach.attemptId).toBeGreaterThan(negotiating.attemptId);
      // The stale in-flight attempt is torn down WITHOUT killing the live
      // native peer we are about to attach to.
      expect(effectsOfType(result.effects, 'teardown')).toEqual([
        { type: 'teardown', preserveNativePeer: true },
      ]);
    });

    it('treats a dead snapshot as CONNECTION_LOST when connected', () => {
      const connected = bootToConnected();
      const resumed = run([{ type: 'APP_BACKGROUND' }, { type: 'APP_FOREGROUND' }], connected);
      expect(effectsOfType(resumed.effects, 'queryNativeState')).toHaveLength(1);

      const dead = transition(resumed.state, {
        type: 'NATIVE_SNAPSHOT',
        alive: false,
        channelOpen: false,
      });
      const backoff = expectPhase(dead.state, 'backoff');
      expect(backoff.delayMs).toBe(BACKOFF_BASE_MS);
      expect(effectsOfType(dead.effects, 'scheduleRetry')).toHaveLength(1);
    });

    it('keeps a healthy connection untouched when the snapshot is alive', () => {
      const connected = bootToConnected();
      const resumed = run([{ type: 'APP_BACKGROUND' }, { type: 'APP_FOREGROUND' }], connected);
      const result = transition(resumed.state, {
        type: 'NATIVE_SNAPSHOT',
        alive: true,
        channelOpen: true,
      });
      expectPhase(result.state, 'connected');
      expect(result.effects).toEqual([]);
    });
  });

  describe('stale attempt results', () => {
    it('ignores ATTEMPT_OK / ATTEMPT_FAILED / DEADLINE with an old attemptId', () => {
      const negotiating = bootToNegotiating();
      const oldId = negotiating.attemptId - 1;

      for (const event of [
        { type: 'ATTEMPT_OK', attemptId: oldId },
        { type: 'ATTEMPT_FAILED', attemptId: oldId, reason: 'stale' },
        { type: 'DEADLINE', attemptId: oldId },
      ] as ConnectionEvent[]) {
        const result = transition(negotiating, event);
        expect(result.state).toBe(negotiating);
        expect(result.effects).toEqual([]);
      }
    });
  });

  describe('deadlines and exponential backoff', () => {
    it('funnels a negotiation deadline into a 2s backoff, then 4s/8s/16s/30s/30s', () => {
      let state: ConnectionState = bootToNegotiating();
      const expectedDelays = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

      for (const [index, expectedDelay] of expectedDelays.entries()) {
        const negotiating = expectPhase(state, 'negotiating');
        const failure =
          index === 0
            ? transition(negotiating, { type: 'DEADLINE', attemptId: negotiating.attemptId })
            : transition(negotiating, {
                type: 'ATTEMPT_FAILED',
                attemptId: negotiating.attemptId,
                reason: 'boom',
              });
        const backoff = expectPhase(failure.state, 'backoff');
        expect(backoff.attempt).toBe(index + 1);
        expect(backoff.delayMs).toBe(expectedDelay);
        expect(effectsOfType(failure.effects, 'scheduleRetry')).toEqual([
          { type: 'scheduleRetry', delayMs: expectedDelay },
        ]);
        expect(effectsOfType(failure.effects, 'teardown')).toHaveLength(1);

        const retry = transition(backoff, { type: 'RETRY_DUE' });
        const next = expectPhase(retry.state, 'negotiating');
        expect(next.attemptId).toBeGreaterThan(negotiating.attemptId);
        expect(effectsOfType(retry.effects, 'negotiate')).toHaveLength(1);
        state = retry.state;
      }
    });

    it('exports the documented backoff schedule', () => {
      expect(BACKOFF_BASE_MS).toBe(2_000);
      expect(BACKOFF_MAX_MS).toBe(30_000);
      expect([1, 2, 3, 4, 5, 6, 7].map(backoffDelayMs)).toEqual([
        2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
      ]);
    });

    it('resets the delay schedule after a successful connection', () => {
      const negotiating = bootToNegotiating();
      const failed = transition(negotiating, {
        type: 'ATTEMPT_FAILED',
        attemptId: negotiating.attemptId,
        reason: 'boom',
      });
      const retried = transition(failed.state, { type: 'RETRY_DUE' });
      const second = expectPhase(retried.state, 'negotiating');
      const ok = transition(second, { type: 'ATTEMPT_OK', attemptId: second.attemptId });
      const lost = transition(ok.state, { type: 'CONNECTION_LOST', reason: 'ice failed' });
      expect(expectPhase(lost.state, 'backoff').delayMs).toBe(BACKOFF_BASE_MS);
    });
  });

  describe('gate reopen during backoff (agent restart)', () => {
    /** connected → CONNECTION_LOST → PEER_ABSENT: backoff with a known-absent peer. */
    function backoffWithPeerAbsent() {
      const connected = bootToConnected();
      const { state } = run(
        [{ type: 'CONNECTION_LOST', reason: 'data channel closed' }, { type: 'PEER_ABSENT' }],
        connected,
      );
      const backoff = expectPhase(state, 'backoff');
      expect(backoff.peerPresent).toBe(false);
      return backoff;
    }

    it('retries immediately when the peer returns mid-backoff instead of waiting out the delay', () => {
      // Regression: the agent restarts → data channel closes → backoff. The
      // doomed retry parks the delay while presence drops, and when the agent
      // came back the old machine just patched `peerPresent` and sat out the
      // remaining (up to 30s) delay — "Reconnecting…" against a visibly-online
      // peer. The absent→present transition must retry NOW.
      const backoff = backoffWithPeerAbsent();
      const result = transition(backoff, { type: 'PEER_PRESENT' });
      const negotiating = expectPhase(result.state, 'negotiating');
      expect(negotiating.mode).toBe('connect');
      expect(effectsOfType(result.effects, 'cancelTimers')).toHaveLength(1);
      expect(effectsOfType(result.effects, 'negotiate')).toEqual([
        { type: 'negotiate', attemptId: negotiating.attemptId, mode: 'connect' },
      ]);
    });

    it('keeps the throttle for repeated broadcasts of an unchanged present peer', () => {
      const connected = bootToConnected();
      const { state } = run(
        [{ type: 'PEER_PRESENT' }, { type: 'CONNECTION_LOST', reason: 'data channel closed' }],
        connected,
      );
      const backoff = expectPhase(state, 'backoff');
      expect(backoff.peerPresent).toBe(true);
      const result = transition(backoff, { type: 'PEER_PRESENT' });
      expectPhase(result.state, 'backoff');
      expect(result.effects).toEqual([]);
    });

    it('does not fast-path the first presence report of an unknown peer (null → true)', () => {
      const { state } = run([{ type: 'START' }]);
      const starting = expectPhase(state, 'starting');
      const timedOut = transition(starting, { type: 'DEADLINE', attemptId: starting.attemptId });
      const backoff = expectPhase(timedOut.state, 'backoff');
      expect(backoff.peerPresent).toBeNull();
      const result = transition(backoff, { type: 'PEER_PRESENT' });
      expectPhase(result.state, 'backoff');
      expect(result.effects).toEqual([]);
    });

    it('stays paused when the peer returns while backgrounded (snapshot reconcile owns resume)', () => {
      const backoff = backoffWithPeerAbsent();
      const paused = expectPhase(transition(backoff, { type: 'APP_BACKGROUND' }).state, 'backoff');
      const result = transition(paused, { type: 'PEER_PRESENT' });
      const still = expectPhase(result.state, 'backoff');
      expect(still.pausedInBackground).toBe(true);
      expect(still.peerPresent).toBe(true);
      expect(result.effects).toEqual([]);
    });

    it('parks in waiting (no negotiate) when the peer returns but the socket is down', () => {
      const connected = bootToConnected();
      const { state } = run(
        [
          { type: 'SOCKET_DOWN' },
          { type: 'CONNECTION_LOST', reason: 'heartbeat missed' },
          { type: 'PEER_ABSENT' },
        ],
        connected,
      );
      const backoff = expectPhase(state, 'backoff');
      const result = transition(backoff, { type: 'PEER_PRESENT' });
      expectPhase(result.state, 'waiting');
      expect(effectsOfType(result.effects, 'negotiate')).toEqual([]);
    });

    it('retries immediately when the signaling socket reconnects mid-backoff', () => {
      const connected = bootToConnected();
      const { state } = run(
        [{ type: 'SOCKET_DOWN' }, { type: 'CONNECTION_LOST', reason: 'heartbeat missed' }],
        connected,
      );
      const backoff = expectPhase(state, 'backoff');
      expect(backoff.socketReady).toBe(false);
      const result = transition(backoff, { type: 'SOCKET_UP' });
      const negotiating = expectPhase(result.state, 'negotiating');
      expect(negotiating.mode).toBe('connect');
      expect(effectsOfType(result.effects, 'cancelTimers')).toHaveLength(1);
      expect(effectsOfType(result.effects, 'negotiate')).toHaveLength(1);
    });

    it('keeps the failure count: a failed fast-path retry backs off on schedule', () => {
      const backoff = backoffWithPeerAbsent();
      expect(backoff.attempt).toBe(1);
      const result = transition(backoff, { type: 'PEER_PRESENT' });
      const negotiating = expectPhase(result.state, 'negotiating');
      const failed = transition(negotiating, {
        type: 'ATTEMPT_FAILED',
        attemptId: negotiating.attemptId,
        reason: 'boom',
      });
      expect(expectPhase(failed.state, 'backoff').delayMs).toBe(backoffDelayMs(2));
    });
  });

  describe('background pause / foreground resume', () => {
    it('pauses backoff in background and resumes via the snapshot reconcile', () => {
      const negotiating = bootToNegotiating();
      const failed = transition(negotiating, {
        type: 'ATTEMPT_FAILED',
        attemptId: negotiating.attemptId,
        reason: 'boom',
      });
      expectPhase(failed.state, 'backoff');

      const backgrounded = transition(failed.state, { type: 'APP_BACKGROUND' });
      const paused = expectPhase(backgrounded.state, 'backoff');
      expect(paused.pausedInBackground).toBe(true);
      expect(effectsOfType(backgrounded.effects, 'cancelTimers')).toHaveLength(1);

      // A stray timer firing while paused must not negotiate in background.
      const stray = transition(paused, { type: 'RETRY_DUE' });
      expect(stray.state).toBe(paused);
      expect(stray.effects).toEqual([]);

      const foregrounded = transition(paused, { type: 'APP_FOREGROUND' });
      expectPhase(foregrounded.state, 'backoff');
      expect(effectsOfType(foregrounded.effects, 'queryNativeState')).toHaveLength(1);

      const result = transition(foregrounded.state, {
        type: 'NATIVE_SNAPSHOT',
        alive: false,
        channelOpen: false,
      });
      const fresh = expectPhase(result.state, 'negotiating');
      expect(fresh.mode).toBe('connect');

      // The snapshot restart resets the delay schedule back to the base.
      const fail = transition(fresh, {
        type: 'ATTEMPT_FAILED',
        attemptId: fresh.attemptId,
        reason: 'boom again',
      });
      expect(expectPhase(fail.state, 'backoff').delayMs).toBe(BACKOFF_BASE_MS);
    });

    it('enters backoff already paused when the connection is lost in background', () => {
      const connected = bootToConnected();
      const backgrounded = transition(connected, { type: 'APP_BACKGROUND' });
      const lost = transition(backgrounded.state, { type: 'CONNECTION_LOST', reason: 'heartbeat' });
      const backoff = expectPhase(lost.state, 'backoff');
      expect(backoff.pausedInBackground).toBe(true);
      expect(effectsOfType(lost.effects, 'scheduleRetry')).toEqual([]);
    });
  });

  describe('terminal failures', () => {
    it('treats session-full as terminal: no auto-retry, USER_RECONNECT recovers', () => {
      const negotiating = bootToNegotiating();
      const result = transition(negotiating, {
        type: 'ATTEMPT_FAILED',
        attemptId: negotiating.attemptId,
        reason: 'session already has two peers',
        terminal: 'session-full',
      });
      const failed = expectPhase(result.state, 'failed');
      expect(failed.kind).toBe('session-full');
      expect(effectsOfType(result.effects, 'scheduleRetry')).toEqual([]);
      expect(effectsOfType(result.effects, 'teardown')).toHaveLength(1);

      const retry = transition(failed, { type: 'RETRY_DUE' });
      expect(retry.state).toBe(failed);
      expect(retry.effects).toEqual([]);

      const peer = transition(failed, { type: 'PEER_PRESENT' });
      expectPhase(peer.state, 'failed');
      expect(peer.effects).toEqual([]);

      const recovered = transition(failed, { type: 'USER_RECONNECT' });
      const fresh = expectPhase(recovered.state, 'negotiating');
      expect(fresh.mode).toBe('connect');
      expect(effectsOfType(recovered.effects, 'negotiate')).toHaveLength(1);
    });

    it('maps SERVICE_FAILED to a terminal failed state with its kind', () => {
      const { state } = run([{ type: 'START' }]);
      const result = transition(state, {
        type: 'SERVICE_FAILED',
        reason: 'passkey assertion rejected',
        kind: 'auth',
      });
      const failed = expectPhase(result.state, 'failed');
      expect(failed.kind).toBe('auth');
      expect(effectsOfType(result.effects, 'teardown')).toHaveLength(1);
    });
  });

  describe('STOP', () => {
    it('stops from any phase with a teardown effect and then ignores everything but START', () => {
      const negotiating = bootToNegotiating();
      const connected = bootToConnected();
      const backoff = transition(negotiating, {
        type: 'DEADLINE',
        attemptId: negotiating.attemptId,
      }).state;
      const failed = transition(negotiating, {
        type: 'ATTEMPT_FAILED',
        attemptId: negotiating.attemptId,
        reason: 'full',
        terminal: 'session-full',
      }).state;
      const starting = run([{ type: 'START' }]).state;
      const waiting = run([{ type: 'START' }, { type: 'SERVICE_READY' }]).state;

      for (const state of [starting, waiting, negotiating, connected, backoff, failed]) {
        const stopped = transition(state, { type: 'STOP' });
        expectPhase(stopped.state, 'stopped');
        expect(effectsOfType(stopped.effects, 'teardown')).toEqual([
          { type: 'teardown', preserveNativePeer: false },
        ]);
        expect(effectsOfType(stopped.effects, 'cancelTimers')).toHaveLength(1);

        for (const event of [
          { type: 'SOCKET_UP' },
          { type: 'PEER_PRESENT' },
          { type: 'RETRY_DUE' },
          { type: 'USER_RECONNECT' },
          { type: 'NATIVE_SNAPSHOT', alive: true, channelOpen: true },
        ] as ConnectionEvent[]) {
          const ignored = transition(stopped.state, event);
          expect(ignored.state).toBe(stopped.state);
          expect(ignored.effects).toEqual([]);
        }

        const restarted = transition(stopped.state, { type: 'START' });
        expectPhase(restarted.state, 'starting');
        expect(effectsOfType(restarted.effects, 'startService')).toHaveLength(1);
      }
    });
  });

  describe('connection loss', () => {
    it('CONNECTION_LOST from connected → backoff, reported as reconnecting', () => {
      const connected = bootToConnected();
      const result = transition(connected, { type: 'CONNECTION_LOST', reason: 'channel closed' });
      const backoff = expectPhase(result.state, 'backoff');
      expect(backoff.reason).toBe('channel closed');
      expect(backoff.hadSession).toBe(true);
      expect(effectsOfType(result.effects, 'teardown')).toHaveLength(1);
      expect(deriveUiState(backoff)).toMatchObject({
        isConnected: false,
        isLoading: false,
        isReconnecting: true,
        canManualReconnect: true,
      });
    });

    it('PEER_ABSENT while connected behaves like CONNECTION_LOST and gates the retry', () => {
      const connected = bootToConnected();
      const result = transition(connected, { type: 'PEER_ABSENT' });
      expectPhase(result.state, 'backoff');

      // Peer is known absent → the retry parks in `waiting` instead of
      // negotiating blindly; PEER_PRESENT then un-gates it.
      const retried = transition(result.state, { type: 'RETRY_DUE' });
      expectPhase(retried.state, 'waiting');
      expect(effectsOfType(retried.effects, 'negotiate')).toEqual([]);

      const present = transition(retried.state, { type: 'PEER_PRESENT' });
      expectPhase(present.state, 'negotiating');
    });
  });

  describe('socket loss', () => {
    it('abandons negotiation on SOCKET_DOWN; RETRY_DUE waits for the socket', () => {
      const negotiating = bootToNegotiating();
      const result = transition(negotiating, { type: 'SOCKET_DOWN' });
      const backoff = expectPhase(result.state, 'backoff');
      expect(backoff.socketReady).toBe(false);
      expect(effectsOfType(result.effects, 'teardown')).toHaveLength(1);

      const retried = transition(backoff, { type: 'RETRY_DUE' });
      expectPhase(retried.state, 'waiting');
      expect(effectsOfType(retried.effects, 'negotiate')).toEqual([]);

      const socketUp = transition(retried.state, { type: 'SOCKET_UP' });
      const fresh = expectPhase(socketUp.state, 'negotiating');
      expect(fresh.mode).toBe('connect');
      expect(effectsOfType(socketUp.effects, 'negotiate')).toHaveLength(1);
    });

    it('stays connected on SOCKET_DOWN (p2p can outlive signaling)', () => {
      const connected = bootToConnected();
      const result = transition(connected, { type: 'SOCKET_DOWN' });
      expectPhase(result.state, 'connected');
      expect(result.state.socketReady).toBe(false);
      expect(result.effects).toEqual([]);
    });
  });

  describe('deriveUiState', () => {
    it('maps every phase to the expected UI flags', () => {
      const stopped = createInitialState();
      expect(deriveUiState(stopped)).toEqual({
        isConnected: false,
        isLoading: false,
        isReconnecting: false,
        reconnectAttempt: 0,
        canManualReconnect: false,
        failureReason: null,
      });

      const starting = run([{ type: 'START' }]).state;
      expect(deriveUiState(starting)).toMatchObject({ isLoading: true, isReconnecting: false });

      const waiting = run([{ type: 'START' }, { type: 'SERVICE_READY' }]).state;
      expect(deriveUiState(waiting)).toMatchObject({ isLoading: true, isReconnecting: false });

      const negotiating = bootToNegotiating();
      expect(deriveUiState(negotiating)).toMatchObject({
        isLoading: true,
        isReconnecting: false,
      });

      const connected = bootToConnected();
      expect(deriveUiState(connected)).toMatchObject({
        isConnected: true,
        isLoading: false,
        isReconnecting: false,
      });

      const lost = transition(connected, { type: 'CONNECTION_LOST', reason: 'gone' });
      const backoff = expectPhase(lost.state, 'backoff');
      expect(deriveUiState(backoff)).toMatchObject({
        isLoading: false,
        isReconnecting: true,
        reconnectAttempt: 1,
        canManualReconnect: true,
      });

      const reconnecting = transition(backoff, { type: 'RETRY_DUE' });
      expect(deriveUiState(reconnecting.state)).toMatchObject({
        isLoading: false,
        isReconnecting: true,
      });

      const failed = transition(bootToNegotiating(), {
        type: 'ATTEMPT_FAILED',
        attemptId: bootToNegotiating().attemptId,
        reason: 'session full',
        terminal: 'session-full',
      });
      expect(deriveUiState(failed.state)).toMatchObject({
        isLoading: false,
        canManualReconnect: true,
        failureReason: 'session full',
      });
    });
  });

  describe('describeState', () => {
    it('produces a log-friendly line for each phase', () => {
      expect(describeState(createInitialState())).toContain('stopped');
      const negotiating = bootToNegotiating();
      expect(describeState(negotiating)).toContain('negotiating');
      expect(describeState(negotiating)).toContain('mode=connect');
    });
  });
  describe('idle sessions', () => {
    it('SESSION_IDLE while connected fails with kind=idle and tears down (manual recovery)', () => {
      const connected = bootToConnected();
      const result = transition(connected, { type: 'SESSION_IDLE' });
      const failed = expectPhase(result.state, 'failed');
      expect(failed.kind).toBe('idle');
      expect(failed.reason).toBe('Session idle');
      expect(effectsOfType(result.effects, 'teardown')).toEqual([
        { type: 'teardown', preserveNativePeer: false },
      ]);
      expect(deriveUiState(result.state)).toMatchObject({
        isConnected: false,
        isLoading: false,
        isReconnecting: false,
        canManualReconnect: true,
      });
    });

    it('ignores SESSION_IDLE outside connected', () => {
      const stopped = createInitialState();
      expect(transition(stopped, { type: 'SESSION_IDLE' })).toEqual({
        state: stopped,
        effects: [],
      });

      const negotiating = bootToNegotiating();
      expect(transition(negotiating, { type: 'SESSION_IDLE' })).toEqual({
        state: negotiating,
        effects: [],
      });

      const fromNegotiating = bootToNegotiating();
      const backoff = expectPhase(
        run([{ type: 'DEADLINE', attemptId: fromNegotiating.attemptId }], fromNegotiating).state,
        'backoff',
      );
      expect(transition(backoff, { type: 'SESSION_IDLE' })).toEqual({
        state: backoff,
        effects: [],
      });
    });

    it('recovers from an idle failure via USER_RECONNECT', () => {
      const { state: failed } = run([{ type: 'SESSION_IDLE' }], bootToConnected());
      expectPhase(failed, 'failed');
      const result = transition(failed, { type: 'USER_RECONNECT' });
      const negotiating = expectPhase(result.state, 'negotiating');
      expect(negotiating.mode).toBe('connect');
      expect(effectsOfType(result.effects, 'negotiate')).toHaveLength(1);
    });
  });

  describe('waiting-phase hydration', () => {
    it('attaches to a live native connection reported while waiting', () => {
      // Socket still down -> parked in waiting; a live open channel is itself
      // proof the peer exists, so the snapshot bypasses the gates.
      const waiting = expectPhase(
        run([{ type: 'START' }, { type: 'SERVICE_READY' }]).state,
        'waiting',
      );
      const result = transition(waiting, {
        type: 'NATIVE_SNAPSHOT',
        alive: true,
        channelOpen: true,
      });
      const negotiating = expectPhase(result.state, 'negotiating');
      expect(negotiating.mode).toBe('attach');
      expect(effectsOfType(result.effects, 'negotiate')).toEqual([
        { type: 'negotiate', attemptId: negotiating.attemptId, mode: 'attach' },
      ]);
    });

    it('stays gated when the snapshot reports no live connection', () => {
      const waiting = expectPhase(
        run([{ type: 'START' }, { type: 'SERVICE_READY' }]).state,
        'waiting',
      );
      const result = transition(waiting, {
        type: 'NATIVE_SNAPSHOT',
        alive: false,
        channelOpen: false,
      });
      expectPhase(result.state, 'waiting');
      expect(result.effects).toEqual([]);
    });
  });
});
