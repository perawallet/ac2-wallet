/**
 * Pure, deterministic connection state machine for the wallet's ac2 link.
 *
 * `useConnection` historically coordinated auth, negotiation, retries and
 * app-state handling through a soup of booleans and refs; five independent
 * detectors raced each other and a suspended attempt could leave the UI stuck
 * on "Connecting…" forever. This module replaces that with ONE explicit
 * reducer: `transition(state, event) -> { state, effects }`.
 *
 * Design notes:
 * - **Attempt ids.** Every negotiation (and service start) gets a fresh,
 *   monotonically increasing `attemptId`. Results (`ATTEMPT_OK`,
 *   `ATTEMPT_FAILED`, `DEADLINE`) carrying a stale id are ignored, so a
 *   superseded/abandoned attempt can never corrupt newer state — the root of
 *   the old non-determinism.
 * - **Deadlines.** Every in-flight phase arms a deadline (`armDeadline`
 *   effect). Nothing can hang forever with `isLoading = true`: either the
 *   attempt resolves or its deadline funnels it into backoff.
 * - **Snapshot reconcile.** Native push events can be lost while the JS
 *   runtime is suspended. On foregrounding, the machine *pulls* the truth via
 *   the `queryNativeState` effect and reconciles on `NATIVE_SNAPSHOT`:
 *   attach to a surviving native peer, or abandon any stale in-flight attempt
 *   and start a fresh connect immediately. This is the fix for the
 *   stuck-"Connecting" bug on suspend → resume.
 * - **Retry policy.** Exponential backoff (2s → 4s → 8s → 16s → 30s cap),
 *   unlimited attempts while foregrounded, paused while backgrounded.
 *
 * Pure TypeScript: no React, no react-native, no native modules. All timing
 * is injected via events — the owning hook runs the timers and feeds
 * `RETRY_DUE` / `DEADLINE` back in. Effects are returned as data.
 */

/** Deadline for auth + native service bring-up (`starting` phase). */
export const STARTING_DEADLINE_MS = 45_000;
/** Deadline for a single negotiation attempt (`negotiating` phase). */
export const NEGOTIATING_DEADLINE_MS = 30_000;
/** First retry delay; doubles on every consecutive failure. */
export const BACKOFF_BASE_MS = 2_000;
/** Retry delay ceiling. */
export const BACKOFF_MAX_MS = 30_000;

/** Terminal failure classification (drives copy + whether retry is offered). */
export type FailureKind = 'session-full' | 'auth' | 'service' | 'idle' | 'generic';

/** How a negotiation attempt reaches the peer. */
export type NegotiationMode = 'connect' | 'attach';

/**
 * Context shared by every phase. Gate flags mirror the latest native events;
 * `peerPresent === null` means "unknown" and is allowed to try (matching the
 * existing presence semantics).
 */
interface ConnectionContext {
  /** Native foreground service is up (auth + start completed). */
  serviceUp: boolean;
  /** Signaling socket reported connected. */
  socketReady: boolean;
  /** Last known peer presence; `null` = unknown → allowed to try. */
  peerPresent: boolean | null;
  /** A session connected successfully at least once (drives isReconnecting). */
  hadSession: boolean;
  /** App is foregrounded (retries only run while foregrounded). */
  foreground: boolean;
  /** Next attempt id to hand out; strictly monotonic for the machine's life. */
  nextAttemptId: number;
  /** Consecutive failed attempts; 0 after a success or a snapshot reset. */
  retryCount: number;
}

