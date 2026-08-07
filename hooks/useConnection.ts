import { useProvider } from '@/hooks/useProvider';
import type {
  ConnectionNotice,
  HeartbeatMonitor,
  MonitoredPeerConnection,
  PresenceResult,
  ScopedConnectionNotice,
} from '@/lib/ac2';
import {
  addNativePresenceListener,
  addNativeSignalingStateListener,
  attachHeartbeatChannel,
  cancelNativeNegotiation,
  createAc2Client,
  createHeartbeatMonitor,
  createNativeAc2Transport,
  DEFAULT_THID,
  evaluateIdleSession,
  flushNativeQueue,
  generateThid,
  getNativeConnectionState,
  isPeerOffline,
  isPeerRejectedError,
  isPeerUnreachableError,
  isRegistrationBlockingNotice,
  isSnapshotChannelOpen,
  monitorPeerConnection,
  nativeAuthFetch,
  presenceFromSnapshot,
  selectConnectionNoticeForRequest,
  sendConversationClose,
  sendConversationOpen,
  setNativeActive,
  startNativeService,
  stopNativeService,
} from '@/lib/ac2';
import type {
  ConnectionEffect,
  ConnectionEvent,
  ConnectionState,
  NegotiationMode,
} from '@/lib/ac2/connectionMachine';
import {
  createInitialState,
  describeState,
  deriveUiState,
  transition,
} from '@/lib/ac2/connectionMachine';
import { createControlFrameHandler } from '@/lib/ac2/streamControlFrame';
import { findWalletAccount } from '@/lib/keystore/wallet-account';
import { authenticateLiquidAuth } from '@/lib/liquid-auth/flow';
import {
  addressMatchesKey,
  sessionAddressFromData,
  sessionAlreadyAuthenticatedForRequest,
} from '@/lib/liquid-auth/helpers';
import { ensureNotificationPermission } from '@/lib/notifications';
import { addAc2Message, clearAc2MessagesByThread } from '@/stores/ac2Messages';
import { accountsStore } from '@/stores/accounts';
import { keyStore } from '@/stores/keystore';
import { addMessage, clearMessagesByThread } from '@/stores/messages';
import {
  addSession,
  Session,
  sessionsStore,
  updateSessionActivity,
  updateSessionStatus,
} from '@/stores/sessions';
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import type { AC2BaseMessage as Ac2Message } from '@algorandfoundation/ac2-sdk/schema';
import { encodeAddress } from '@algorandfoundation/keystore';
import { useStore } from '@tanstack/react-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, type AppStateStatus } from 'react-native';

// Hard ceiling on any auth/session HTTP request during setup. React Native's
// `fetch` has NO default timeout, so a request issued while the network is
// still recovering from a drop (exactly when auto-reconnect fires) can stall
// forever. Bounding it turns a silent hang into a rejection that flows into the
// retry state machine instead.
const REQUEST_TIMEOUT_MS = 15000;
// How often to ping the peer over `ac2-heartbeat`, and how long without ANY
// inbound frame (pong or other traffic) before the peer is presumed dead even
// though ICE may still report `connected` (a silent stall). ~2 missed pongs.
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 45000;
// A heartbeat-channel send buffer above this suggests frames aren't draining to
// the peer (a stalling transport) — logged as an early diagnostic.
const HEARTBEAT_BUFFERED_WARN_BYTES = 256 * 1024;
// Idle-session policy. Liveness is owned by the ICE monitor + heartbeat
// watchdog (they detect a dead transport within seconds and auto-reconnect);
// this slower timer is a secondary safety net that (a) tears down a genuinely
// idle session and (b) recovers a connection that went stale while backgrounded
// (JS timers are suspended there, so the watchdog can't fire until foreground).
const IDLE_SESSION_TIMEOUT_MS = 60000;
const IDLE_CHECK_INTERVAL_MS = 5000;

interface UseConnectionResult {
  session: Session | undefined;
  address: string | null;
  /** Send a free-text chat message over the DataChannel. */
  send: (text: string) => void;
  /** Send an AC2 envelope; mirrored into `ac2MessagesStore` as `outbound`. */
  sendAc2: (message: Ac2Message) => void;
  /** Active `Ac2Client`; `null` until the `ac2-v1` channel is open. */
  ac2Client: Ac2Client | null;
  activeStreamText: string;
  /** Ephemeral agent presence from `ac2-stream` control frames. */
  agentPresence: 'thinking' | 'tool' | 'typing' | null;
  /** Optional detail for the current presence (e.g. tool name). */
  agentPresenceDetail: string | null;
  /**
   * Signaling-server peer presence for this `requestId` (how many devices are
   * connected). Populated from the socket's `presence` broadcasts; `null` until
   * the first update. Distinct from `agentPresence`, which is the agent's
   * ephemeral activity over the stream channel.
   */
  peerPresence: PresenceResult | null;
  /**
   * True when a (re)connect is parked because the peer isn't present in the
   * `requestId` room. The chat surface shows a clean inline notice ("check your
   * remote device") instead of a disruptive pop-up alert.
   */
  peerOffline: boolean;
  /**
   * True while the signaling socket itself is connected to the Liquid Auth
   * service. This is independent of the p2p chat transport: the socket is kept
   * alive across chat drops so presence checks and future renegotiation keep
   * working. When false the chat surface shows "Service unavailable".
   */
  isSocketConnected: boolean;
  error: Error | null;
  isError: boolean;
  isLoading: boolean;
  isConnected: boolean;
  /** True while automatic reconnect attempts (with backoff) are in flight. */
  isReconnecting: boolean;
  /**
   * Consecutive automatic reconnect attempt count (1-based); `0` when not
   * retrying. Retries are unlimited while foregrounded (exponential backoff),
   * so there is no fixed maximum any more.
   */
  reconnectAttempt: number;
  lastHeartbeat: number;
  reset: () => void;
  /** Tear down any stale transport and re-run the connection/auth flow. */
  reconnect: () => void;
  /** Active conversation `thid`; defaults to `'default'`. */
  activeThid: string;
  /** Open/switch to a thread; sends `ac2/ConversationOpen`. Returns the `thid`. */
  openConversation: (thid?: string, title?: string) => string;
  /** Close a thread; sends `ac2/ConversationClose`. */
  closeConversation: (thid: string) => void;
  /** Threads the agent advertised on connect (`conversations` control frame). */
  remoteThreads: { thid: string; title?: string; updatedAt?: number }[];
  /**
   * Out-of-band advisory the agent pushed (e.g. a warning that a *different*
   * wallet is connecting to an already-registered agent). `null` when none.
   */
  connectionNotice: ConnectionNotice | null;
  /** Dismiss the current `connectionNotice` banner. */
  dismissConnectionNotice: () => void;
  /**
   * Whether the wallet is registered with the agent for the current connection.
   * `false` once the agent pushes a registration-blocking notice (a foreign
   * wallet locked out, or no identity granted yet); the chat composer is
   * disabled while this is `false` so no new messages can be sent. Unlike the
   * dismissible `connectionNotice` banner, this is not cleared by dismissing it.
   */
  isRegistered: boolean;
}

interface UseConnectionOptions {
  /**
   * Allow creating a brand-new passkey via attestation when none exists for
   * the origin. Only the initial scan flow opts in; reconnects require an
   * existing passkey and otherwise surface an error.
   */
  allowPasskeyCreation?: boolean;
}

/**
 * Connection lifecycle owner. All control flow (connect, retry, backoff,
 * suspend/resume recovery, idle policy) is decided by the pure reducer in
 * `lib/ac2/connectionMachine`; this hook is its I/O shell:
 *
 * - **Event sources** feed the machine: native presence/signaling listeners
 *   (`PEER_PRESENT`/`PEER_ABSENT`, `SOCKET_UP`/`SOCKET_DOWN`), the AppState
 *   listener (`APP_FOREGROUND`/`APP_BACKGROUND`), the liveness detectors —
 *   heartbeat watchdog, ICE monitor, channel close, send failures — (all
 *   `CONNECTION_LOST`), the idle timer (`SESSION_IDLE`), and the user
 *   (`START`/`STOP`/`USER_RECONNECT`).
 * - **Effect handlers** interpret what the machine returns: `startService`
 *   (auth + native service bring-up), `negotiate` (p2p transport), timers
 *   (`armDeadline`/`scheduleRetry`/`cancelTimers`), `teardown`, and
 *   `queryNativeState` (snapshot reconcile after a resume).
 * - **UI flags** (`isConnected`/`isLoading`/`isReconnecting`/…) are derived
 *   from the machine state via `deriveUiState` — one place, no boolean soup.
 */
