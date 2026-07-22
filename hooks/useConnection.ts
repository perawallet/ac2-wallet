import { useProvider } from '@/hooks/useProvider';
import type {
  ConnectionNotice,
  HeartbeatMonitor,
  MonitoredPeerConnection,
  PresenceResult,
  ScopedConnectionNotice,
} from '@/lib/ac2';
import {
  attachHeartbeatChannel,
  createAc2Client,
  createAc2Transport,
  createHeartbeatMonitor,
  DEFAULT_THID,
  describeSelectedCandidatePair,
  generateThid,
  isPeerOffline,
  isPeerUnreachableError,
  isRegistrationBlockingNotice,
  monitorPeerConnection,
  queryPresence,
  selectConnectionNoticeForRequest,
  sendConversationClose,
  sendConversationOpen,
  subscribeToPresence,
  summarizeSelectedCandidatePair,
  waitForSignalSocketConnected,
} from '@/lib/ac2';
import { createControlFrameHandler } from '@/lib/ac2/streamControlFrame';
import { findWalletAccount } from '@/lib/keystore/wallet-account';
import { authenticateLiquidAuth } from '@/lib/liquid-auth/flow';
import {
  addressMatchesKey,
  sessionAddressFromData,
  sessionAlreadyAuthenticatedForRequest,
} from '@/lib/liquid-auth/helpers';
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
import { SignalClient } from '@algorandfoundation/liquid-client';
import { useStore } from '@tanstack/react-store';
import { XHR as EngineIoXHR } from 'engine.io-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, type AppStateStatus, NativeModules, Platform } from 'react-native';

const AUTO_RECONNECT_DELAY_MS = 3000;
// Bounded auto-reconnect budget. After this many failed automatic attempts we
// stop retrying and fall back to the manual "Reconnect" button.
const MAX_RECONNECT_ATTEMPTS = 3;
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

// Why a connection was torn down unexpectedly. Routed through `failConnection`
// so every detector (channel close, setup error, and — added in later phases —
// ICE state, heartbeat watchdog, send failures) funnels into one recovery path.
type ConnectionFailureReason = 'channel' | 'setup' | 'ice' | 'heartbeat' | 'send' | 'open';

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
   * True when a (re)connect gave up because the peer isn't present in the
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
  /** True while bounded automatic reconnect attempts are in flight. */
  isReconnecting: boolean;
  /** Current automatic reconnect attempt (1-based); `0` when not retrying. */
  reconnectAttempt: number;
  /** Total automatic reconnect attempts before falling back to manual. */
  maxReconnectAttempts: number;
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