export type ConnectionState =
  /** User stopped / not started. Only `START` leaves this phase. */
  | ({ phase: 'stopped' } & ConnectionContext)
  /** Auth + native service bring-up in flight (deadline-guarded). */
  | ({ phase: 'starting'; attemptId: number } & ConnectionContext)
  /** Service up but gated on `socketReady` / `peerPresent`. */
  | ({ phase: 'waiting' } & ConnectionContext)
  /** One negotiation attempt in flight (deadline-guarded). */
  | ({ phase: 'negotiating'; attemptId: number; mode: NegotiationMode } & ConnectionContext)
  /** Data channel open and healthy. */
  | ({ phase: 'connected' } & ConnectionContext)
  /** Waiting out an exponential-backoff delay before the next attempt. */
  | ({
      phase: 'backoff';
      attempt: number;
      delayMs: number;
      reason: string;
      pausedInBackground: boolean;
    } & ConnectionContext)
  /** Terminal until user action (e.g. session full, auth rejected). */
  | ({ phase: 'failed'; reason: string; kind: FailureKind } & ConnectionContext);

export type ConnectionPhase = ConnectionState['phase'];

export type ConnectionEvent =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'SERVICE_READY' }
  | { type: 'SERVICE_FAILED'; reason: string; kind?: 'auth' | 'service' }
  | { type: 'SOCKET_UP' }
  | { type: 'SOCKET_DOWN' }
  | { type: 'PEER_PRESENT' }
  | { type: 'PEER_ABSENT' }
  | { type: 'ATTEMPT_OK'; attemptId: number }
  | { type: 'ATTEMPT_FAILED'; attemptId: number; reason: string; terminal?: FailureKind }
  | { type: 'DEADLINE'; attemptId: number }
  | { type: 'CONNECTION_LOST'; reason: string }
  | { type: 'SESSION_IDLE' }
  | { type: 'RETRY_DUE' }
  | { type: 'APP_BACKGROUND' }
  | { type: 'APP_FOREGROUND' }
  | { type: 'NATIVE_SNAPSHOT'; alive: boolean; channelOpen: boolean }
  | { type: 'USER_RECONNECT' };

export type ConnectionEffect =
  | { type: 'startService' }
  | { type: 'negotiate'; attemptId: number; mode: NegotiationMode }
  | { type: 'armDeadline'; attemptId: number; ms: number }
  | { type: 'scheduleRetry'; delayMs: number }
  | { type: 'cancelTimers' }
  | { type: 'teardown'; preserveNativePeer: boolean }
  | { type: 'queryNativeState' };

export interface TransitionResult {
  state: ConnectionState;
  effects: ConnectionEffect[];
}

/** UI projection consumed by the hook — the single place phase → UI maps. */
export interface ConnectionUiState {
  isConnected: boolean;
  isLoading: boolean;
  isReconnecting: boolean;
  /** Current retry attempt number (0 when not retrying). */
  reconnectAttempt: number;
  /** Whether a manual "reconnect" affordance should be offered. */
  canManualReconnect: boolean;
  /** Terminal failure reason, or `null` outside the `failed` phase. */
  failureReason: string | null;
}

/** Creates the machine's initial (stopped) state. */
export function createInitialState(options?: { foreground?: boolean }): ConnectionState {
  return {
    phase: 'stopped',
    serviceUp: false,
    socketReady: false,
    peerPresent: null,
    hadSession: false,
    foreground: options?.foreground ?? true,
    nextAttemptId: 1,
    retryCount: 0,
  };
}

/** Exponential backoff schedule: 2s, 4s, 8s, 16s, 30s, 30s, … */
export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(1, attempt) - 1;
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}

/** Log-friendly one-line description of a state. */
export function describeState(state: ConnectionState): string {
  const gates = `socket=${state.socketReady} peer=${String(state.peerPresent)} fg=${state.foreground}`;
  switch (state.phase) {
    case 'stopped':
      return `stopped (${gates})`;
    case 'starting':
      return `starting attempt=${state.attemptId} (${gates})`;
    case 'waiting':
      return `waiting (${gates})`;
    case 'negotiating':
      return `negotiating attempt=${state.attemptId} mode=${state.mode} (${gates})`;
    case 'connected':
      return `connected (${gates})`;
    case 'backoff':
      return `backoff attempt=${state.attempt} delay=${state.delayMs}ms paused=${state.pausedInBackground} reason=${state.reason} (${gates})`;
    case 'failed':
      return `failed kind=${state.kind} reason=${state.reason} (${gates})`;
  }
}