export function useConnection(
  origin: string,
  requestId: string,
  options: UseConnectionOptions = {},
): UseConnectionResult {
  const { accounts, keys, key, passkey } = useProvider();
  const allowPasskeyCreation = options.allowPasskeyCreation ?? false;

  // ---------------------------------------------------------------------
  // State machine core: current state lives in a ref (so event sources and
  // effect handlers read it synchronously); a state mirror re-renders the UI.
  // Events are processed through a queue so an effect that dispatches
  // synchronously (e.g. `queryNativeState` → `NATIVE_SNAPSHOT`) is handled
  // after the current transition's effects, never re-entrantly.
  // ---------------------------------------------------------------------
  const machineRef = useRef<ConnectionState>(
    createInitialState({ foreground: AppState.currentState === 'active' }),
  );
  const [machineState, setMachineState] = useState<ConnectionState>(machineRef.current);
  const runEffectRef = useRef<(effect: ConnectionEffect) => void>(() => {});
  const eventQueueRef = useRef<ConnectionEvent[]>([]);
  const dispatchingRef = useRef(false);

  const dispatch = useCallback((event: ConnectionEvent) => {
    eventQueueRef.current.push(event);
    if (dispatchingRef.current) return;
    dispatchingRef.current = true;
    try {
      let next: ConnectionEvent | undefined;
      while ((next = eventQueueRef.current.shift())) {
        const result = transition(machineRef.current, next);
        machineRef.current = result.state;
        console.log(`[ac2] machine: ${next.type} -> ${describeState(result.state)}`);
        setMachineState(result.state);
        for (const effect of result.effects) {
          runEffectRef.current(effect);
        }
      }
    } finally {
      dispatchingRef.current = false;
    }
  }, []);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // Machine-owned timers (armed/cancelled via effects).
  const deadlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Abort controller for the CURRENT negotiation attempt; `teardown` aborts it
  // so a superseded attempt's in-flight native work is cancelled.
  const negotiationAbortRef = useRef<AbortController | null>(null);
  // Abort controller for the current service bring-up (auth HTTP requests).
  const serviceAbortRef = useRef<AbortController | null>(null);

  const [address, setAddress] = useState<string | null>(null);
  const addressRef = useRef<string | null>(null);

  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now());
  const [error, setError] = useState<Error | null>(null);
  // Mirrors `userStoppedRef` for rendering (initial-loading derivation below).
  const [userStopped, setUserStopped] = useState(false);

  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamChannelRef = useRef<RTCDataChannel | null>(null);
  // Dedicated `ac2-heartbeat` liveness channel — out-of-band relative to `ac2-v1`.
  const heartbeatChannelRef = useRef<RTCDataChannel | null>(null);
  // The negotiated peer connection + the disposer for its connectivity monitor.
  // The SDK never watches ICE/connection state, so we attach our own once the
  // data channel opens and tear it down in `clearTransport`.
  const peerConnectionRef = useRef<MonitoredPeerConnection | null>(null);
  const peerMonitorDisposeRef = useRef<(() => void) | null>(null);
  // Heartbeat liveness watchdog (ping/pong over `ac2-heartbeat`). Started once
  // the channel opens, stopped in `clearTransport` / effect cleanup.
  const heartbeatMonitorRef = useRef<HeartbeatMonitor | null>(null);
  // True once the native foreground signaling service has been started (the
  // analog of the persistent `SignalClient` socket). Kept alive across p2p chat
  // drops; only `stopNativeService` (an explicit disconnect / unmount) clears it.
  const nativeStartedRef = useRef(false);
  // Detaches the CURRENT negotiation's native listeners (message/state/ICE).
  // Set once a negotiation's transport is established; cleared on teardown.
  const transportDisposeRef = useRef<(() => void) | null>(null);
  // Last time we observed inbound traffic from the peer (frames, envelopes,
  // heartbeat pongs) vs. the last local user action. Kept separate so an
  // outbound keepalive can never be mistaken for peer presence.
  const lastInboundActivityRef = useRef<number>(Date.now());
  const lastLocalActivityRef = useRef<number>(Date.now());
  // Monotonic counter of frames that ACTUALLY crossed the wire from the peer.
  // Deliberately narrower than `lastInboundActivityRef`, which optimistic
  // paths also refresh (e.g. the idle watchdog accepting a native snapshot as
  // proof of life): the resume liveness probe compares this counter before and
  // after its ping, and must only be satisfied by a real answer.
  const inboundSeqRef = useRef(0);
  // In-flight native peer cancel, published so the NEXT negotiation can await
  // it. The native `cancel()` is asynchronous, and starting a fresh offer
  // while the previous peer is still being torn down races the native service
  // (the new negotiation can be cancelled by the old teardown landing late).
  const nativeCancelRef = useRef<Promise<void> | null>(null);
  // In-flight native SERVICE stop (the hard recovery path / an explicit
  // disconnect), published so a service (re)start serializes behind it instead
  // of racing a socket that is still leaving the requestId room.
  const serviceStopRef = useRef<Promise<void> | null>(null);
  // Deadline for the resume liveness probe (see the `probeLiveness` effect).
  const livenessProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against two concurrent auth flows (and therefore two blocking
  // biometric prompts). The machine never emits two `startService` effects for
  // one attempt, but a slow prompt can outlive a `starting` deadline, so the
  // effect handler itself refuses to stack a second flow.
  const authFlowInProgressRef = useRef<boolean>(false);
  // Set when the user explicitly disconnects (`reset()`); blocks the
  // foreground auto-reconnect from resurrecting a session they chose to stop.
  const userStoppedRef = useRef(false);
  // Last observed `AppState`, so the foreground listener only reacts to a real
  // background/inactive -> active transition (not active -> active repeats).
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  // True once the app has been backgrounded/inactive and no inbound frame has
  // since proven the connection still alive. Lets the inactivity close tell a
  // stale-from-background drop (recoverable) apart from a genuine foreground
  // idle close (manual, so we don't churn/re-prompt).
  const wasBackgroundedRef = useRef(false);

  // Active conversation thread; the ref mirror lets DataChannel handlers see the live value.
  const [activeThid, setActiveThid] = useState<string>(DEFAULT_THID);
  const activeThidRef = useRef<string>(DEFAULT_THID);
  useEffect(() => {
    activeThidRef.current = activeThid;
  }, [activeThid]);

  const [activeStreamText, setActiveStreamText] = useState<string>('');
  // Ephemeral presence from agent stream-channel control frames.
  const [agentPresence, setAgentPresence] = useState<'thinking' | 'tool' | 'typing' | null>(null);
  const [agentPresenceDetail, setAgentPresenceDetail] = useState<string | null>(null);
  // Signaling-server peer presence for this requestId (how many devices are
  // connected). Subscribed on the persistent native service; each broadcast is
  // mapped to a `PEER_PRESENT`/`PEER_ABSENT` machine event.
  const [peerPresence, setPeerPresence] = useState<PresenceResult | null>(null);
  const peerPresenceRef = useRef<PresenceResult | null>(null);
  peerPresenceRef.current = peerPresence;
  // Whether the signaling socket itself is connected to the Liquid Auth
  // service. Owned by the persistent service subscriptions and kept alive
  // across p2p chat drops. Surfaced as "Service unavailable" in the chat UI
  // when false; mapped to `SOCKET_UP`/`SOCKET_DOWN` machine events.
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  // Disposer for the service-level `presence` subscription (lives with the
  // service, not the transport).
  const presenceUnsubRef = useRef<(() => void) | null>(null);
  // Disposer for the signaling-socket connectivity subscription (lives with
  // the service, not the transport), driving `isSocketConnected`.
  const signalingUnsubRef = useRef<(() => void) | null>(null);
  // Disposer for the transport-level presence listener. With the native path
  // presence is subscribed on the persistent service, so the per-negotiation
  // transport's presence disposer is a no-op; this ref is kept only for
  // symmetry with the service teardown path.
  const transportPresenceUnsubRef = useRef<(() => void) | null>(null);
  // Threads the agent advertised on connect (`conversations` control frame).
  const [remoteThreads, setRemoteThreads] = useState<
    { thid: string; title?: string; updatedAt?: number }[]
  >([]);
  // Out-of-band advisory the agent pushed (e.g. the locked/new-wallet warning),
  // surfaced as a banner in the chat screen. It is bound to the `requestId` it
  // was raised on: the chat surface is reused across connection switches (this
  // hook is not remounted per connection), so tagging the notice with its
  // connection is what keeps a banner from one wallet from bleeding onto
  // another. `null` when there is nothing to show for the current connection.
  const [connectionNoticeState, setConnectionNoticeState] = useState<ScopedConnectionNotice | null>(
    null,
  );
  // Only surface the notice for the connection it belongs to. Starting a new
  // connection (a new registration or a previously-paired wallet reconnecting)
  // has a different `requestId`, so the banner disappears automatically.
  const connectionNotice = selectConnectionNoticeForRequest(connectionNoticeState, requestId);
  const dismissConnectionNotice = useCallback(() => setConnectionNoticeState(null), []);
  // Whether the wallet is registered with the agent for the connection on
  // screen. Set to "not registered" (scoped to the `requestId`) when the agent
  // pushes a registration-blocking notice (a foreign wallet locked out, or no
  // identity granted yet). Kept SEPARATE from the dismissible banner so
  // dismissing the notice hides the banner but still blocks new messages. It is
  // reset at the start of each negotiation so a reconnect that succeeds in
  // registering re-enables the composer.
  const [notRegisteredState, setNotRegisteredState] = useState<{ requestId: string } | null>(null);
  const isRegistered = !(notRegisteredState && notRegisteredState.requestId === requestId);
  // Mirror `isRegistered` into a ref so the stable `send`/`sendAc2`/conversation
  // callbacks (which close over refs, not render state) can HARD-BLOCK every
  // outbound action while the connection is not properly paired. Disabling the
  // composer alone is only a UI gate — this ref makes the connection truly
  // inert so nothing can be sent over a connection that wasn't paired properly
  // (no identity granted, or a controller/identity mismatch that locked it out).
  const isRegisteredRef = useRef(true);
  isRegisteredRef.current = isRegistered;

  // AC2 SDK client; bound once the `ac2-v1` DataChannel opens.
  const [ac2Client, setAc2Client] = useState<Ac2Client | null>(null);
  const ac2ClientRef = useRef<Ac2Client | null>(null);

  // Current `requestId`, mirrored so stable callbacks and the effect
  // interpreter can match the background service's live connection without a
  // stale closure.
  const requestIdRef = useRef(requestId);
  requestIdRef.current = requestId;

  const session = useStore(sessionsStore, (state) =>
    state.sessions.find((s) => s.id === requestId && s.origin === origin),
  );

  // Close and null out every transport ref (AC2 client, data/stream/heartbeat
  // channels, monitors). Leaving stale refs set after a drop is what previously
  // wedged the old connection effect's guard and left the UI stuck on
  // "Connecting…" with no way to recover.
  const clearTransport = useCallback((options?: { preserveNativePeer?: boolean }) => {
    // Stop the liveness watchdog and detach the connectivity monitor before
    // anything closes the peer, so a deliberate teardown can't be misread as a
    // heartbeat timeout or an ICE failure.
    if (heartbeatMonitorRef.current) {
      heartbeatMonitorRef.current.stop();
      heartbeatMonitorRef.current = null;
    }
    if (peerMonitorDisposeRef.current) {
      peerMonitorDisposeRef.current();
      peerMonitorDisposeRef.current = null;
    }
    peerConnectionRef.current = null;
    if (ac2ClientRef.current) {
      try {
        ac2ClientRef.current.close();
      } catch {
        /* noop */
      }
      ac2ClientRef.current = null;
      setAc2Client(null);
    }
    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close();
      } catch {
        /* noop */
      }
      dataChannelRef.current = null;
    }
    if (streamChannelRef.current) {
      try {
        streamChannelRef.current.close();
      } catch {
        /* noop */
      }
      streamChannelRef.current = null;
    }
    if (heartbeatChannelRef.current) {
      try {
        heartbeatChannelRef.current.close();
      } catch {
        /* noop */
      }
      heartbeatChannelRef.current = null;
    }
    // Tear down ONLY the p2p peer, keeping the persistent native signaling
    // service (and its presence subscription) alive so the app stays connected
    // to the service after a chat drop — enabling presence checks and
    // renegotiation without a fresh auth/passkey. The service itself is owned
    // by `closeSocket`.
    //
    // Detach this negotiation's native listeners (message/state/ICE) so reusing
    // the service for the next attempt doesn't accumulate duplicate handlers.
    if (transportDisposeRef.current) {
      try {
        transportDisposeRef.current();
      } catch {
        /* noop */
      }
      transportDisposeRef.current = null;
    }
    // Ask the native service to cancel the (in-flight or established) peer
    // negotiation WITHOUT dropping the signaling socket, so the next attempt
    // reuses the same service. A leaked native peer would keep the ICE session
    // to the agent alive, so the agent would ignore the fresh offer a reconnect
    // sends. Best-effort; a fresh negotiation supersedes any lingering peer.
    //
    // EXCEPTION — hydration: when re-attaching to a connection the background
    // service kept alive across a relaunch/foreground (`preserveNativePeer`),
    // we must NOT cancel it. Cancelling here is exactly what closed the live
    // peer on relaunch and forced a full renegotiation instead of the cheap
    // `attach()` hydrate path in `createNativeAc2Transport`.
    //
    // The cancel is PUBLISHED (not fire-and-forget): the native call is
    // asynchronous, and a fresh negotiate that starts while the previous peer
    // is still being cancelled races it — the late cancel can kill the new
    // peer. `negotiate` awaits this promise before opening its transport, which
    // is how the two are serialized without making teardown itself async (the
    // effect interpreter is synchronous by design).
    if (nativeStartedRef.current && !options?.preserveNativePeer) {
      const cancelling = cancelNativeNegotiation().catch(() => {
        /* best-effort */
      });
      nativeCancelRef.current = cancelling;
      void cancelling.finally(() => {
        if (nativeCancelRef.current === cancelling) nativeCancelRef.current = null;
      });
    }
  }, []);

  // Fully tear down the persistent signaling service (and its presence
  // subscription). Only used on an explicit disconnect (`reset`) or when the
  // hook unmounts / the origin+requestId changes — NOT on a chat drop, so the
  // service survives p2p reconnects.
  const closeSocket = useCallback(() => {
    if (presenceUnsubRef.current) {
      try {
        presenceUnsubRef.current();
      } catch {
        /* noop */
      }
      presenceUnsubRef.current = null;
    }
    if (signalingUnsubRef.current) {
      try {
        signalingUnsubRef.current();
      } catch {
        /* noop */
      }
      signalingUnsubRef.current = null;
    }
    if (transportPresenceUnsubRef.current) {
      try {
        transportPresenceUnsubRef.current();
      } catch {
        /* noop */
      }
      transportPresenceUnsubRef.current = null;
    }
    setIsSocketConnected(false);
    if (nativeStartedRef.current) {
      nativeStartedRef.current = false;
      // Fully tears down the native foreground service: disconnects the
      // signaling socket and the WebRTC peer.
      //
      // Published (see `serviceStopRef`) because the hard recovery path starts
      // the service again straight afterwards: the whole point of that path is
      // that the agent observes presence 2→1→2, and it can only observe the
      // 2→1 if our socket has actually left the room before we rejoin it.
      const stopping = stopNativeService().catch(() => {
        /* best-effort teardown */
      });
      serviceStopRef.current = stopping;
      void stopping.finally(() => {
        if (serviceStopRef.current === stopping) serviceStopRef.current = null;
      });
    }
  }, []);

  // Best-effort, read-only diagnostic: log which ICE path the peer selected
  // (direct `host` / STUN `srflx` / TURN `relay`). Never logs addresses. Call
  // before teardown — it reads the peer synchronously and resolves async.
  const logCandidatePair = useCallback((_context: string) => {
    // The native background service owns the WebRTC peer, so per-session ICE
    // candidate-pair stats (`getStats`) are not available to JS. Kept as a
    // no-op so the established call sites stay in place, ready to re-enable if
    // the native module later surfaces peer stats.
  }, []);
  const logCandidatePairRef = useRef(logCandidatePair);
  logCandidatePairRef.current = logCandidatePair;

  const reset = useCallback(() => {
    userStoppedRef.current = true;
    setUserStopped(true);
    // `STOP` cancels the machine's timers and tears down the p2p transport.
    dispatchRef.current({ type: 'STOP' });
    // An explicit user disconnect also drops the persistent signaling service:
    // the user is leaving the session, so there is nothing to stay present for.
    closeSocket();
    setActiveStreamText('');
    setAgentPresence(null);
    setAgentPresenceDetail(null);
    setError(null);
    updateSessionStatus(requestId, origin, 'closed');
  }, [requestId, origin, closeSocket]);

  // Manually re-establish a dropped connection (user pressed "Reconnect").
  // From `stopped` this is a full restart (auth + service); from `backoff` /
  // `failed` the machine starts a fresh attempt with the delay counter reset.
  const reconnect = useCallback(() => {
    userStoppedRef.current = false;
    setUserStopped(false);
    setError(null);
    if (machineRef.current.phase === 'stopped') {
      dispatchRef.current({ type: 'START' });
      return;
    }
    dispatchRef.current({ type: 'USER_RECONNECT' });
    // `waiting` deliberately ignores USER_RECONNECT (retrying while gated on
    // the peer/socket is pointless), but the tap should still re-check the
    // native truth: if the background service actually holds a live
    // connection, the snapshot reconcile attaches to it.
    if (machineRef.current.phase === 'waiting') {
      runEffectRef.current({ type: 'queryNativeState' });
    }
  }, []);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  // Automatically resume a dropped connection when the app returns to the
  // foreground. Subscribed once per session (keyed on origin/requestId); all
  // decision state is read from refs/the machine so there is no stale-closure
  // risk. `APP_FOREGROUND` makes the machine pull the native truth (snapshot
  // reconcile), which either re-attaches to a surviving native peer or
  // abandons stale in-flight work and starts a fresh attempt — the fix for the
  // stuck-"Connecting…" bug on suspend → resume.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      // Remember that we left the foreground. Timers are suspended while
      // backgrounded, so a connection can silently go stale; this flag lets the
      // inactivity close distinguish that from a genuine foreground idle.
      if (nextState === 'background' || nextState === 'inactive') {
        wasBackgroundedRef.current = true;
        if (prevState === 'active') {
          dispatchRef.current({ type: 'APP_BACKGROUND' });
        }
      }

      // Keep the native background service's delivery gate in sync with our
      // foreground state. Going background flips it offline, so inbound
      // requests are buffered natively (and surfaced as notifications) instead
      // of dropped. The service itself keeps running regardless (it survives
      // app close).
      if (nativeStartedRef.current) {
        try {
          setNativeActive(nextState === 'active');
        } catch {
          /* native module may not implement setActive on every platform yet */
        }
        // Returning to the foreground with a live transport: its channel
        // handlers are still wired in this same runtime, so ask the service to
        // replay anything it buffered while we were backgrounded. `setActive`
        // itself deliberately does NOT replay — on a relaunch it fires before
        // the fresh listeners exist, and the replay would be swallowed by the
        // previous session's stale handlers. Without a live transport we leave
        // the queue buffered: the next negotiation replays it once fresh
        // handlers are wired.
        if (nextState === 'active' && machineRef.current.phase === 'connected') {
          try {
            flushNativeQueue();
          } catch {
            /* best-effort; the post-negotiation flush also covers this */
          }
        }
      }

      // Only react to a genuine (background|inactive) -> active transition.
      if (nextState !== 'active' || prevState === 'active') return;

      // Respect an explicit user disconnect; don't resurrect a stopped session.
      if (userStoppedRef.current) return;

      // Only resume sessions we still track (not forgotten by the user).
      const existingSession = sessionsStore.state.sessions.find(
        (s) => s.id === requestId && s.origin === origin,
      );
      if (!existingSession) return;

      dispatchRef.current({ type: 'APP_FOREGROUND' });

      // A terminal failure normally waits for the user, but foregrounding the
      // app IS a user action: resume recoverable failures (auth/service/
      // generic). Idle closes stay manual by design (no churn/re-prompt for a
      // session nobody is using), and "session full" can't be fixed by
      // retrying.
      const state = machineRef.current;
      if (
        state.phase === 'failed' &&
        (state.kind === 'auth' || state.kind === 'service' || state.kind === 'generic')
      ) {
        dispatchRef.current({ type: 'USER_RECONNECT' });
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [origin, requestId]);

  const send = useCallback(
    (text: string) => {
      // Hard-block: a connection that wasn't paired properly (no identity, or a
      // controller/identity mismatch that locked it out) is inert — never put a
      // message on the wire, regardless of any UI gate.
      if (!isRegisteredRef.current) {
        console.warn('Refusing to send message: connection is not registered.');
        return;
      }
      const channel = streamChannelRef.current || dataChannelRef.current;
      if (text.trim() && channel && channel.readyState === 'open' && address) {
        const thid = activeThidRef.current;
        try {
          // Tag the wire frame with the active `thid` so the agent routes it
          // without racing the separately-delivered `ac2/ConversationOpen`
          // control frame.
          channel.send(JSON.stringify({ thid, text: text.trim() }));
        } catch (err) {
          // A send can throw even on an "open" channel once the underlying peer
          // has died (a zombie transport). Route through the machine instead of
          // crashing, and don't echo a frame we never sent. The machine only
          // reacts while `connected`, so a stale/racing failure is a no-op.
          console.warn('Failed to send message; treating as a dropped connection', err);
          // A throw from an "open" channel is the zombie signature: the peer is
          // gone, so recover the hard way rather than re-offering into a room
          // the agent still believes is full.
          dispatchRef.current({
            type: 'CONNECTION_LOST',
            reason: 'send failed',
            confirmedDead: true,
          });
          return;
        }
        addMessage({
          text: text.trim(),
          sender: 'me',
          address,
          origin,
          requestId,
          thid,
        });
        updateSessionActivity(requestId, origin);
        lastLocalActivityRef.current = Date.now();
      }
    },
    [requestId, origin, address],
  );

  // Multi-conversation control plane — sends `ac2/Conversation{Open,Close}`
  // envelopes (see `lib/ac2/conversations.ts`) and tracks the active `thid`.
  const openConversation = useCallback(
    (thid?: string, title?: string): string => {
      // Hard-block: don't drive the conversation control-plane on a connection
      // that wasn't paired properly. Return the requested/active thid unchanged.
      if (!isRegisteredRef.current) {
        console.warn('Refusing to open conversation: connection is not registered.');
        return thid && thid.length > 0 ? thid : activeThidRef.current;
      }
      const nextThid = thid && thid.length > 0 ? thid : generateThid();
      sendConversationOpen(
        { getClient: () => ac2ClientRef.current, getAddress: () => address },
        nextThid,
        title,
      );
      setActiveThid(nextThid);
      activeThidRef.current = nextThid;
      updateSessionActivity(requestId, origin);
      lastLocalActivityRef.current = Date.now();
      return nextThid;
    },
    [origin, requestId, address],
  );

  const closeConversation = useCallback(
    (thid: string): void => {
      sendConversationClose(
        { getClient: () => ac2ClientRef.current, getAddress: () => address },
        thid,
      );
      clearMessagesByThread(origin, requestId, thid);
      clearAc2MessagesByThread(origin, requestId, thid);
      setRemoteThreads((prev) => prev.filter((t) => t.thid !== thid));
      if (activeThidRef.current === thid) {
        setActiveThid(DEFAULT_THID);
        activeThidRef.current = DEFAULT_THID;
      }
      lastLocalActivityRef.current = Date.now();
    },
    [address, origin, requestId],
  );

  const sendAc2 = useCallback(
    (message: Ac2Message) => {
      // Hard-block: an unregistered/locked connection must not emit protocol
      // envelopes either (e.g. approvals, conversation control). Throw so the
      // caller doesn't record the envelope as sent.
      if (!isRegisteredRef.current) {
        throw new Error('Connection is not registered; refusing to send AC2 envelope.');
      }
      const client = ac2ClientRef.current;
      if (!client) {
        throw new Error('AC2 client not ready (DataChannel not open)');
      }
      try {
        client.send(message);
      } catch (err) {
        // Surface the failure to the caller (so it won't record the envelope as
        // sent) AND route through the machine to reconnect the dead transport.
        console.warn('Failed to send AC2 envelope; treating as a dropped connection', err);
        dispatchRef.current({ type: 'CONNECTION_LOST', reason: 'send failed' });
        throw err;
      }
      addAc2Message({
        origin,
        requestId,
        address: address ?? '',
        direction: 'outbound',
        // Scope the protocol envelope to the active conversation thread.
        thid: activeThidRef.current,
        envelope: message,
      });
      updateSessionActivity(requestId, origin);
      lastLocalActivityRef.current = Date.now();
    },
    [origin, requestId, address],
  );

  // Idle-session watchdog. Any traffic keeps the session alive: measure from
  // the most recent of inbound peer traffic (frames/pongs) or local user
  // action. A dead transport is caught far sooner by the ICE monitor /
  // heartbeat watchdog; this only fires for a genuinely quiet session or one
  // that went stale while backgrounded.
  const isConnectedNow = machineState.phase === 'connected';
  useEffect(() => {
    if (!isConnectedNow) return;

    const inactivityInterval = setInterval(() => {
      // The verdict logic is extracted (and unit-tested) in
      // `lib/ac2/idleSession.ts`. The crucial case: after a LONG background the
      // clocks are hours old, and on resume this interval can fire BEFORE the
      // AppState listener's snapshot reconcile runs — so when the idleness is
      // explained by a background gap, the native truth is consulted before
      // tearing anything down (the background service keeps the peer alive
      // independently of JS).
      const verdict = evaluateIdleSession({
        now: Date.now(),
        lastInboundAt: lastInboundActivityRef.current,
        lastLocalAt: lastLocalActivityRef.current,
        idleTimeoutMs: IDLE_SESSION_TIMEOUT_MS,
        userStopped: userStoppedRef.current,
        wasBackgrounded: wasBackgroundedRef.current,
        isNativeChannelOpen: () => {
          const snapshot = getNativeConnectionState();
          return (
            !!snapshot.connected &&
            snapshot.requestId === requestId &&
            isSnapshotChannelOpen(snapshot)
          );
        },
      });
      if (verdict.action === 'none') return;
      if (verdict.action === 'refresh') {
        // Verified alive: the background gap explained the silence. Count the
        // native confirmation as fresh liveness evidence, exactly like an
        // inbound heartbeat, and keep the session.
        wasBackgroundedRef.current = false;
        lastInboundActivityRef.current = Date.now();
        heartbeatMonitorRef.current?.noteInbound();
        return;
      }
      console.log(
        verdict.action === 'close-stale'
          ? 'Closing stale connection after background; will reconnect'
          : 'Closing idle session (no activity)',
      );
      updateSessionStatus(requestId, origin, 'closed');
      if (verdict.action === 'close-stale') {
        wasBackgroundedRef.current = false;
        // Recoverable: the machine tears down and retries with backoff (or
        // pauses until foregrounded, where the snapshot reconcile takes over).
        // Flagged as confirmed dead: the transport stayed silent across the
        // whole idle window and the native side could not vouch for it either,
        // so recovery must drop signaling rather than only cancel the peer.
        dispatchRef.current({
          type: 'CONNECTION_LOST',
          reason: 'stale after background',
          confirmedDead: true,
        });
      } else {
        // Terminal until the user acts (the manual Reconnect bar).
        dispatchRef.current({ type: 'SESSION_IDLE' });
      }
    }, IDLE_CHECK_INTERVAL_MS);

    return () => clearInterval(inactivityInterval);
  }, [isConnectedNow, origin, requestId]);

  // ---------------------------------------------------------------------
  // Effect handler: `startService` — Liquid Auth + native service bring-up.
  // Runs the auth flow (reusing an existing session when possible), starts the
  // persistent native foreground service, and installs the service-lifetime
  // subscriptions (presence, signaling connectivity). Reports back to the
  // machine with SERVICE_READY / SERVICE_FAILED.
  // ---------------------------------------------------------------------
  const startService = useCallback(async () => {
    if (!origin || !requestId) {
      console.error('Missing origin or requestId');
      dispatchRef.current({ type: 'SERVICE_FAILED', reason: 'Missing origin or requestId' });
      return;
    }

    if (authFlowInProgressRef.current) {
      console.log('Auth flow already in progress, skipping duplicate service start');
      return;
    }

    // Aborts every in-flight setup request when this run is superseded or the
    // session stops, so a stalled request from an obsolete attempt can't
    // linger and race a fresh one.
    const runAbort = new AbortController();
    serviceAbortRef.current?.abort();
    serviceAbortRef.current = runAbort;
    const active = () => !runAbort.signal.aborted;

    // Liquid Auth HTTP with a per-request timeout, also wired to this run's
    // abort signal. A timeout or supersession rejects the request so the outer
    // catch can hand off to the machine instead of hanging.
    //
    // Requests are routed through the native background service's shared
    // cookie-jar client (`nativeAuthFetch`) rather than JS `fetch`, so the
    // `connect.sid` session cookie set by the FIDO ceremony is captured
    // natively and authenticates the signaling socket (D9). The native call has
    // no abort signal of its own, so the timeout/supersession is enforced here
    // by racing it against an abort rejection; the abandoned native request's
    // result is simply ignored.
    const fetchWithTimeout = (
      input: string,
      init: RequestInit = {},
      timeoutMs: number = REQUEST_TIMEOUT_MS,
    ): Promise<Response> => {
      const controller = new AbortController();
      const onRunAbort = () => controller.abort();
      if (runAbort.signal.aborted) controller.abort();
      else runAbort.signal.addEventListener('abort', onRunAbort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        };
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener('abort', fail);
      });
      return Promise.race([nativeAuthFetch(input, init), aborted]).finally(() => {
        clearTimeout(timer);
        runAbort.signal.removeEventListener('abort', onRunAbort);
      });
    };

    authFlowInProgressRef.current = true;

    // Coarse phase timing so a hang is attributable to auth vs. service start.
    const setupStartedAt = Date.now();

    try {
      // A hard recovery reset (or an explicit disconnect) may still be tearing
      // the native service down. Wait it out before touching the native side
      // again: the service is idempotent, but restarting it while the socket is
      // mid-disconnect can rejoin the requestId room before the server ever
      // broadcast our departure — and the agent needs to SEE presence drop to
      // 1 before it re-arms its offer listener, which is the entire reason the
      // hard path dropped the socket.
      if (serviceStopRef.current) {
        await serviceStopRef.current;
        if (!active()) return;
      }

      const currentSessions = sessionsStore.state.sessions;
      const currentKeys = keyStore.state.keys;
      const currentAccounts = accountsStore.state.accounts;

      const existingSession = currentSessions.find(
        (s) => s.id === requestId && s.origin === origin,
      );
      if (!existingSession) {
        // Persist the connection durably (no TTL) so it survives app
        // restarts and can be reconnected/renegotiated later using the same
        // requestId — mirroring how the OpenClaw plugin persists connections.
        addSession({ id: requestId, origin, status: 'active' });
      } else if (existingSession.status !== 'active') {
        updateSessionStatus(requestId, origin, 'active');
      }

      const walletAccount = findWalletAccount(currentAccounts, currentKeys);
      const foundKey = walletAccount?.key;

      if (!foundKey || !foundKey.publicKey) {
        console.error(
          'No key found for attestation. Keys:',
          JSON.stringify(
            currentKeys.map((k) => ({ id: k.id, type: k.type })),
            null,
            2,
          ),
        );
        console.error(
          'Accounts:',
          JSON.stringify(
            currentAccounts.map((a) => ({ address: a.address, keyId: a.metadata?.keyId })),
            null,
            2,
          ),
        );
        throw new Error('No key found for attestation');
      }

      const walletAddress = encodeAddress(foundKey.publicKey);
      console.log('Found key for attestation:', foundKey.id, foundKey.type);

      const sessionCheck = await fetchWithTimeout(`${origin}/auth/session`);
      if (!active()) return;
      let initialSessionData: any = null;
      let initialSessionAddress: string | null = null;
      console.log('Initial session status:', sessionCheck.ok);

      if (sessionCheck.ok) {
        try {
          const sessionData = await sessionCheck.json();
          initialSessionData = sessionData;
          if (!active()) return;
          initialSessionAddress = sessionAddressFromData(sessionData);
          if (initialSessionAddress && addressMatchesKey(initialSessionAddress, foundKey)) {
            setAddress(initialSessionAddress);
            addressRef.current = initialSessionAddress;
          } else if (initialSessionAddress) {
            console.warn('Ignoring session address that does not match the active wallet key');
          }
        } catch (error) {
          console.warn('Unable to parse existing auth session response:', error);
        }
      }

      // Reuse an existing valid session for this requestId instead of
      // re-prompting for the passkey on every reconnect. When the session
      // already authenticates this wallet for this exact requestId, the
      // signaling socket is authenticated by cookie and the server
      // re-announces presence for the requestId on the socket's reconnect —
      // which resolves the waiting peer's `link` — so both parties can
      // renegotiate over the socket without a fresh FIDO2 assertion.
      if (sessionAlreadyAuthenticatedForRequest(initialSessionData, foundKey, requestId)) {
        console.log(
          '[ac2] Reusing existing Liquid Auth session for this requestId; skipping passkey assertion',
        );
        if (initialSessionAddress) {
          setAddress(initialSessionAddress);
          addressRef.current = initialSessionAddress;
        }
      } else {
        const authResult = await authenticateLiquidAuth({
          origin,
          requestId,
          foundKey,
          walletAddress,
          currentKeys,
          initialSessionData,
          initialSessionAddress,
          existingSessionPasskeyCredentialId: existingSession?.passkeyCredentialId,
          allowPasskeyCreation,
          key,
          passkey,
          setAddress,
          addressRef,
          authFlowInProgressRef,
          fetchWithTimeout,
          isActive: () => active(),
        });
        if (authResult.superseded || !active()) return;
      }
      console.log(`[ac2] auth phase done in ${Date.now() - setupStartedAt}ms`);

      // Final validation of the session before connecting
      const finalSessionCheck = await fetchWithTimeout(`${origin}/auth/session`);

      if (!active()) return;

      if (finalSessionCheck.ok) {
        const sessionData = await finalSessionCheck.json();

        if (!active()) return;

        const sessionAddress = sessionAddressFromData(sessionData);
        if (sessionAddress && addressMatchesKey(sessionAddress, foundKey)) {
          setAddress(sessionAddress);
          addressRef.current = sessionAddress;
        } else if (sessionAddress) {
          console.warn('Ignoring final session address that does not match the active wallet key');
        }
      } else {
        console.log('Session validation failed (ignored for debugging)');
      }

      // Ensure the runtime notification permission (Android 13+ / iOS) BEFORE
      // starting the foreground service, so its ongoing "connected" banner and
      // the per-message notifications can actually be shown. Non-fatal: if the
      // user denies it the service still runs, just silently.
      await ensureNotificationPermission();
      if (!active()) return;

      // Start (or reuse) the native foreground signaling service. It owns the
      // signaling socket + WebRTC peer inside a background service, so the
      // connection no longer goes stale when the app is backgrounded. The auth
      // phase above has already established the Liquid Auth session
      // server-side; the native service connects using it. Idempotent on the
      // native side, so a reused service is fine.
      await startNativeService(origin);
      if (!active()) return;
      nativeStartedRef.current = true;

      // Sync the service's delivery gate with the real foreground state. Note
      // this does NOT replay any messages the service buffered while the app
      // was closed — at this point the fresh runtime hasn't wired its channel
      // handlers yet, and (because the JS VM can survive a relaunch) the
      // previous session's stale handlers may still be attached and would
      // swallow the replay. The buffered messages are replayed once a
      // negotiation/attach completes and the fresh handlers are wired.
      try {
        setNativeActive(AppState.currentState === 'active');
      } catch {
        /* native module may not implement setActive on every platform yet */
      }

      // Presence lives with the persistent service (outside a single p2p
      // negotiation) so it keeps working across chat drops and drives the
      // machine's presence gate: peers must both be present in the requestId
      // room before negotiating. The native service forwards the server's
      // `presence` broadcasts (and re-broadcasts on its own socket reconnect).
      // NOTE: there is no active presence *query* — but the broadcast fired at
      // room join lands during the native start above, BEFORE this listener is
      // attached, so the first gate decision is seeded from the service's
      // cached copy of it (the snapshot read below) rather than waiting for a
      // broadcast that may never repeat.
      const presenceSub = addNativePresenceListener((e) => {
        const presence: PresenceResult = {
          requestId: e.requestId,
          deviceCount: e.deviceCount,
          online: e.online,
        };
        console.log(
          `[ac2] presence for ${presence.requestId}: ${presence.deviceCount} device(s), online=${presence.online}`,
        );
        setPeerPresence(presence);
        peerPresenceRef.current = presence;
        // A presence broadcast only reaches us while the signaling server is
        // up and delivering, so when it is connected the server's view of who
        // is in the requestId room is authoritative — more accurate than
        // inferring liveness from the p2p data channel. The machine trusts it:
        // a `PEER_ABSENT` while connected/negotiating tears the p2p transport
        // down (a stale data channel to a departed peer is worse than
        // reconnecting when they return); a `PEER_PRESENT` while waiting
        // (re)starts negotiation. A signaling-server outage produces NO
        // broadcast (the socket is gone), so a live p2p connection deliberately
        // outlives it.
        dispatchRef.current({ type: isPeerOffline(presence) ? 'PEER_ABSENT' : 'PEER_PRESENT' });
      });
      presenceUnsubRef.current = () => presenceSub.remove();

      // Track the signaling socket's REAL connectivity so the chat surface can
      // show "Service unavailable" while the signaling server is unreachable.
      // Crucially, a signaling drop must NOT tear down the p2p transport — the
      // data channels deliberately outlive signaling disruptions (the machine
      // stays `connected` on SOCKET_DOWN) — it only gates (re)negotiation and
      // the UI state. When the socket (re)connects, the server rejoins us to
      // the requestId room and rebroadcasts presence; `SOCKET_UP` also resumes
      // a waiting reconnect promptly in case a broadcast was missed.
      const signalingSub = addNativeSignalingStateListener((e) => {
        const connected = e.state === 'connected';
        console.log(`[ac2] signaling socket ${e.state}`);
        setIsSocketConnected(connected);
        dispatchRef.current({ type: connected ? 'SOCKET_UP' : 'SOCKET_DOWN' });
      });
      signalingUnsubRef.current = () => signalingSub.remove();

      // Seed the signaling + presence gates from the service snapshot (the
      // events above keep them fresh from here on). An older native binary
      // that doesn't report `signalingConnected` (undefined) is treated as
      // connected, matching the previous always-optimistic behavior.
      let signalingConnected = true;
      let seededPresence: PresenceResult | null = null;
      try {
        const snapshot = getNativeConnectionState();
        signalingConnected = snapshot.signalingConnected !== false;
        seededPresence = presenceFromSnapshot(snapshot, requestId);
      } catch {
        /* native module unavailable (tests / web) — stay optimistic */
      }
      setIsSocketConnected(signalingConnected);
      console.log(
        `[ac2] service ready in ${Date.now() - setupStartedAt}ms (signaling ${
          signalingConnected ? 'connected' : 'connecting…'
        })`,
      );

      // The room-join `presence` broadcast fires while the native service is
      // starting — before the listener above is attached — and the server then
      // stays silent until a device joins or leaves. At a launch against an
      // offline peer that one broadcast is the ONLY presence signal, so
      // without this seed the machine's gate stays "unknown", it negotiates
      // into a peer that is not there, and the peer-offline notice never
      // shows. Seeding PEER_ABSENT before SERVICE_READY parks the machine in
      // `waiting` instead — the presence listener resumes it the moment the
      // peer actually comes online.
      if (seededPresence) {
        console.log(
          `[ac2] presence (seeded from native snapshot) for ${seededPresence.requestId}: ${seededPresence.deviceCount} device(s), online=${seededPresence.online}`,
        );
        setPeerPresence(seededPresence);
        peerPresenceRef.current = seededPresence;
        dispatchRef.current({
          type: isPeerOffline(seededPresence) ? 'PEER_ABSENT' : 'PEER_PRESENT',
        });
      }

      dispatchRef.current({ type: signalingConnected ? 'SOCKET_UP' : 'SOCKET_DOWN' });
      dispatchRef.current({ type: 'SERVICE_READY' });

      // Cold-relaunch hydration: if the machine parked in `waiting` (gates not
      // known open yet) but the background service ALREADY holds a live
      // connection for this `requestId` (it survived app close/backgrounding),
      // feed it a snapshot so it attaches immediately. A live open channel is
      // itself proof both peers exist, and on a cold relaunch presence can't
      // even reach us until attach() rebinds the listener — waiting for a
      // broadcast here would deadlock the hydration.
      if (machineRef.current.phase === 'waiting') {
        runEffectRef.current({ type: 'queryNativeState' });
      }
    } catch (err: any) {
      // A superseded run (teardown fired, or a request was aborted) must do
      // nothing: a newer run owns recovery.
      if (!active() || err?.name === 'AbortError') return;
      console.error('Failed to establish the signaling service:', err);
      updateSessionStatus(requestId, origin, 'failed');
      setIsSocketConnected(false);
      // Surface the auth/network failure. Peer-presence gating (the peer
      // simply not being online) is handled by the machine's presence gate.
      setError(err);
      dispatchRef.current({
        type: 'SERVICE_FAILED',
        reason: err?.message || 'Failed to establish the signaling service',
        kind: 'auth',
      });
    } finally {
      // Only release the auth lock if this run is still the active one.
      if (active()) authFlowInProgressRef.current = false;
    }
  }, [origin, requestId, allowPasskeyCreation, key, passkey]);
  const startServiceRef = useRef(startService);
  startServiceRef.current = startService;

  // Put one keepalive `ping` on the wire, preferring the dedicated
  // `ac2-heartbeat` channel and falling back to `ac2-v1` (which has no pong
  // contract — see the monitor's `timeoutMs`). Returns false when there is no
  // open channel to send on; throws whatever the channel throws, so callers can
  // treat a failed send as a dead transport. Shared by the heartbeat watchdog
  // and the resume liveness probe so both speak the same wire language.
  const sendKeepalivePing = useCallback((): boolean => {
    const hb = heartbeatChannelRef.current;
    const dc = dataChannelRef.current;
    const channel =
      hb && hb.readyState === 'open' ? hb : dc && dc.readyState === 'open' ? dc : null;
    if (!channel) return false;
    // A growing send buffer means frames aren't draining to the peer — an early
    // signal the transport is stalling before ICE even flips state.
    if (channel.bufferedAmount > HEARTBEAT_BUFFERED_WARN_BYTES) {
      console.warn(
        `Heartbeat send buffer high (${channel.bufferedAmount} bytes) — transport may be stalling`,
      );
    }
    channel.send(channel === hb ? 'ping' : '');
    return true;
  }, []);
  const sendKeepalivePingRef = useRef(sendKeepalivePing);
  sendKeepalivePingRef.current = sendKeepalivePing;

  // ---------------------------------------------------------------------
  // Effect handler: `negotiate` — one p2p transport attempt over the
  // PERSISTENT native service. Each attempt carries the machine's `attemptId`;
  // its result events are stamped with it so a superseded/abandoned attempt
  // can never corrupt newer state. Reuses the started native service and NEVER
  // stops it — only the peer/data-channels are torn down between chats.
  // ---------------------------------------------------------------------
  const negotiate = useCallback(
    async (attemptId: number, mode: NegotiationMode) => {
      if (!nativeStartedRef.current) {
        // Shouldn't happen (the machine only negotiates after SERVICE_READY),
        // but fail the attempt cleanly rather than crash if it ever does.
        dispatchRef.current({
          type: 'ATTEMPT_FAILED',
          attemptId,
          reason: 'native service not started',
        });
        return;
      }

      const runAbort = new AbortController();
      negotiationAbortRef.current?.abort();
      negotiationAbortRef.current = runAbort;
      // This attempt stays "current" until the machine's next teardown (which
      // aborts/replaces the controller) — including while `connected`, so the
      // liveness detectors wired below stay live and a stale run's late
      // callbacks are no-ops.
      const isCurrent = () => negotiationAbortRef.current === runAbort && !runAbort.signal.aborted;

      // Serialize behind the teardown's native peer cancel. `cancel()` is
      // asynchronous native work, so opening a fresh transport on top of an
      // unfinished cancel lets the old teardown land on the NEW peer — which
      // reads as yet another unanswered offer and feeds the reconnect loop.
      if (nativeCancelRef.current) {
        await nativeCancelRef.current;
        if (!isCurrent()) return;
      }

      const setupStartedAt = Date.now();
      console.log(`[ac2] negotiate: opening p2p transport (attempt=${attemptId}, mode=${mode})`);
      setError(null);
      // Clear any prior "not registered" state so a reconnect that succeeds in
      // registering re-enables the composer. If the agent is still unregistered
      // it re-pushes the blocking notice on connect, which re-sets the flag.
      setNotRegisteredState(null);
      // Reset both liveness clocks so the fresh attempt isn't judged idle.
      lastInboundActivityRef.current = Date.now();
      lastLocalActivityRef.current = Date.now();

      try {
        // Apply one STX-prefixed control frame from the agent's stream channel.
        // See `lib/ac2/streamControlFrame.ts` / `lib/ac2/stream.ts` for the frame
        // shapes. Returns true when `raw` was a control frame (recognized or
        // malformed) — never render as chat.
        const applyControlFrame = createControlFrameHandler({
          origin,
          requestId,
          addressRef,
          activeThidRef,
          lastInboundActivityRef,
          setAgentPresence,
          setAgentPresenceDetail,
          setActiveStreamText,
          setLastHeartbeat,
          setRemoteThreads,
          // Tag every pushed notice with the connection it was raised on so the
          // banner is scoped to this `requestId` and can't leak onto another
          // connection the user later switches to.
          setConnectionNotice: (notice) => {
            setConnectionNoticeState(notice ? { notice, requestId } : null);
            // A registration-blocking notice (foreign wallet locked out, or no
            // identity granted yet) means the wallet is not registered: flag it
            // scoped to this connection so the composer stays disabled even if
            // the user dismisses the banner.
            if (notice && isRegistrationBlockingNotice(notice.code)) {
              setNotRegisteredState({ requestId });
            }
          },
        });

        // Presence is subscribed on the persistent native service (see
        // `startService`), so it is intentionally NOT re-subscribed per
        // negotiation. `createNativeAc2Transport` drives the native background
        // service (`start` -> `connect('answer', …)` -> wait for `ac2-v1` open)
        // and routes native events into `RTCDataChannel`-shaped shims. In
        // `attach` mode the preceding machine teardown preserved the live
        // native peer, so the transport takes its `attach()` (no-renegotiate)
        // hydrate path.
        const transport = await createNativeAc2Transport({
          url: origin,
          requestId,
          // The machine's intent is authoritative: in `connect` mode the
          // transport must NOT silently hydrate off whatever peer the service
          // still reports — that peer is precisely the zombie we are recovering
          // from.
          mode,
          signal: runAbort.signal,
          onPeerConnection: (pc) => {
            // Stash the peer connection; the connectivity monitor is attached
            // once the channel is actually live (establishment-phase failures
            // are already covered by the transport's open deadline).
            peerConnectionRef.current = pc as unknown as MonitoredPeerConnection;
          },
          onSideChannel: (channel) => {
            console.log(`[ac2] Discovered channel: ${channel.label}`);
            if (channel.label === 'ac2-heartbeat') {
              heartbeatChannelRef.current = attachHeartbeatChannel(
                channel as unknown as RTCDataChannel,
                {
                  onInbound: () => {
                    if (!isCurrent()) return;
                    inboundSeqRef.current += 1;
                    wasBackgroundedRef.current = false;
                    lastInboundActivityRef.current = Date.now();
                    heartbeatMonitorRef.current?.noteInbound();
                    setLastHeartbeat(Date.now());
                  },
                },
              );
              return;
            }
            if (channel.label === 'ac2-stream') {
              streamChannelRef.current = channel as unknown as RTCDataChannel;
              channel.onmessage = (event) => {
                if (!isCurrent()) return;
                // Any inbound stream frame is proof of peer liveness.
                inboundSeqRef.current += 1;
                heartbeatMonitorRef.current?.noteInbound();
                if (typeof event.data === 'string') applyControlFrame(event.data);
              };
              channel.onopen = () => console.log('Stream channel opened');
              channel.onclose = () => console.log('Stream channel closed');
            }
          },
        });
        const { datachannel } = transport;

        // Track this negotiation's listener disposer so `clearTransport` can
        // detach the native message/state/ICE listeners. Replace any prior
        // disposer first so a superseded run cannot leak one.
        if (transportDisposeRef.current) {
          try {
            transportDisposeRef.current();
          } catch {
            /* noop */
          }
        }
        transportDisposeRef.current = transport.dispose;
        // The native presence listener is persistent (service-lifetime); the
        // transport's own presence disposer is a no-op here, tracked only for
        // symmetry with the service teardown path.
        transportPresenceUnsubRef.current = transport.disposePresence;

        if (!isCurrent()) {
          // This run was superseded while negotiation was still winding down.
          // Avoid hard-closing the native peer here: Android's WebRTC bridge may
          // still be asynchronously applying the remote description, and tearing
          // the peer down races that work and can crash with a null
          // `PeerConnectionObserver`. NEVER touch the persistent service here.
          return;
        }

        dataChannelRef.current = datachannel as unknown as RTCDataChannel;
        console.log(`[ac2] transport negotiated in ${Date.now() - setupStartedAt}ms`);

        // Wallet-side responders (`onSigningRequest` / `onKeyRequest`) are
        // intentionally NOT installed: inbound envelopes are mirrored into
        // `ac2MessagesStore` by `createAc2Client` and `app/chat.tsx` handles
        // approve/reject interactively against the visible store entry.
        const { client: ac2 } = createAc2Client({
          datachannel: datachannel as unknown as RTCDataChannel,
          origin,
          requestId,
          getAddress: () => addressRef.current,
          getActiveThid: () => activeThidRef.current,
          onInboundEnvelope: () => {
            console.log('[ac2] client received inbound AC2 envelope on ac2-v1');
            updateSessionActivity(requestId, origin);
            inboundSeqRef.current += 1;
            wasBackgroundedRef.current = false;
            lastInboundActivityRef.current = Date.now();
            heartbeatMonitorRef.current?.noteInbound();
            setLastHeartbeat(Date.now());
          },
          onRawMessage: (raw: string) => {
            console.log(`[ac2] client received raw message on ac2-v1 (len=${raw.length})`);
            if (applyControlFrame(raw)) return;
            if (!raw.trim() || !addressRef.current) return;
            addMessage({
              text: raw.trim(),
              sender: 'peer',
              address: addressRef.current,
              origin,
              requestId,
              thid: activeThidRef.current,
            });
            updateSessionActivity(requestId, origin);
            inboundSeqRef.current += 1;
            wasBackgroundedRef.current = false;
            lastInboundActivityRef.current = Date.now();
            heartbeatMonitorRef.current?.noteInbound();
            setLastHeartbeat(Date.now());
          },
          onOpen: () => {
            console.log(`Data channel opened in ${Date.now() - setupStartedAt}ms`);
            if (!isCurrent()) return;
            wasBackgroundedRef.current = false;
            // Log the negotiated ICE path (direct/STUN/TURN) for this session.
            logCandidatePairRef.current('connected');
            // Watch the peer for connectivity loss (ICE disconnected/failed)
            // the SDK never surfaces — the DataChannel can stay "open" while
            // the underlying transport is dead. Route a failure through the
            // machine; it only reacts while `connected`, so a late callback
            // from a superseded run is a no-op.
            if (peerMonitorDisposeRef.current) peerMonitorDisposeRef.current();
            peerMonitorDisposeRef.current = peerConnectionRef.current
              ? monitorPeerConnection(peerConnectionRef.current, {
                  onFailed: (reason) => {
                    if (!isCurrent()) return;
                    // ICE failed/closed is the transport telling us it is dead;
                    // no soft peer-only retry can bring it back.
                    dispatchRef.current({
                      type: 'CONNECTION_LOST',
                      reason: `ice ${reason}`,
                      confirmedDead: true,
                    });
                  },
                })
              : null;
            // Start the liveness watchdog. It pings on `ac2-heartbeat` and
            // fails if the peer stops responding (a silent stall) even while
            // ICE still reads "connected". Over the `ac2-v1` fallback there is
            // no pong contract, so run keepalives without a timeout.
            if (heartbeatMonitorRef.current) heartbeatMonitorRef.current.stop();
            heartbeatMonitorRef.current = createHeartbeatMonitor({
              intervalMs: HEARTBEAT_INTERVAL_MS,
              timeoutMs: heartbeatChannelRef.current ? HEARTBEAT_TIMEOUT_MS : Infinity,
              send: () => {
                try {
                  sendKeepalivePingRef.current();
                } catch (err) {
                  console.warn('Heartbeat send failed; treating as a dropped connection', err);
                  if (isCurrent()) {
                    dispatchRef.current({
                      type: 'CONNECTION_LOST',
                      reason: 'heartbeat send failed',
                      confirmedDead: true,
                    });
                  }
                }
              },
              onTimeout: () => {
                if (isCurrent()) {
                  // The peer went silent for two full heartbeat windows: the
                  // transport is proven dead, so recovery drops signaling too.
                  dispatchRef.current({
                    type: 'CONNECTION_LOST',
                    reason: 'heartbeat timeout',
                    confirmedDead: true,
                  });
                }
              },
            });
            heartbeatMonitorRef.current.start();
            setAc2Client(ac2);
            updateSessionStatus(requestId, origin, 'active');
            dispatchRef.current({ type: 'ATTEMPT_OK', attemptId });
          },
          onClose: () => {
            console.log('Data channel closed');
            // A deliberate teardown already aborted/replaced this attempt's
            // controller, so `isCurrent()` is false and the close is expected.
            // Everything else funnels into the machine's single recovery path.
            if (!isCurrent()) return;
            updateSessionStatus(requestId, origin, 'closed');
            dispatchRef.current({ type: 'CONNECTION_LOST', reason: 'data channel closed' });
          },
        });
        ac2ClientRef.current = ac2;

        // Every channel consumer is wired now (the SDK client on `ac2-v1`, the
        // stream/heartbeat handlers via `onSideChannel`), so ask the native
        // service to replay anything it buffered while the app was offline.
        // The replay is consumer-driven (it no longer piggybacks on
        // `setActive(true)`) precisely so it can't fire before this point and
        // be swallowed by a stale session's handlers; the channel shims buffer
        // anything that arrives before `onmessage` is attached, so even a
        // replay racing this wiring is preserved. No-op when nothing is
        // buffered.
        try {
          flushNativeQueue();
        } catch {
          /* native module may not implement flushQueue on every platform yet */
        }
      } catch (err: any) {
        // A superseded run (teardown fired, or the transport was aborted) must
        // do nothing: the newer run owns all recovery.
        if (!isCurrent() || err?.name === 'AbortError') return;
        console.error('Failed to negotiate transport:', err);
        updateSessionStatus(requestId, origin, 'failed');
        // A room refusal (two-peer lockdown: the session already has its two
        // devices) is TERMINAL — retrying can't free a slot, so surface an
        // actionable "session full" message at once instead of hammering the
        // server with rejected attempts. The machine short-circuits into
        // `failed` on a terminal result.
        const terminal = isPeerRejectedError(err) ? ('session-full' as const) : undefined;
        if (terminal) {
          setError(err);
          Alert.alert(
            'Session Full',
            err?.message ||
              'This session already has the maximum number of devices connected. Ask the other device to disconnect and try again.',
            [{ text: 'OK' }],
          );
        }
        dispatchRef.current({
          type: 'ATTEMPT_FAILED',
          attemptId,
          reason: err?.message || 'Failed to negotiate transport',
          terminal,
        });
        // The negotiation timed out waiting for the peer's answer-description:
        // the peer simply isn't there. Mark it absent so the machine parks in
        // `waiting` (with the inline "check your remote device" notice) instead
        // of hammering retries; the next presence broadcast re-arms it.
        if (isPeerUnreachableError(err)) {
          dispatchRef.current({ type: 'PEER_ABSENT' });
        }
      }
    },
    [origin, requestId],
  );
  const negotiateRef = useRef(negotiate);
  negotiateRef.current = negotiate;

  // ---------------------------------------------------------------------
  // Effect interpreter: everything the pure machine asks for is executed
  // here — timers, teardown, native queries, and the two async flows above.
  // Assigned via a ref each render so `dispatch` (stable) always runs the
  // latest closures.
  // ---------------------------------------------------------------------
  runEffectRef.current = (effect: ConnectionEffect) => {
    switch (effect.type) {
      case 'startService':
        void startServiceRef.current();
        break;
      case 'negotiate':
        void negotiateRef.current(effect.attemptId, effect.mode);
        break;
      case 'armDeadline':
        if (deadlineTimerRef.current) clearTimeout(deadlineTimerRef.current);
        deadlineTimerRef.current = setTimeout(() => {
          deadlineTimerRef.current = null;
          dispatchRef.current({ type: 'DEADLINE', attemptId: effect.attemptId });
        }, effect.ms);
        break;
      case 'scheduleRetry':
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          dispatchRef.current({ type: 'RETRY_DUE' });
        }, effect.delayMs);
        break;
      case 'cancelTimers':
        if (deadlineTimerRef.current) {
          clearTimeout(deadlineTimerRef.current);
          deadlineTimerRef.current = null;
        }
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        if (livenessProbeTimerRef.current) {
          clearTimeout(livenessProbeTimerRef.current);
          livenessProbeTimerRef.current = null;
        }
        break;
      case 'teardown':
        // Abort the current attempt's in-flight native work (the transport
        // races the signal and cancels itself) and mark it stale for every
        // late callback, then drop the JS-side transport refs.
        if (negotiationAbortRef.current) {
          negotiationAbortRef.current.abort();
          negotiationAbortRef.current = null;
        }
        clearTransport({ preserveNativePeer: effect.preserveNativePeer });
        // HARD RECOVERY. The p2p transport is confirmed dead, and cancelling
        // the peer alone is not enough: the native service keeps our signaling
        // socket in the requestId room (it even answers the agent's heartbeat
        // pings), so the agent still counts two devices, never tears its side
        // down and never re-arms its offer listener — every fresh offer we send
        // is ignored and the UI sits on "Reconnecting…" forever. Dropping the
        // service reproduces the presence 2→1→2 sequence that switching chat
        // sessions (unmount → STOP + closeSocket → remount) has always used to
        // recover; doing it here gets the same result without unmounting.
        //
        // The service comes back on its own: the machine reset its gates with
        // this teardown, so the pending backoff retry walks through `starting`
        // → `startService`, which re-uses the still-valid `/auth/session`
        // cookie (no passkey prompt) and awaits this stop first (see
        // `serviceStopRef`). Idempotent: `closeSocket` no-ops once the service
        // is already down, so overlapping hard resets collapse into one.
        if (effect.dropSignaling) {
          console.log('[ac2] hard recovery: dropping the signaling service to force presence 2→1');
          closeSocket();
        }
        break;
      case 'queryNativeState': {
        // Pull the native truth (push events can be lost while the JS runtime
        // is suspended) and reconcile: a surviving native peer with an open
        // control channel is re-attached; anything else starts over.
        let alive = false;
        let channelOpen = false;
        try {
          const snapshot = getNativeConnectionState();
          alive = !!snapshot.connected && snapshot.requestId === requestIdRef.current;
          // NOTE: the raw snapshot carries the native enum strings verbatim
          // (UPPERCASE, e.g. `"OPEN"`), so the helper compares
          // case-insensitively — a plain `=== 'open'` here misread a healthy
          // resume as dead and forced a spurious reconnect.
          channelOpen = alive && isSnapshotChannelOpen(snapshot);
        } catch {
          /* native module unavailable (tests / web) — treat as dead */
        }
        // NOTE: an "open" channel here is deliberately NOT counted as liveness.
        // A zombie DataChannel left behind by a long background still reports
        // OPEN, and refreshing the heartbeat clocks off that report is what let
        // the wallet keep believing a dead link was healthy. The machine turns
        // an open-looking snapshot into a `probeLiveness` effect instead: only
        // an answered ping refreshes liveness.
        dispatchRef.current({ type: 'NATIVE_SNAPSHOT', alive, channelOpen });
        break;
      }
      case 'probeLiveness': {
        // Resume liveness probe: put a ping on the wire and require REAL
        // inbound traffic (`inboundSeqRef`, bumped only by frames that actually
        // arrived) before the short window closes. Anything else is treated as
        // a confirmed-dead transport so recovery takes the hard path.
        if (livenessProbeTimerRef.current) {
          clearTimeout(livenessProbeTimerRef.current);
          livenessProbeTimerRef.current = null;
        }
        const seqBefore = inboundSeqRef.current;
        let sent = false;
        try {
          sent = sendKeepalivePingRef.current();
        } catch (err) {
          console.warn('Liveness probe send failed; treating as a dead transport', err);
        }
        if (!sent) {
          dispatchRef.current({
            type: 'CONNECTION_LOST',
            reason: 'liveness probe could not be sent',
            confirmedDead: true,
          });
          break;
        }
        livenessProbeTimerRef.current = setTimeout(() => {
          livenessProbeTimerRef.current = null;
          // A teardown/reconnect since the ping already superseded the probe.
          if (machineRef.current.phase !== 'connected') return;
          if (inboundSeqRef.current !== seqBefore) return;
          console.warn('[ac2] liveness probe went unanswered; the transport is a zombie');
          dispatchRef.current({
            type: 'CONNECTION_LOST',
            reason: 'liveness probe timed out',
            confirmedDead: true,
          });
        }, effect.ms);
        break;
      }
    }
  };

  // Session lifecycle: START once the prerequisites are in place (wallet
  // account + keys loaded), STOP on a genuine teardown (session change /
  // unmount while the app is active). `START` in any non-stopped phase is a
  // no-op, so re-runs from the dependency flips are safe.
  const hasAccounts = accounts.length > 0;
  const hasKeys = keys.length > 0;
  useEffect(() => {
    if (!origin || !requestId) {
      console.error('Missing origin or requestId');
      return;
    }
    // Never resurrect a session the user explicitly disconnected.
    if (userStoppedRef.current) {
      return;
    }
    if (!findWalletAccount(accountsStore.state.accounts, keyStore.state.keys)) {
      console.log('Waiting for accounts and keys to load...');
      // Typically the stores are still hydrating; the effect re-runs once the
      // account/key counts flip.
      return;
    }

    dispatch({ type: 'START' });

    return () => {
      // If this cleanup fires because the app is being backgrounded / destroyed
      // (swipe-away, screen off) rather than a genuine session change or
      // explicit disconnect, PRESERVE the live connection: the background
      // foreground-service keeps the peer alive so a relaunch/foreground can
      // re-attach and hydrate from it (the `attach()` path). Tearing the
      // transport + service down here is exactly what dropped the connection on
      // swipe-away. Only this run's JS-side wiring is detached — the JS VM can
      // survive a relaunch, and leaving it subscribed would accumulate dead
      // listeners per relaunch that swallow the offline-queue replay and
      // duplicate events. The watchdog/ICE monitor are stopped for the same
      // reason — a stale watchdog firing on the dead tree could cancel the very
      // peer being preserved.
      if (AppState.currentState !== 'active') {
        if (heartbeatMonitorRef.current) {
          heartbeatMonitorRef.current.stop();
          heartbeatMonitorRef.current = null;
        }
        if (peerMonitorDisposeRef.current) {
          peerMonitorDisposeRef.current();
          peerMonitorDisposeRef.current = null;
        }
        if (transportDisposeRef.current) {
          try {
            transportDisposeRef.current();
          } catch {
            /* noop */
          }
          transportDisposeRef.current = null;
        }
        if (presenceUnsubRef.current) {
          try {
            presenceUnsubRef.current();
          } catch {
            /* noop */
          }
          presenceUnsubRef.current = null;
        }
        if (signalingUnsubRef.current) {
          try {
            signalingUnsubRef.current();
          } catch {
            /* noop */
          }
          signalingUnsubRef.current = null;
        }
        return;
      }
      // A real teardown (deps changed while the app is active, or unmount):
      // abort the in-flight service bring-up, stop the machine (cancels timers
      // + tears down the p2p transport), then drop the persistent service.
      serviceAbortRef.current?.abort();
      serviceAbortRef.current = null;
      authFlowInProgressRef.current = false;
      dispatch({ type: 'STOP' });
      closeSocket();
    };
  }, [origin, requestId, hasAccounts, hasKeys, dispatch, closeSocket]);

  // ---------------------------------------------------------------------
  // UI projection: phase → flags, in exactly one place.
  // ---------------------------------------------------------------------
  const ui = deriveUiState(machineState);
  // The peer isn't in the requestId room and the machine is parked (waiting)
  // or between retries. Surfaced inline in the chat window (a clean banner
  // over the composer) rather than as a disruptive pop-up.
  const peerOffline =
    (machineState.phase === 'waiting' || machineState.phase === 'backoff') &&
    machineState.peerPresent === false;
  // `stopped` before START is dispatched (stores still hydrating / first
  // render) reads as loading, matching the old initial `isLoading = true`;
  // after an explicit user disconnect it does not. A `waiting` that is only
  // gated on the absent peer shows the peer-offline notice, not the spinner.
  const isLoading =
    !userStopped &&
    ((ui.isLoading && !peerOffline) || (machineState.phase === 'stopped' && !error));

  return {
    session,
    address,
    send,
    sendAc2,
    ac2Client,
    activeStreamText,
    agentPresenceDetail,
    agentPresence,
    peerPresence,
    peerOffline,
    isSocketConnected,
    error,
    isError: !!error,
    isLoading,
    isConnected: ui.isConnected,
    isReconnecting: ui.isReconnecting,
    reconnectAttempt: ui.reconnectAttempt,
    lastHeartbeat,
    reset,
    reconnect,
    activeThid,
    openConversation,
    closeConversation,
    remoteThreads,
    connectionNotice,
    dismissConnectionNotice,
    isRegistered,
  };
}