export function useConnection(
  origin: string,
  requestId: string,
  options: UseConnectionOptions = {},
): UseConnectionResult {
  const { accounts, keys, key, passkey } = useProvider();
  const allowPasskeyCreation = options.allowPasskeyCreation ?? false;

  const [isConnected, setIsConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const addressRef = useRef<string | null>(null);

  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Auto-reconnect progress surfaced to the UI so it can show a "Reconnecting
  // (n/max)…" state while bounded retries are in flight, and only fall back to
  // the manual Reconnect button once the budget is exhausted.
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  // Ref mirror of the attempt counter so the retry scheduler can read/increment
  // it synchronously without racing React state batching.
  const reconnectAttemptRef = useRef(0);
  // Bumped to re-trigger the p2p transport negotiation effect on demand
  // (manual/auto reconnect, presence-driven renegotiation). Does NOT rebuild
  // the persistent socket.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  // Bumped to rebuild the persistent signaling socket after it was fully torn
  // down (an explicit disconnect via `reset`). Transient socket.io drops
  // auto-reconnect without a rebuild, so this is only used for the "reconnect
  // after an explicit disconnect" path.
  const [socketNonce, setSocketNonce] = useState(0);

  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamChannelRef = useRef<RTCDataChannel | null>(null);
  // Dedicated `ac2-heartbeat` liveness channel — out-of-band relative to `ac2-v1`.
  const heartbeatChannelRef = useRef<RTCDataChannel | null>(null);
  // The negotiated peer connection + the disposer for its connectivity monitor.
  // The SDK never watches ICE/connection state, so we attach our own once the
  // data channel opens and tear it down in `clearTransport`.
  const peerConnectionRef = useRef<MonitoredPeerConnection | null>(null);
  const peerMonitorDisposeRef = useRef<(() => void) | null>(null);
  // Heartbeat liveness watchdog (ping/pong over `ac2-heartbeat`). Started in
  // `onOpen`, stopped in `clearTransport` / effect cleanup.
  const heartbeatMonitorRef = useRef<HeartbeatMonitor | null>(null);
  const clientRef = useRef<SignalClient | null>(null);
  // Last time we observed inbound traffic from the peer (frames, envelopes,
  // heartbeat pongs) vs. the last local user action. Kept separate so an
  // outbound keepalive can never be mistaken for peer presence.
  const lastInboundActivityRef = useRef<number>(Date.now());
  const lastLocalActivityRef = useRef<number>(Date.now());
  const authFlowInProgressRef = useRef<boolean>(false);
  // Ignore one `onClose` when the transport was intentionally torn down.
  const deliberateCloseRef = useRef(false);
  // Set when the user explicitly disconnects (`reset()`); blocks the
  // foreground auto-reconnect from resurrecting a session they chose to stop.
  const userStoppedRef = useRef(false);
  // One-shot delayed reconnect that mirrors pressing the Reconnect button.
  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last observed `AppState`, so the foreground listener only reacts to a real
  // background/inactive -> active transition (not active -> active repeats).
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  // True once the app has been backgrounded/inactive and no inbound frame has
  // since proven the connection still alive. Lets the inactivity close tell a
  // stale-from-background drop (auto-reconnect when foregrounded) apart from a
  // genuine foreground idle close (stays manual, so we don't churn/re-prompt).
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
  // connected). Handled outside the SignalClient, on the socket, via the
  // dedicated `presence` websocket event. Used to detect whether there is
  // anyone available to (re)connect to.
  const [peerPresence, setPeerPresence] = useState<PresenceResult | null>(null);
  // Live mirror of `peerPresence` so the failure funnel can read the latest
  // snapshot synchronously (without re-subscribing on every presence update)
  // when deciding whether a connection failure means the peer is offline.
  const peerPresenceRef = useRef<PresenceResult | null>(null);
  peerPresenceRef.current = peerPresence;
  // True when we've given up (re)connecting because the peer isn't in the
  // requestId room. Surfaced inline in the chat window (a clean banner over the
  // composer) rather than as a disruptive pop-up, so the user knows to check
  // their remote device. Cleared on a fresh (re)connect and on a successful
  // connect.
  const [peerOffline, setPeerOffline] = useState(false);
  // Whether the signaling socket itself is connected to the Liquid Auth
  // service. Owned by the persistent socket effect and kept alive across p2p
  // chat drops, so presence checks and renegotiation keep working. Surfaced as
  // "Service unavailable" in the chat UI when false.
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const isSocketConnectedRef = useRef(false);
  isSocketConnectedRef.current = isSocketConnected;
  // Disposer for the socket-level `presence` subscription (lives with the
  // socket, not the transport).
  const presenceUnsubRef = useRef<(() => void) | null>(null);
  // True once the persistent socket is established AND connected, so p2p
  // negotiation may be attempted (subject to the both-peers-present gate).
  const socketReadyRef = useRef(false);
  // True while a p2p transport negotiation is in flight, so presence/reconnect
  // triggers never stack a second concurrent negotiation on the shared socket.
  const transportInFlightRef = useRef(false);
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
  const [connectionNoticeState, setConnectionNoticeState] =
    useState<ScopedConnectionNotice | null>(null);
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

  const session = useStore(sessionsStore, (state) =>
    state.sessions.find((s) => s.id === requestId && s.origin === origin),
  );

  // Close and null out every transport ref (AC2 client, data/stream/heartbeat
  // channels, and the signal client). Leaving `clientRef`/`dataChannelRef` set
  // after a drop is what previously wedged the connection effect's guard
  // (`if (clientRef.current || isConnected) return`) and left the UI stuck on
  // "Connecting…" with no way to recover.
  const clearTransport = useCallback(() => {
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
    // Tear down ONLY the p2p peer, keeping the persistent signaling socket
    // (and its presence subscription) alive so the app stays connected to the
    // service after a chat drop — enabling presence checks and renegotiation
    // over the same socket without a fresh auth/passkey. The socket itself is
    // owned by the socket effect (see `closeSocket`).
    const client = clientRef.current;
    if (client) {
      try {
        // `SignalClient.close()` never tears down the WebRTC peer connection, so
        // close it explicitly. A leaked `RTCPeerConnection` keeps the ICE
        // session to the agent alive, so the agent still treats the old peer as
        // active for this requestId and ignores the fresh offer a reconnect
        // sends — leaving negotiation hung after `setLocalDescription`.
        client.peerClient?.close();
      } catch {
        /* noop */
      }
      // Allow a fresh `peer()` on the reused SignalClient (it refuses to run
      // while a peer/requestId is still in progress).
      client.peerClient = undefined;
      // Detach the per-negotiation listeners the SDK (`peer()`/`signal()`) and
      // `createAc2Transport` add on each negotiation, so reusing this socket
      // for the next attempt doesn't accumulate duplicate `data-channel` /
      // candidate / description handlers that would double-apply signaling.
      try {
        client.off('data-channel');
      } catch {
        /* noop */
      }
      const socket = client.socket as any;
      try {
        socket?.off?.('offer-candidate');
        socket?.off?.('answer-candidate');
        socket?.off?.('offer-description');
        socket?.off?.('answer-description');
      } catch {
        /* noop */
      }
    }
  }, []);

  // Fully tear down the persistent signaling socket (and its presence
  // subscription). Only used on an explicit disconnect (`reset`) or when the
  // hook unmounts / the origin+requestId changes — NOT on a chat drop, so the
  // socket survives p2p reconnects.
  const closeSocket = useCallback(() => {
    if (presenceUnsubRef.current) {
      try {
        presenceUnsubRef.current();
      } catch {
        /* noop */
      }
      presenceUnsubRef.current = null;
    }
    socketReadyRef.current = false;
    setIsSocketConnected(false);
    if (clientRef.current) {
      try {
        // `close(true)` detaches listeners AND disconnects the underlying
        // socket.io connection.
        clientRef.current.close(true);
      } catch {
        /* noop */
      }
      clientRef.current = null;
    }
  }, []);

  // Best-effort, read-only diagnostic: log which ICE path the peer selected
  // (direct `host` / STUN `srflx` / TURN `relay`). Never logs addresses. Call
  // before teardown — it reads the peer synchronously and resolves async.
  const logCandidatePair = useCallback((context: string) => {
    const pc = clientRef.current?.peerClient;
    if (!pc || typeof pc.getStats !== 'function') return;
    pc.getStats()
      .then((report: any) => {
        const summary = summarizeSelectedCandidatePair(report);
        if (summary) {
          console.log(`[ac2] ${context} path: ${describeSelectedCandidatePair(summary)}`);
        }
      })
      .catch(() => {
        /* diagnostics only */
      });
  }, []);
  const logCandidatePairRef = useRef(logCandidatePair);
  logCandidatePairRef.current = logCandidatePair;

  const reset = useCallback(() => {
    deliberateCloseRef.current = true;
    userStoppedRef.current = true;
    reconnectAttemptRef.current = 0;
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    clearTransport();
    // An explicit user disconnect also drops the persistent signaling socket:
    // the user is leaving the session, so there is nothing to stay present for.
    closeSocket();
    setActiveStreamText('');
    setAgentPresence(null);
    setAgentPresenceDetail(null);
    setIsConnected(false);
    setIsLoading(false);
    setIsReconnecting(false);
    setReconnectAttempt(0);
    setError(null);
    setPeerOffline(false);
    updateSessionStatus(requestId, origin, 'closed');
  }, [requestId, origin, clearTransport, closeSocket]);

  // Core reconnect primitive: tear down any stale transport (so the connection
  // effect's guard doesn't short-circuit), flip into the loading/connecting
  // state, and bump the nonce to re-run setup. Deliberately does NOT touch the
  // retry budget so it can back both manual and automatic reconnects.
  const performReconnect = useCallback(() => {
    deliberateCloseRef.current = true;
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    clearTransport();
    authFlowInProgressRef.current = false;
    // Reset both liveness clocks so the fresh attempt isn't judged idle.
    lastInboundActivityRef.current = Date.now();
    lastLocalActivityRef.current = Date.now();
    setError(null);
    // A fresh attempt is starting — clear any "peer offline" notice.
    setPeerOffline(false);
    setIsConnected(false);
    setIsLoading(true);
    setReconnectNonce((n) => n + 1);
  }, [clearTransport]);
  const performReconnectRef = useRef(performReconnect);
  performReconnectRef.current = performReconnect;

  // Manually re-establish a dropped connection (user pressed "Reconnect").
  // Resets the automatic-retry budget so the user always gets a fresh set of
  // attempts, and clears any exhausted/failed reconnecting state.
  const reconnect = useCallback(() => {
    userStoppedRef.current = false;
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setIsReconnecting(false);
    if (!clientRef.current) {
      // The persistent socket was fully torn down (an explicit disconnect):
      // rebuild it. The socket effect re-authenticates, reconnects, and drives
      // presence-gated p2p negotiation once both peers are present again.
      setError(null);
      setPeerOffline(false);
      setIsConnected(false);
      setIsLoading(true);
      setSocketNonce((n) => n + 1);
      return;
    }
    performReconnect();
  }, [performReconnect]);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  // Schedule the next bounded, serialized automatic reconnect attempt. Returns
  // false when we've exhausted the budget (or the user stopped the session), so
  // callers can fall back to the manual Reconnect button. Retries never
  // overlap: a new attempt is only ever scheduled from a prior attempt's
  // terminal event (transport `onClose` or a setup failure), and the pending
  // timer/in-flight guards below make double-scheduling impossible — which also
  // guarantees we never launch two connection attempts (and two blocking
  // biometric prompts) at once.
  const scheduleAutoReconnect = useCallback((): boolean => {
    if (userStoppedRef.current) return false;
    // A retry is already pending or an attempt is mid-flight — don't stack.
    if (autoReconnectTimerRef.current) return true;
    if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) return false;

    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    setReconnectAttempt(attempt);
    setIsReconnecting(true);
    setIsLoading(false);
    autoReconnectTimerRef.current = setTimeout(() => {
      autoReconnectTimerRef.current = null;
      performReconnectRef.current();
    }, AUTO_RECONNECT_DELAY_MS);
    return true;
  }, []);
  const scheduleAutoReconnectRef = useRef(scheduleAutoReconnect);
  scheduleAutoReconnectRef.current = scheduleAutoReconnect;

  // Single funnel for an unexpected connection failure. Later async detectors
  // (ICE state, heartbeat watchdog, send errors) all route through this so
  // teardown + bounded reconnect happen in exactly one place. `isCurrent`
  // closes over the observing setup run's `active` flag (set false by that
  // run's cleanup before any newer run starts), so a stale/superseded callback
  // is ignored and can't tear down or reschedule on top of a newer run.
  const failConnection = useCallback(
    (reason: ConnectionFailureReason, isCurrent: () => boolean, error?: Error) => {
      if (!isCurrent()) return;
      if (!error) console.log(`Connection lost (${reason})`);
      // Capture which ICE path this session used before tearing the peer down,
      // to correlate failures with relay/direct usage (best-effort).
      logCandidatePairRef.current(`failed(${reason})`);
      setIsConnected(false);
      // Drop every stale transport ref so the next reconnect isn't blocked by
      // the connection effect's guard.
      clearTransport();
      // Kick off (or continue) the bounded, serialized retry sequence. Once the
      // budget is spent, fall back to the manual Reconnect bar (surfacing the
      // terminal error only for a setup failure).
      if (!scheduleAutoReconnectRef.current()) {
        setIsReconnecting(false);
        setIsLoading(false);
        // Distinguish "the peer simply isn't there" from a generic failure so
        // the user gets an actionable message instead of a cryptic timeout.
        // The peer is deemed offline when the signaling server reports nobody
        // but us in the requestId room (presence) or when the negotiation timed
        // out waiting for the peer's answer-description.
        const peerIsOffline =
          isPeerOffline(peerPresenceRef.current) || isPeerUnreachableError(error);
        if (peerIsOffline) {
          // Surface this inline in the chat window (see ChatScreen) rather than
          // as a pop-up: tell the user the chat can't connect and that they
          // should check their remote device.
          if (error) setError(error);
          setPeerOffline(true);
        } else if (error) {
          setError(error);
          Alert.alert(
            'Connection Failed',
            error.message || 'Failed to setup connection to the peer',
            [{ text: 'OK' }],
          );
        }
      }
    },
    [clearTransport],
  );
  const failConnectionRef = useRef(failConnection);
  failConnectionRef.current = failConnection;

  // Live mirrors of the connection state so the AppState listener can read the
  // current values without being torn down/re-subscribed on every change (and
  // without capturing a stale closure).
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const isReconnectingRef = useRef(isReconnecting);
  isReconnectingRef.current = isReconnecting;

  // Attempt a p2p (re)negotiation IFF it is safe and worthwhile. Peers must not
  // negotiate without knowing they both exist, so this only proceeds when the
  // persistent socket is connected, we aren't already connected/negotiating,
  // and the signaling server reports the peer present in the requestId room.
  // When the peer is absent it simply waits — the next `presence` broadcast (or
  // a manual Reconnect) re-invokes this once both parties are back in the room.
  const maybeNegotiate = useCallback(() => {
    // Log why a negotiation attempt is (or isn't) started. When the app is
    // stuck on "Connecting…" after the agent restarts, this pinpoints whether
    // the wallet even TRIED to negotiate — and if not, exactly which gate held
    // it back (socket not ready, already connecting, peer not present, etc.).
    if (userStoppedRef.current) {
      console.log('[ac2] maybeNegotiate: skipped — user stopped the session');
      return;
    }
    if (!socketReadyRef.current) {
      console.log('[ac2] maybeNegotiate: skipped — signaling socket not ready');
      return;
    }
    if (isConnectedRef.current || transportInFlightRef.current) {
      console.log(
        `[ac2] maybeNegotiate: skipped — ${
          isConnectedRef.current ? 'already connected' : 'a negotiation is already in flight'
        }`,
      );
      return;
    }
    if (autoReconnectTimerRef.current) {
      console.log('[ac2] maybeNegotiate: skipped — an auto-reconnect is already pending');
      return;
    }
    // Both peers must be present (deviceCount >= 2) before we negotiate p2p.
    if (isPeerOffline(peerPresenceRef.current)) {
      console.log(
        `[ac2] maybeNegotiate: waiting — peer not present (deviceCount=${
          peerPresenceRef.current?.deviceCount ?? 'unknown'
        }); will retry on the next presence broadcast`,
      );
      setIsLoading(false);
      setPeerOffline(true);
      return;
    }
    console.log(
      `[ac2] maybeNegotiate: peer present (deviceCount=${
        peerPresenceRef.current?.deviceCount ?? 'unknown'
      }) — starting p2p (re)negotiation`,
    );
    performReconnectRef.current();
  }, []);
  const maybeNegotiateRef = useRef(maybeNegotiate);
  maybeNegotiateRef.current = maybeNegotiate;

  // The signaling server reports the peer has left the requestId room (presence
  // deviceCount dropped to just us). Presence is authoritative and immediate, so
  // proactively tear down the p2p transport and surface a clean inline "Peer
  // offline" notice right away, instead of waiting out the heartbeat/ICE
  // watchdog — the heartbeat only keeps a LIVE connection alive while BOTH peers
  // are online. We do NOT schedule a reconnect here: with the peer gone there is
  // nothing to connect to. The next presence broadcast showing both peers back
  // in the room drives renegotiation via `maybeNegotiate`.
  const handlePeerOffline = useCallback(() => {
    // Respect an explicit user disconnect — nothing to keep present for.
    if (userStoppedRef.current) return;
    console.log(
      `[ac2] handlePeerOffline: peer left the room (deviceCount=${
        peerPresenceRef.current?.deviceCount ?? 'unknown'
      }) — tearing down p2p, keeping socket; awaiting peer to return`,
    );
    // Cancel any pending automatic reconnect: retrying is pointless while the
    // peer is absent and would otherwise flip the UI back into "Connecting…".
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setIsReconnecting(false);
    // Tear down ONLY the p2p peer/data-channels (the persistent socket and its
    // presence subscription stay alive so we keep receiving broadcasts). Flag
    // the teardown as deliberate so the channel `onClose` doesn't re-enter the
    // failure/auto-reconnect path.
    deliberateCloseRef.current = true;
    clearTransport();
    setIsConnected(false);
    setIsLoading(false);
    setPeerOffline(true);
  }, [clearTransport]);
  const handlePeerOfflineRef = useRef(handlePeerOffline);
  handlePeerOfflineRef.current = handlePeerOffline;

  // Automatically resume a dropped connection when the app returns to the
  // foreground. Subscribed once per session (keyed on origin/requestId); all
  // decision state is read from refs so there is no stale-closure risk. The
  // in-progress guards below are what prevent a second connection attempt from
  // launching a duplicate — and therefore a duplicate blocking biometric
  // prompt, since the passkey assertion/attestation step is what triggers it.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      // Remember that we left the foreground. Timers are suspended while
      // backgrounded, so a connection can silently go stale; this flag lets the
      // inactivity close distinguish that from a genuine foreground idle.
      if (nextState === 'background' || nextState === 'inactive') {
        wasBackgroundedRef.current = true;
      }

      // Only react to a genuine (background|inactive) -> active transition.
      if (nextState !== 'active' || prevState === 'active') return;

      // Respect an explicit user disconnect; don't resurrect a stopped session.
      if (userStoppedRef.current) return;

      // A healthy connection needs nothing.
      if (isConnectedRef.current) return;

      // Never start a second connection while one is already in flight. Any of
      // these means "busy": an auth flow (blocking biometric prompt) is open,
      // a p2p transport negotiation is already running, we're in the
      // loading/connecting state, an auto-reconnect sequence is running, or a
      // retry timer is already pending. NOTE: we no longer treat a live
      // `clientRef` (the persistent socket) as "busy" — it is expected to stay
      // connected across chat drops, and a resume only re-negotiates the peer.
      if (
        authFlowInProgressRef.current ||
        transportInFlightRef.current ||
        isLoadingRef.current ||
        isReconnectingRef.current ||
        autoReconnectTimerRef.current
      ) {
        return;
      }

      // Only resume sessions we still track (not forgotten by the user).
      const existingSession = sessionsStore.state.sessions.find(
        (s) => s.id === requestId && s.origin === origin,
      );
      if (!existingSession) return;

      reconnectRef.current();
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
          // has died (a zombie transport). Route through the single recovery
          // funnel instead of crashing, and don't echo a frame we never sent.
          console.warn('Failed to send message; treating as a dropped connection', err);
          failConnectionRef.current('send', () => isConnectedRef.current);
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
        // sent) AND route through the recovery funnel to reconnect the dead
        // transport.
        console.warn('Failed to send AC2 envelope; treating as a dropped connection', err);
        failConnectionRef.current('send', () => isConnectedRef.current);
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

  useEffect(() => {
    let active = true;
    let inactivityInterval: any = null;

    if (isConnected) {
      inactivityInterval = setInterval(() => {
        const now = Date.now();
        // Any traffic keeps the session alive: measure from the most recent of
        // inbound peer traffic (frames/pongs) or local user action. A dead
        // transport is caught far sooner by the ICE monitor / heartbeat
        // watchdog; this only fires for a genuinely quiet session or one that
        // went stale while backgrounded.
        const lastActivity = Math.max(lastInboundActivityRef.current, lastLocalActivityRef.current);
        const inactiveTime = now - lastActivity;
        if (inactiveTime >= IDLE_SESSION_TIMEOUT_MS) {
          // A stale connection whose idleness is explained by the app having
          // been backgrounded (timers suspended, no heartbeats) should recover
          // automatically; a genuine foreground idle should not (avoids churn /
          // repeated biometric prompts). An intentional disconnect never
          // resumes.
          const resumeAfterBackground = !userStoppedRef.current && wasBackgroundedRef.current;
          console.log(
            resumeAfterBackground
              ? 'Closing stale connection after background; will reconnect'
              : 'Closing idle session (no activity)',
          );
          // Fully tear down so the connection effect's guard doesn't keep a
          // stale client around — otherwise a later reconnect is impossible.
          deliberateCloseRef.current = true;
          clearTransport();
          updateSessionStatus(requestId, origin, 'closed');
          if (active) {
            setIsConnected(false);
            setIsLoading(false);
          }
          // If we're already back in the foreground, reconnect now (the
          // foreground AppState handler already ran while we still looked
          // connected, so it won't fire again). If the close happened while
          // still backgrounded, that handler resumes us on the next activation.
          if (resumeAfterBackground && AppState.currentState === 'active') {
            wasBackgroundedRef.current = false;
            reconnectRef.current();
          }
        }
      }, IDLE_CHECK_INTERVAL_MS);
    }

    return () => {
      active = false;
      if (inactivityInterval) clearInterval(inactivityInterval);
    };
  }, [isConnected, clearTransport, origin, requestId]);

  useEffect(() => {
    let active = true;
    // Aborts every in-flight setup request when this run is superseded (a newer
    // reconnect/nonce bump) or unmounted, so a stalled request from an obsolete
    // attempt can't linger and race a fresh one.
    const runAbort = new AbortController();

    // `fetch` with a per-request timeout, also wired to this run's abort signal.
    // A timeout or supersession rejects the request so the outer catch can hand
    // off to the bounded auto-reconnect scheduler instead of hanging.
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
      return fetch(input, { ...init, signal: controller.signal }).finally(() => {
        clearTimeout(timer);
        runAbort.signal.removeEventListener('abort', onRunAbort);
      });
    };

    async function setupConnection() {
      if (!origin || !requestId) {
        console.error('Missing origin or requestId');
        setIsLoading(false);
        return;
      }

      if (authFlowInProgressRef.current) {
        console.log('Auth flow already in progress, skipping duplicate setup');
        return;
      }

      if (!findWalletAccount(accountsStore.state.accounts, keyStore.state.keys)) {
        console.log('Waiting for accounts and keys to load...');
        // If it's been loading for more than a few seconds, it might really be empty
        // but typically it's better to wait for them to be non-empty.
        return;
      }

      // The persistent socket is already established for this session — the
      // socket effect only builds it once (it survives p2p chat drops).
      if (clientRef.current) {
        return;
      }
      // Never resurrect a session the user explicitly disconnected.
      if (userStoppedRef.current) {
        return;
      }

      setIsLoading(true);
      setError(null);
      authFlowInProgressRef.current = true;

      // Coarse phase timing so a hang is attributable to auth vs. WebRTC
      // negotiation vs. the channel-open wait.
      const setupStartedAt = Date.now();

      try {
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
        if (!active) return;
        let initialSessionData: any = null;
        let initialSessionAddress: string | null = null;
        console.log('Initial session status:', sessionCheck.ok);

        if (sessionCheck.ok) {
          try {
            const sessionData = await sessionCheck.json();
            initialSessionData = sessionData;
            if (!active) return;
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
            isActive: () => active,
          });
          if (authResult.superseded || !active) return;
        }
        console.log(`[ac2] auth phase done in ${Date.now() - setupStartedAt}ms`);

        // Final validation of the session before connecting
        const finalSessionCheck = await fetchWithTimeout(`${origin}/auth/session`);

        if (!active) return;

        if (finalSessionCheck.ok) {
          const sessionData = await finalSessionCheck.json();

          if (!active) return;

          const sessionAddress = sessionAddressFromData(sessionData);
          if (sessionAddress && addressMatchesKey(sessionAddress, foundKey)) {
            setAddress(sessionAddress);
            addressRef.current = sessionAddress;
          } else if (sessionAddress) {
            console.warn(
              'Ignoring final session address that does not match the active wallet key',
            );
          }
        } else {
          console.log('Session validation failed (ignored for debugging)');
        }

        let options: any = {
          autoConnect: true,
          transportOptions: {},
          withCredentials: true,
        };

        if (Platform.OS === 'ios') {
          options.transports = [EngineIoXHR];
        } else if (NativeModules.CookieModule) {
          const cookie = await NativeModules.CookieModule.getCookie(origin);

          if (!active) return;

          if (cookie) {
            options.extraHeaders = { Cookie: cookie };
            options.transports = ['polling'];
            options.transportOptions = {
              polling: { extraHeaders: { Cookie: cookie } },
            };
          }
        }

        const client = new SignalClient(origin, options);

        if (!active) return;

        clientRef.current = client;
        //@ts-ignore
        client.authenticated = true;

        // Wait for the socket to actually connect before wiring any listeners.
        // `SignalClient` initializes its socket asynchronously (it dynamically
        // imports socket.io-client), so `client.socket` is `undefined` right
        // after construction — subscribing to presence or connect/disconnect
        // events before this point throws "Cannot read property 'on' of
        // undefined". Awaiting here guarantees `client.socket` exists.
        await waitForSignalSocketConnected(client);
        if (!active) return;

        // Track socket connectivity so the chat surface can show "Service
        // unavailable" while the signaling service is unreachable. The socket is
        // kept alive across p2p chat drops; socket.io auto-reconnects transient
        // drops without rebuilding the client, and on each (re)connect the
        // server rejoins us to the requestId room and rebroadcasts presence.
        const socket = client.socket as any;
        const onSocketConnect = () => {
          if (!active) return;
          setIsSocketConnected(true);
          socketReadyRef.current = true;
          maybeNegotiateRef.current();
        };
        const onSocketDisconnect = () => {
          if (!active) return;
          setIsSocketConnected(false);
          socketReadyRef.current = false;
        };
        socket?.on?.('connect', onSocketConnect);
        socket?.on?.('disconnect', onSocketDisconnect);

        // Presence lives with the socket (outside the p2p transport) so it keeps
        // working across chat drops and drives presence-gated renegotiation:
        // peers must both be present in the requestId room before negotiating.
        presenceUnsubRef.current = subscribeToPresence(socket, (presence) => {
          if (!active) return;
          console.log(
            `[ac2] presence for ${presence.requestId}: ${presence.deviceCount} device(s), online=${presence.online}`,
          );
          setPeerPresence(presence);
          peerPresenceRef.current = presence;
          if (isPeerOffline(presence)) {
            // The peer isn't in the requestId room — but the WebRTC data channel
            // is the source of truth for an established p2p connection, and it
            // survives signaling-server loss. If a chat is currently live
            // (`isConnectedRef`), a presence drop is almost always a signaling
            // artifact (most commonly the signaling server restarting and not
            // yet re-counting the still-connected peer), NOT a real departure.
            // Tearing down here would needlessly restart a healthy p2p
            // connection on every signaling blip, so ignore it: a genuinely gone
            // peer is caught by the data channel's own detectors (the heartbeat
            // watchdog and ICE connectivity monitor), which is the standard
            // "drop only when the data channel fails" behavior.
            //
            // When NOT connected there is no live p2p connection to trust, so a
            // presence drop is authoritative and immediate: proactively tear
            // down any half-open transport and surface a clean inline "Peer
            // offline" notice instead of an endless "Connecting…". Only progress
            // to connecting again once the peer is back (the else branch).
            if (isConnectedRef.current) {
              console.log(
                '[ac2] presence shows peer offline but the p2p data channel is live — ignoring (the data channel is authoritative; a real drop is handled by the heartbeat/ICE monitors)',
              );
            } else {
              handlePeerOfflineRef.current();
            }
          } else {
            // Both peers are present: (re)negotiate the p2p transport.
            setPeerOffline(false);
            maybeNegotiateRef.current();
          }
        });

        setIsSocketConnected(true);
        socketReadyRef.current = true;
        console.log(`[ac2] socket phase done in ${Date.now() - setupStartedAt}ms`);

        // Seed presence so the first negotiation decision is based on a real
        // room count instead of an unknown; broadcasts drive it afterwards. A
        // failed query is non-fatal (fall back to broadcasts).
        try {
          const seeded = await queryPresence(socket, requestId);
          if (!active) return;
          setPeerPresence(seeded);
          peerPresenceRef.current = seeded;
        } catch (err) {
          console.log('[ac2] initial presence query failed (will rely on broadcasts)', err);
        }
        // Attempt the first p2p negotiation (gated on both peers being present).
        maybeNegotiateRef.current();
      } catch (err: any) {
        // A superseded run (cleanup fired, or a request was aborted) must do
        // nothing: a newer run owns recovery.
        if (!active || err?.name === 'AbortError') return;
        console.error('Failed to establish signaling socket:', err);
        updateSessionStatus(requestId, origin, 'failed');
        setIsLoading(false);
        setIsSocketConnected(false);
        socketReadyRef.current = false;
        // Surface the auth/network failure. Peer-presence gating (the peer
        // simply not being online) is handled by the presence path above.
        setError(err);
      } finally {
        // Only release the auth lock if this run is still the active one.
        if (active) authFlowInProgressRef.current = false;
      }
    }

    setupConnection();

    return () => {
      active = false;
      // Release the auth lock before the new run starts so it isn't blocked.
      authFlowInProgressRef.current = false;
      runAbort.abort();
      // The socket is going away for good (session change / unmount / explicit
      // rebuild): tear down the p2p transport too, then close the socket.
      clearTransport();
      closeSocket();
    };
  }, [origin, requestId, accounts.length > 0, keys.length > 0, socketNonce]);

  // Negotiate (and re-negotiate) the p2p transport over the PERSISTENT socket.
  // Keyed on the reconnect nonce so each manual/auto/presence-driven attempt
  // runs as its own superseded-safe run. Reuses `clientRef.current` (the
  // socket) and NEVER closes it on teardown — only the peer/data-channels are
  // torn down, so the app stays connected to the service between chats.
  useEffect(() => {
    // Nothing to negotiate until the persistent socket exists and is connected.
    if (!clientRef.current || !socketReadyRef.current) return;
    if (isConnectedRef.current) return;

    let active = true;
    const runAbort = new AbortController();
    const setupStartedAt = Date.now();

    async function negotiateTransport() {
      if (userStoppedRef.current) return;
      if (transportInFlightRef.current) return;
      const client = clientRef.current;
      if (!client) return;
      // Peers must both be present (deviceCount >= 2) before negotiating p2p.
      if (isPeerOffline(peerPresenceRef.current)) {
        console.log(
          `[ac2] negotiateTransport: aborted — peer not present (deviceCount=${
            peerPresenceRef.current?.deviceCount ?? 'unknown'
          })`,
        );
        setIsLoading(false);
        setPeerOffline(true);
        return;
      }

      console.log(
        `[ac2] negotiateTransport: opening p2p transport (nonce=${reconnectNonce}, deviceCount=${
          peerPresenceRef.current?.deviceCount ?? 'unknown'
        })`,
      );
      transportInFlightRef.current = true;
      setIsLoading(true);
      setError(null);
      // Clear any prior "not registered" state so a reconnect that succeeds in
      // registering re-enables the composer. If the agent is still unregistered
      // it re-pushes the blocking notice on connect, which re-sets the flag.
      setNotRegisteredState(null);

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

        // Presence is subscribed on the persistent socket (socket effect), so it
        // is intentionally NOT re-subscribed here.
        const { datachannel } = await createAc2Transport({
          requestId,
          signalClient: client,
          signal: runAbort.signal,
          onPeerConnection: (pc) => {
            // Stash the peer connection; the connectivity monitor is attached in
            // `onOpen`, once the channel is actually live (establishment-phase
            // failures are already covered by the transport's open deadline).
            peerConnectionRef.current = pc as unknown as MonitoredPeerConnection;
          },
          onSideChannel: (channel) => {
            console.log(`[ac2] Discovered channel: ${channel.label}`);
            if (channel.label === 'ac2-heartbeat') {
              heartbeatChannelRef.current = attachHeartbeatChannel(channel, {
                onInbound: () => {
                  if (!active) return;
                  wasBackgroundedRef.current = false;
                  lastInboundActivityRef.current = Date.now();
                  heartbeatMonitorRef.current?.noteInbound();
                  setLastHeartbeat(Date.now());
                },
              });
              return;
            }
            if (channel.label === 'ac2-stream') {
              streamChannelRef.current = channel;
              channel.onmessage = (event) => {
                if (!active) return;
                // Any inbound stream frame is proof of peer liveness.
                heartbeatMonitorRef.current?.noteInbound();
                if (typeof event.data === 'string') applyControlFrame(event.data);
              };
              channel.onopen = () => console.log('Stream channel opened');
              channel.onclose = () => console.log('Stream channel closed');
            }
          },
        });

        if (!active) {
          // This run was superseded while negotiation was still winding down.
          // Avoid hard-closing the native peer here: Android's WebRTC bridge may
          // still be asynchronously applying the remote description, and tearing
          // the peer down races that work and can crash with a null
          // `PeerConnectionObserver`. NEVER touch the persistent socket here.
          return;
        }

        dataChannelRef.current = datachannel;
        console.log(`[ac2] transport negotiated in ${Date.now() - setupStartedAt}ms`);

        // Wallet-side responders (`onSigningRequest` / `onKeyRequest`) are
        // intentionally NOT installed: inbound envelopes are mirrored into
        // `ac2MessagesStore` by `createAc2Client` and `app/chat.tsx` handles
        // approve/reject interactively against the visible store entry.
        const { client: ac2 } = createAc2Client({
          datachannel,
          origin,
          requestId,
          getAddress: () => addressRef.current,
          getActiveThid: () => activeThidRef.current,
          onInboundEnvelope: () => {
            updateSessionActivity(requestId, origin);
            wasBackgroundedRef.current = false;
            lastInboundActivityRef.current = Date.now();
            heartbeatMonitorRef.current?.noteInbound();
            setLastHeartbeat(Date.now());
          },
          onRawMessage: (raw: string) => {
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
            wasBackgroundedRef.current = false;
            lastInboundActivityRef.current = Date.now();
            heartbeatMonitorRef.current?.noteInbound();
            setLastHeartbeat(Date.now());
          },
          onOpen: () => {
            console.log(`Data channel opened in ${Date.now() - setupStartedAt}ms`);
            if (active) {
              deliberateCloseRef.current = false;
              wasBackgroundedRef.current = false;
              // Log the negotiated ICE path (direct/STUN/TURN) for this session.
              logCandidatePairRef.current('connected');
              // Watch the peer for connectivity loss (ICE disconnected/failed)
              // the SDK never surfaces — the DataChannel can stay "open" while
              // the underlying transport is dead. Route a failure through the
              // single recovery funnel; `() => active` makes a late callback
              // from a superseded run a no-op.
              if (peerMonitorDisposeRef.current) peerMonitorDisposeRef.current();
              peerMonitorDisposeRef.current = peerConnectionRef.current
                ? monitorPeerConnection(peerConnectionRef.current, {
                    onFailed: (reason) => failConnectionRef.current(reason, () => active),
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
                  const hb = heartbeatChannelRef.current;
                  const dc = dataChannelRef.current;
                  const channel =
                    hb && hb.readyState === 'open'
                      ? hb
                      : dc && dc.readyState === 'open'
                        ? dc
                        : null;
                  if (!channel) return;
                  // A growing send buffer means frames aren't draining to the
                  // peer — an early signal the transport is stalling before ICE
                  // even flips state.
                  if (channel.bufferedAmount > HEARTBEAT_BUFFERED_WARN_BYTES) {
                    console.warn(
                      `Heartbeat send buffer high (${channel.bufferedAmount} bytes) — transport may be stalling`,
                    );
                  }
                  try {
                    channel.send(channel === hb ? 'ping' : '');
                  } catch (err) {
                    console.warn('Heartbeat send failed; treating as a dropped connection', err);
                    failConnectionRef.current('send', () => active);
                  }
                },
                onTimeout: () => failConnectionRef.current('heartbeat', () => active),
              });
              heartbeatMonitorRef.current.start();
              if (autoReconnectTimerRef.current) {
                clearTimeout(autoReconnectTimerRef.current);
                autoReconnectTimerRef.current = null;
              }
              // Successful connection — clear the automatic-retry budget so a
              // future drop starts a fresh set of attempts.
              reconnectAttemptRef.current = 0;
              setReconnectAttempt(0);
              setIsReconnecting(false);
              // We've actually reached the peer — clear any "peer offline"
              // notice so the live chat is shown.
              setPeerOffline(false);
              setIsConnected(true);
              setIsLoading(false);
              setAc2Client(ac2);
              updateSessionStatus(requestId, origin, 'active');
            }
          },
          onClose: () => {
            console.log('Data channel closed');
            updateSessionStatus(requestId, origin, 'closed');
            // A deliberate teardown (reset / performReconnect / idle close) is
            // expected — consume the one-shot flag and don't treat it as a
            // failure. Everything else funnels through the single failure path.
            if (deliberateCloseRef.current) {
              deliberateCloseRef.current = false;
              return;
            }
            failConnectionRef.current('channel', () => active);
          },
        });
        ac2ClientRef.current = ac2;
      } catch (err: any) {
        // A superseded run (cleanup/reconnect fired, or the transport was
        // aborted) must do nothing: the newer run owns all recovery.
        if (!active || err?.name === 'AbortError') return;
        console.error('Failed to negotiate transport:', err);
        updateSessionStatus(requestId, origin, 'failed');
        // Funnel through the single failure path: it tears down the
        // partially-established peer (via `clearTransport`, socket preserved)
        // and hands off to the bounded auto-reconnect scheduler, surfacing the
        // terminal error + manual fallback only once the retry budget is spent.
        failConnectionRef.current('setup', () => active, err);
      } finally {
        // Only release the negotiation lock if this run is still the active one.
        if (active) transportInFlightRef.current = false;
      }
    }

    negotiateTransport();

    return () => {
      active = false;
      // Release the negotiation lock before the next run starts (the `finally`
      // above is guarded by `active`, now false, so it won't reset it itself).
      transportInFlightRef.current = false;
      // Stop the watchdog and detach the connectivity monitor before the peer
      // is closed below, so neither observes the teardown as a failure and no
      // timers/listeners dangle.
      if (heartbeatMonitorRef.current) {
        heartbeatMonitorRef.current.stop();
        heartbeatMonitorRef.current = null;
      }
      if (peerMonitorDisposeRef.current) {
        peerMonitorDisposeRef.current();
        peerMonitorDisposeRef.current = null;
      }
      peerConnectionRef.current = null;
      const hadEstablishedTransport = !!(dataChannelRef.current || ac2ClientRef.current);
      runAbort.abort();
      if (autoReconnectTimerRef.current) {
        clearTimeout(autoReconnectTimerRef.current);
        autoReconnectTimerRef.current = null;
      }
      if (ac2ClientRef.current) {
        try {
          ac2ClientRef.current.close();
        } catch {
          /* noop */
        }
        ac2ClientRef.current = null;
      }
      if (dataChannelRef.current) {
        dataChannelRef.current.close();
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
      const client = clientRef.current;
      if (client) {
        // Only hard-close the peer once this run owned an established transport.
        // For a superseded run, `runAbort.abort()` above already cancelled the
        // logical attempt; force-closing the native peer here can race
        // Android's in-flight `setRemoteDescription` and crash. NEVER close the
        // socket here — it is owned by the socket effect and must stay alive.
        if (hadEstablishedTransport) {
          try {
            client.peerClient?.close();
          } catch {
            /* noop */
          }
        }
        client.peerClient = undefined;
        // Detach the per-negotiation listeners so reusing this socket for the
        // next attempt doesn't accumulate duplicate handlers.
        try {
          client.off('data-channel');
        } catch {
          /* noop */
        }
        const s = client.socket as any;
        try {
          s?.off?.('offer-candidate');
          s?.off?.('answer-candidate');
          s?.off?.('offer-description');
          s?.off?.('answer-description');
        } catch {
          /* noop */
        }
      }
    };
  }, [origin, requestId, reconnectNonce]);

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
    isConnected,
    isReconnecting,
    reconnectAttempt,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
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