/** Maps a machine state to the flags the UI renders. */
export function deriveUiState(state: ConnectionState): ConnectionUiState {
  const retrying = state.phase === 'negotiating' || state.phase === 'backoff';
  return {
    isConnected: state.phase === 'connected',
    // First-time bring-up (no prior session) shows the "Connecting…" spinner;
    // this includes first-time backoff so the UI never goes blank mid-retry.
    isLoading:
      state.phase === 'starting' || state.phase === 'waiting' || (retrying && !state.hadSession),
    isReconnecting: retrying && state.hadSession,
    reconnectAttempt: state.phase === 'backoff' ? state.attempt : state.retryCount,
    canManualReconnect: state.phase === 'failed' || state.phase === 'backoff',
    failureReason: state.phase === 'failed' ? state.reason : null,
  };
}

/** Extracts the shared context, dropping phase-specific fields. */
function contextOf(state: ConnectionState): ConnectionContext {
  const { serviceUp, socketReady, peerPresent, hadSession, foreground, nextAttemptId, retryCount } =
    state;
  return { serviceUp, socketReady, peerPresent, hadSession, foreground, nextAttemptId, retryCount };
}

function ignore(state: ConnectionState): TransitionResult {
  return { state, effects: [] };
}

/** Same phase, patched context flags, no effects. */
function patch(state: ConnectionState, changes: Partial<ConnectionContext>): TransitionResult {
  return { state: { ...state, ...changes }, effects: [] };
}

/** Enters `starting`: kick the native service and arm its deadline. */
function beginStarting(ctx: ConnectionContext): TransitionResult {
  const attemptId = ctx.nextAttemptId;
  return {
    state: {
      ...ctx,
      phase: 'starting',
      attemptId,
      serviceUp: false,
      nextAttemptId: attemptId + 1,
    },
    effects: [
      { type: 'startService' },
      { type: 'armDeadline', attemptId, ms: STARTING_DEADLINE_MS },
    ],
  };
}

/** Enters `negotiating` with a fresh attempt id and an armed deadline. */
function beginNegotiation(ctx: ConnectionContext, mode: NegotiationMode): TransitionResult {
  const attemptId = ctx.nextAttemptId;
  return {
    state: {
      ...ctx,
      phase: 'negotiating',
      attemptId,
      mode,
      nextAttemptId: attemptId + 1,
    },
    effects: [
      { type: 'negotiate', attemptId, mode },
      { type: 'armDeadline', attemptId, ms: NEGOTIATING_DEADLINE_MS },
    ],
  };
}

/**
 * Enters `backoff` after a failure. Increments the consecutive-failure count,
 * schedules the retry while foregrounded, or enters paused when backgrounded
 * (the foreground snapshot reconcile takes over from there).
 */
function enterBackoff(
  ctx: ConnectionContext,
  reason: string,
  options?: { teardown?: boolean },
): TransitionResult {
  const attempt = ctx.retryCount + 1;
  const delayMs = backoffDelayMs(attempt);
  const pausedInBackground = !ctx.foreground;
  const effects: ConnectionEffect[] = [{ type: 'cancelTimers' }];
  if (options?.teardown) {
    effects.push({ type: 'teardown', preserveNativePeer: false });
  }
  if (!pausedInBackground) {
    effects.push({ type: 'scheduleRetry', delayMs });
  }
  return {
    state: {
      ...ctx,
      phase: 'backoff',
      attempt,
      delayMs,
      reason,
      pausedInBackground,
      retryCount: attempt,
    },
    effects,
  };
}

/**
 * Starts a fresh attempt, routing by the current gates: restart the service
 * if it is down, park in `waiting` while gated (socket down / peer known
 * absent), otherwise negotiate a fresh `connect`.
 */
function beginFreshAttempt(ctx: ConnectionContext): TransitionResult {
  if (!ctx.serviceUp) {
    return beginStarting(ctx);
  }
  if (!ctx.socketReady || ctx.peerPresent === false) {
    return { state: { ...ctx, phase: 'waiting' }, effects: [] };
  }
  return beginNegotiation(ctx, 'connect');
}

/** Prepends effects to a transition result. */
function withEffects(effects: ConnectionEffect[], result: TransitionResult): TransitionResult {
  return { state: result.state, effects: [...effects, ...result.effects] };
}

/**
 * Reconciles against the native truth after a resume (or manual query reply).
 * A surviving native peer is re-attached; anything else abandons stale
 * in-flight work and starts over immediately with the delay counter reset.
 */
function reconcileSnapshot(
  ctx: ConnectionContext,
  event: { alive: boolean; channelOpen: boolean },
  options?: { teardownStaleAttempt?: boolean },
): TransitionResult {
  const fresh: ConnectionContext = { ...ctx, retryCount: 0 };
  const effects: ConnectionEffect[] = [{ type: 'cancelTimers' }];
  if (event.alive && event.channelOpen) {
    if (options?.teardownStaleAttempt) {
      effects.push({ type: 'teardown', preserveNativePeer: true });
    }
    return withEffects(effects, beginNegotiation(fresh, 'attach'));
  }
  if (options?.teardownStaleAttempt) {
    effects.push({ type: 'teardown', preserveNativePeer: false });
  }
  return withEffects(effects, beginFreshAttempt(fresh));
}

function transitionStarting(
  state: Extract<ConnectionState, { phase: 'starting' }>,
  event: ConnectionEvent,
): TransitionResult {
  switch (event.type) {
    case 'SERVICE_READY': {
      const ctx = { ...contextOf(state), serviceUp: true };
      if (ctx.socketReady && ctx.peerPresent !== false) {
        return withEffects([{ type: 'cancelTimers' }], beginNegotiation(ctx, 'connect'));
      }
      return { state: { ...ctx, phase: 'waiting' }, effects: [{ type: 'cancelTimers' }] };
    }
    case 'DEADLINE':
      if (event.attemptId !== state.attemptId) return ignore(state);
      return enterBackoff(contextOf(state), 'service start timed out', { teardown: true });
    case 'SOCKET_UP':
      return patch(state, { socketReady: true });
    case 'SOCKET_DOWN':
      return patch(state, { socketReady: false });
    case 'PEER_PRESENT':
      return patch(state, { peerPresent: true });
    case 'PEER_ABSENT':
      return patch(state, { peerPresent: false });
    case 'APP_BACKGROUND':
      return patch(state, { foreground: false });
    case 'APP_FOREGROUND':
      return patch(state, { foreground: true });
    default:
      return ignore(state);
  }
}

function transitionWaiting(
  state: Extract<ConnectionState, { phase: 'waiting' }>,
  event: ConnectionEvent,
): TransitionResult {
  switch (event.type) {
    case 'SOCKET_UP': {
      const ctx = { ...contextOf(state), socketReady: true };
      if (ctx.peerPresent !== false) {
        return beginNegotiation(ctx, 'connect');
      }
      return { state: { ...ctx, phase: 'waiting' }, effects: [] };
    }
    case 'SOCKET_DOWN':
      return patch(state, { socketReady: false });
    case 'PEER_PRESENT': {
      const ctx = { ...contextOf(state), peerPresent: true };
      if (ctx.socketReady) {
        return beginNegotiation(ctx, 'connect');
      }
      return { state: { ...ctx, phase: 'waiting' }, effects: [] };
    }
    case 'PEER_ABSENT':
      return patch(state, { peerPresent: false });
    case 'SERVICE_READY':
      return patch(state, { serviceUp: true });
    case 'APP_BACKGROUND':
      return patch(state, { foreground: false });
    case 'APP_FOREGROUND':
      return patch(state, { foreground: true });
    case 'NATIVE_SNAPSHOT':
      // The native service still holds a live connection (it survived a
      // relaunch/background): attach to it instead of waiting out the gates —
      // a live open channel is itself proof both peers exist.
      if (event.alive && event.channelOpen) {
        return withEffects(
          [{ type: 'cancelTimers' }],
          beginNegotiation({ ...contextOf(state), retryCount: 0 }, 'attach'),
        );
      }
      return ignore(state);
    default:
      return ignore(state);
  }
}

function transitionNegotiating(
  state: Extract<ConnectionState, { phase: 'negotiating' }>,
  event: ConnectionEvent,
): TransitionResult {
  switch (event.type) {
    case 'ATTEMPT_OK': {
      if (event.attemptId !== state.attemptId) return ignore(state);
      const ctx = { ...contextOf(state), hadSession: true, retryCount: 0 };
      return { state: { ...ctx, phase: 'connected' }, effects: [{ type: 'cancelTimers' }] };
    }
    case 'ATTEMPT_FAILED': {
      if (event.attemptId !== state.attemptId) return ignore(state);
      if (event.terminal) {
        return {
          state: {
            ...contextOf(state),
            phase: 'failed',
            reason: event.reason,
            kind: event.terminal,
          },
          effects: [{ type: 'cancelTimers' }, { type: 'teardown', preserveNativePeer: false }],
        };
      }
      return enterBackoff(contextOf(state), event.reason, { teardown: true });
    }
    case 'DEADLINE':
      if (event.attemptId !== state.attemptId) return ignore(state);
      return enterBackoff(contextOf(state), 'negotiation deadline expired', { teardown: true });
    case 'SOCKET_DOWN':
      return enterBackoff({ ...contextOf(state), socketReady: false }, 'signaling socket lost', {
        teardown: true,
      });
    case 'PEER_ABSENT':
      return enterBackoff({ ...contextOf(state), peerPresent: false }, 'peer went offline', {
        teardown: true,
      });
    case 'SOCKET_UP':
      return patch(state, { socketReady: true });
    case 'PEER_PRESENT':
      return patch(state, { peerPresent: true });
    case 'SERVICE_READY':
      return patch(state, { serviceUp: true });
    case 'APP_BACKGROUND':
      return patch(state, { foreground: false });
    case 'APP_FOREGROUND':
      return {
        state: { ...state, foreground: true },
        effects: [{ type: 'queryNativeState' }],
      };
    case 'NATIVE_SNAPSHOT':
      // Abandon the (possibly wedged) in-flight attempt and follow the truth.
      return reconcileSnapshot(contextOf(state), event, { teardownStaleAttempt: true });
    default:
      return ignore(state);
  }
}

function transitionConnected(
  state: Extract<ConnectionState, { phase: 'connected' }>,
  event: ConnectionEvent,
): TransitionResult {
  switch (event.type) {
    case 'CONNECTION_LOST':
      return enterBackoff(contextOf(state), event.reason, { teardown: true });
    case 'SESSION_IDLE':
      // A genuinely quiet session is closed for good: auto-retrying would
      // churn connections nobody is using, so recovery is the manual
      // Reconnect bar (USER_RECONNECT).
      return {
        state: { ...contextOf(state), phase: 'failed', reason: 'Session idle', kind: 'idle' },
        effects: [{ type: 'cancelTimers' }, { type: 'teardown', preserveNativePeer: false }],
      };
    case 'PEER_ABSENT':
      return enterBackoff({ ...contextOf(state), peerPresent: false }, 'peer went offline', {
        teardown: true,
      });
    case 'SOCKET_UP':
      return patch(state, { socketReady: true });
    case 'SOCKET_DOWN':
      // The p2p link can outlive the signaling socket; stay connected and let
      // the liveness detectors (heartbeat/ICE) report a real loss.
      return patch(state, { socketReady: false });
    case 'PEER_PRESENT':
      return patch(state, { peerPresent: true });
    case 'SERVICE_READY':
      return patch(state, { serviceUp: true });
    case 'APP_BACKGROUND':
      return patch(state, { foreground: false });
    case 'APP_FOREGROUND':
      return {
        state: { ...state, foreground: true },
        effects: [{ type: 'queryNativeState' }],
      };
    case 'NATIVE_SNAPSHOT':
      if (event.alive && event.channelOpen) return ignore(state);
      // Snapshot says the native side died while we were suspended.
      return enterBackoff(contextOf(state), 'native connection dead after resume', {
        teardown: true,
      });
    default:
      return ignore(state);
  }
}

function transitionBackoff(
  state: Extract<ConnectionState, { phase: 'backoff' }>,
  event: ConnectionEvent,
): TransitionResult {
  switch (event.type) {
    case 'RETRY_DUE':
      if (state.pausedInBackground) return ignore(state);
      return beginFreshAttempt(contextOf(state));
    case 'APP_BACKGROUND':
      return {
        state: { ...state, foreground: false, pausedInBackground: true },
        effects: [{ type: 'cancelTimers' }],
      };
    case 'APP_FOREGROUND':
      return {
        state: { ...state, foreground: true },
        effects: [{ type: 'queryNativeState' }],
      };
    case 'NATIVE_SNAPSHOT':
      return reconcileSnapshot(contextOf(state), event);
    case 'USER_RECONNECT':
      return withEffects(
        [{ type: 'cancelTimers' }],
        beginFreshAttempt({ ...contextOf(state), retryCount: 0 }),
      );
    case 'SOCKET_UP':
      return patch(state, { socketReady: true });
    case 'SOCKET_DOWN':
      return patch(state, { socketReady: false });
    case 'PEER_PRESENT':
      return patch(state, { peerPresent: true });
    case 'PEER_ABSENT':
      return patch(state, { peerPresent: false });
    case 'SERVICE_READY':
      return patch(state, { serviceUp: true });
    default:
      return ignore(state);
  }
}

function transitionFailed(
  state: Extract<ConnectionState, { phase: 'failed' }>,
  event: ConnectionEvent,
): TransitionResult {
  switch (event.type) {
    case 'USER_RECONNECT':
      return beginFreshAttempt({ ...contextOf(state), retryCount: 0 });
    case 'SOCKET_UP':
      return patch(state, { socketReady: true });
    case 'SOCKET_DOWN':
      return patch(state, { socketReady: false });
    case 'PEER_PRESENT':
      return patch(state, { peerPresent: true });
    case 'PEER_ABSENT':
      return patch(state, { peerPresent: false });
    case 'APP_BACKGROUND':
      return patch(state, { foreground: false });
    case 'APP_FOREGROUND':
      return patch(state, { foreground: true });
    default:
      return ignore(state);
  }
}

/**
 * The reducer. Deterministic and side-effect free: interpreting the returned
 * effects (timers, native calls, teardown) is the caller's job.
 */
export function transition(state: ConnectionState, event: ConnectionEvent): TransitionResult {
  if (state.phase === 'stopped') {
    if (event.type === 'START') {
      return beginStarting(contextOf(state));
    }
    return ignore(state);
  }

  if (event.type === 'STOP') {
    return {
      state: {
        ...contextOf(state),
        phase: 'stopped',
        serviceUp: false,
        socketReady: false,
        peerPresent: null,
        hadSession: false,
        retryCount: 0,
      },
      effects: [{ type: 'cancelTimers' }, { type: 'teardown', preserveNativePeer: false }],
    };
  }

  if (event.type === 'SERVICE_FAILED') {
    return {
      state: {
        ...contextOf(state),
        phase: 'failed',
        reason: event.reason,
        kind: event.kind ?? 'service',
        serviceUp: false,
      },
      effects: [{ type: 'cancelTimers' }, { type: 'teardown', preserveNativePeer: false }],
    };
  }

  switch (state.phase) {
    case 'starting':
      return transitionStarting(state, event);
    case 'waiting':
      return transitionWaiting(state, event);
    case 'negotiating':
      return transitionNegotiating(state, event);
    case 'connected':
      return transitionConnected(state, event);
    case 'backoff':
      return transitionBackoff(state, event);
    case 'failed':
      return transitionFailed(state, event);
  }
}
