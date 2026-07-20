import { useProvider } from '@/hooks/useProvider';
import type { HeartbeatMonitor, MonitoredPeerConnection } from '@/lib/ac2';
import {
  attachHeartbeatChannel,
  createAc2Client,
  createAc2Transport,
  createHeartbeatMonitor,
  DEFAULT_THID,
  describeSelectedCandidatePair,
  generateThid,
  monitorPeerConnection,
  sendConversationClose,
  sendConversationOpen,
  summarizeSelectedCandidatePair,
} from '@/lib/ac2';
import { createControlFrameHandler } from '@/lib/ac2/streamControlFrame';
import { findWalletAccount } from '@/lib/keystore/wallet-account';
import { classifyConnectionFailure } from '@/lib/liquid-auth/connection-errors';
import { authenticateLiquidAuth } from '@/lib/liquid-auth/flow';
import { addressMatchesKey, sessionAddressFromData } from '@/lib/liquid-auth/helpers';
import {
  loadPairingCredential,
  type DurablePairingCredential,
} from '@/lib/liquid-auth/pairing-credentials';
import { closeSignalClient, closeSignalClientWhenSafe } from '@/lib/liquid-auth/signal-client';
import { addAc2Message, clearAc2MessagesByThread } from '@/stores/ac2Messages';
import { accountsStore } from '@/stores/accounts';
import { keyStore } from '@/stores/keystore';
import { addMessage, clearMessagesByThread } from '@/stores/messages';
import {
  addSession,
  clearSessionPairingCredential,
  revokeSessionPairing,
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

const AUTO_RECONNECT_INITIAL_DELAY_MS = 1000;
const AUTO_RECONNECT_MAX_DELAY_MS = 30000;
// A resumed mobile radio can take several seconds to restore its route even
// while the native DataChannel remains viable. Give the explicit ping/pong
// probe a full network-recovery window before replacing the peer.
const FOREGROUND_HEALTH_TIMEOUT_MS = 15000;
// Hard ceiling on any auth/session HTTP request during setup. React Native's
// `fetch` has NO default timeout, so a request issued while the network is
// still recovering from a drop (exactly when auto-reconnect fires) can stall
// forever. Bounding it turns a silent hang into a rejection that flows into the
// retry state machine instead.
const REQUEST_TIMEOUT_MS = 15000;
type PairingReauthenticationState =
  | 'idle'
  | 'pending'
  | 'authenticating'
  | 'recovered'
  | 'exhausted'
  | 'revoked';
// How often to ping the peer over `ac2-heartbeat`, and how long without ANY
// inbound frame (pong or other traffic) before the peer is presumed dead even
// though ICE may still report `connected` (a silent stall). ~2 missed pongs.
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 45000;
// A heartbeat-channel send buffer above this suggests frames aren't draining to
// the peer (a stalling transport) — logged as an early diagnostic.
const HEARTBEAT_BUFFERED_WARN_BYTES = 256 * 1024;

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
  error: Error | null;
  isError: boolean;
  isLoading: boolean;
  isConnected: boolean;
  /** True while automatic reconnect attempts are pending or in flight. */
  isReconnecting: boolean;
  /** Current automatic reconnect attempt (1-based); `0` when not retrying. */
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
}

interface UseConnectionOptions {
  /**
   * Allow creating a brand-new passkey via attestation when none exists for
   * the origin. Only the initial scan flow opts in; reconnects require an
   * existing passkey and otherwise surface an error.
   */
  allowPasskeyCreation?: boolean;
  /** Called once fresh-pairing credential creation has completed successfully. */
  onPasskeyCreationConsumed?: () => void;
}

export function useConnection(
  origin: string,
  requestId: string,
  options: UseConnectionOptions = {},
): UseConnectionResult {
  const { accounts, keys, key, passkey } = useProvider();
  const allowPasskeyCreation = options.allowPasskeyCreation ?? false;
  const onPasskeyCreationConsumed = options.onPasskeyCreationConsumed;
  const allowPasskeyCreationRef = useRef(allowPasskeyCreation);
  allowPasskeyCreationRef.current = allowPasskeyCreation;
  const onPasskeyCreationConsumedRef = useRef(onPasskeyCreationConsumed);
  onPasskeyCreationConsumedRef.current = onPasskeyCreationConsumed;
  const providerKeyRef = useRef(key);
  providerKeyRef.current = key;
  const providerPasskeyRef = useRef(passkey);
  providerPasskeyRef.current = passkey;
  const accountsLoaded = accounts.length > 0;
  const keysLoaded = keys.length > 0;

  const [isConnected, setIsConnected] = useState(false);
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const [address, setAddress] = useState<string | null>(null);
  const addressRef = useRef<string | null>(null);

  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const [error, setError] = useState<Error | null>(null);
  // Auto-reconnect progress surfaced to the UI. Transport failures retry
  // indefinitely; user/credential errors remain explicit and interactive.
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  // Ref mirror of the attempt counter so the retry scheduler can read/increment
  // it synchronously without racing React state batching.
  const reconnectAttemptRef = useRef(0);
  // Bumped by `reconnect()` to re-trigger the connection effect on demand.
  const [reconnectNonce, setReconnectNonce] = useState(0);

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
  // A completed legacy cookie-based auth remains usable for transport retries
  // during this mount even when an older server did not return a v2 pairing.
  const legacyAuthCompletedRef = useRef(false);
  // Ignore one `onClose` when the transport was intentionally torn down.
  const deliberateCloseRef = useRef(false);
  // Set when the user explicitly disconnects (`reset()`); blocks the
  // foreground auto-reconnect from resurrecting a session they chose to stop.
  const userStoppedRef = useRef(false);
  // Credential cancellation/revocation requires an explicit user action. It
  // must not be retried by an AppState transition and reopen biometrics.
  const automaticReconnectBlockedRef = useRef(false);
  // A rejected (but not revoked) durable credential gets exactly one automatic
  // foreground WebAuthn refresh. Transport retries after a successful refresh
  // remain safe because they reuse the replacement credential/cookie.
  const pairingReauthenticationStateRef = useRef<PairingReauthenticationState>('idle');
  // The active setup controller is also visible to the AppState listener so a
  // background transition cancels pending HTTP/signaling/credential results.
  const setupAbortControllerRef = useRef<AbortController | null>(null);
  // One-shot delayed reconnect. A new attempt is scheduled only after the
  // previous one reaches a terminal setup/transport event.
  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foregroundHealthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last observed `AppState`, so the foreground listener only reacts to a real
  // background/inactive -> active transition (not active -> active repeats).
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

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
  // Threads the agent advertised on connect (`conversations` control frame).
  const [remoteThreads, setRemoteThreads] = useState<
    { thid: string; title?: string; updatedAt?: number }[]
  >([]);

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
    const hadEstablishedTransport = !!(dataChannelRef.current || ac2ClientRef.current);
    if (foregroundHealthTimerRef.current) {
      clearTimeout(foregroundHealthTimerRef.current);
      foregroundHealthTimerRef.current = null;
    }
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
    if (clientRef.current) {
      try {
        // Disconnect signaling for every teardown, but only hard-close an
        // established peer. During negotiation Android may still be applying
        // a remote description, and closing that native peer can race the
        // bridge. Established transports must close the peer so the agent does
        // not retain an obsolete ICE session for this requestId.
        if (hadEstablishedTransport) closeSignalClient(clientRef.current, true);
        else void closeSignalClientWhenSafe(clientRef.current);
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
    pairingReauthenticationStateRef.current = 'idle';
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    if (foregroundHealthTimerRef.current) {
      clearTimeout(foregroundHealthTimerRef.current);
      foregroundHealthTimerRef.current = null;
    }
    clearTransport();
    deliberateCloseRef.current = false;
    setActiveStreamText('');
    setAgentPresence(null);
    setAgentPresenceDetail(null);
    isConnectedRef.current = false;
    setIsConnected(false);
    isLoadingRef.current = false;
    setIsLoading(false);
    setIsReconnecting(false);
    setReconnectAttempt(0);
    setError(null);
    updateSessionStatus(requestId, origin, 'closed');
  }, [requestId, origin, clearTransport]);

  // Core reconnect primitive: tear down any stale transport (so the connection
  // effect's guard doesn't short-circuit), flip into the loading/connecting
  // state, and bump the nonce to re-run setup. Deliberately does NOT touch the
  // retry budget so it can back both manual and automatic reconnects.
  const performReconnect = useCallback(() => {
    if (userStoppedRef.current || automaticReconnectBlockedRef.current) return;
    if (AppState.currentState !== 'active') {
      isConnectedRef.current = false;
      setIsConnected(false);
      isLoadingRef.current = false;
      setIsLoading(false);
      setIsReconnecting(true);
      return;
    }
    deliberateCloseRef.current = true;
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    clearTransport();
    deliberateCloseRef.current = false;
    authFlowInProgressRef.current = false;
    // Reset both liveness clocks so the fresh attempt isn't judged idle.
    lastInboundActivityRef.current = Date.now();
    lastLocalActivityRef.current = Date.now();
    setError(null);
    isConnectedRef.current = false;
    setIsConnected(false);
    isLoadingRef.current = true;
    setIsLoading(true);
    setIsReconnecting(reconnectAttemptRef.current > 0);
    setReconnectNonce((n) => n + 1);
  }, [clearTransport]);
  const performReconnectRef = useRef(performReconnect);
  performReconnectRef.current = performReconnect;

  // Manually re-establish a dropped connection (user pressed "Reconnect").
  // Reset the backoff so an explicit request starts immediately.
  const reconnect = useCallback(() => {
    if (pairingReauthenticationStateRef.current === 'revoked') {
      Alert.alert(
        'Connection Removed',
        'This pairing was removed by the agent. Scan a new pairing code to connect again.',
        [{ text: 'OK' }],
      );
      return;
    }
    userStoppedRef.current = false;
    automaticReconnectBlockedRef.current = false;
    if (pairingReauthenticationStateRef.current === 'exhausted') {
      pairingReauthenticationStateRef.current = 'pending';
      legacyAuthCompletedRef.current = false;
    }
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setIsReconnecting(false);
    performReconnect();
  }, [performReconnect]);

  // Schedule the next serialized automatic reconnect with capped exponential
  // backoff and jitter. The sequence is deliberately unbounded: a durable
  // pairing remains reconnectable after any length of disconnection. Timers
  // pause while the app is backgrounded and resume on foreground.
  const scheduleAutoReconnect = useCallback((): boolean => {
    if (userStoppedRef.current || automaticReconnectBlockedRef.current) return false;
    if (autoReconnectTimerRef.current) return true;

    setIsReconnecting(true);
    isLoadingRef.current = false;
    setIsLoading(false);
    if (AppState.currentState !== 'active') return true;

    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    setReconnectAttempt(attempt);
    const exponentialDelay = Math.min(
      AUTO_RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(attempt - 1, 10),
      AUTO_RECONNECT_MAX_DELAY_MS,
    );
    const jitteredDelay = Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
    autoReconnectTimerRef.current = setTimeout(() => {
      autoReconnectTimerRef.current = null;
      performReconnectRef.current();
    }, jitteredDelay);
    return true;
  }, []);
  const scheduleAutoReconnectRef = useRef(scheduleAutoReconnect);
  scheduleAutoReconnectRef.current = scheduleAutoReconnect;

  // Single funnel for an unexpected connection failure. Later async detectors
  // (ICE state, heartbeat watchdog, send errors) all route through this so
  // teardown + durable reconnect happen in exactly one place. `isCurrent`
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
      isConnectedRef.current = false;
      setIsConnected(false);
      // Drop every stale transport ref so the next reconnect isn't blocked by
      // the connection effect's guard. Mark this close deliberate so the data
      // channel's close callback cannot recursively schedule the same failure.
      deliberateCloseRef.current = true;
      clearTransport();
      deliberateCloseRef.current = false;
      // Kick off (or continue) the unbounded, serialized retry sequence. This
      // returns false only when the user stopped the session or credential
      // interaction explicitly blocked automatic recovery.
      if (!scheduleAutoReconnectRef.current()) {
        setIsReconnecting(false);
        setIsLoading(false);
        if (error) {
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

  // `monitorPeerConnection` evaluates the current native state synchronously.
  // Install it transactionally so an already-closed peer cannot fail the
  // connection during attachment and then be committed as healthy afterward.
  const attachPeerMonitorSafely = useCallback((isCurrent: () => boolean): boolean => {
    if (!isCurrent()) return false;
    const peer = peerConnectionRef.current;
    if (!peer) return true;

    if (peerMonitorDisposeRef.current) {
      peerMonitorDisposeRef.current();
      peerMonitorDisposeRef.current = null;
    }

    let failedDuringAttach = false;
    const dispose = monitorPeerConnection(peer, {
      onFailed: (reason) => {
        failedDuringAttach = true;
        failConnectionRef.current(reason, isCurrent);
      },
    });
    if (failedDuringAttach || !isCurrent() || peerConnectionRef.current !== peer) {
      dispose();
      return false;
    }

    peerMonitorDisposeRef.current = dispose;
    return true;
  }, []);

  // Live mirrors of the connection state so the AppState listener can read the
  // current values without being torn down/re-subscribed on every change (and
  // without capturing a stale closure).
  // Resume dropped sessions on foreground and actively probe connections that
  // may have gone stale while the native runtime suspended JavaScript.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'background' || nextState === 'inactive') {
        if (autoReconnectTimerRef.current) {
          clearTimeout(autoReconnectTimerRef.current);
          autoReconnectTimerRef.current = null;
        }
        if (foregroundHealthTimerRef.current) {
          clearTimeout(foregroundHealthTimerRef.current);
          foregroundHealthTimerRef.current = null;
        }
        // React Native suspends JS timers in the background. Pause both
        // watchdogs so their queued deadlines cannot fire immediately on
        // resume and destroy a native peer that survived suspension.
        heartbeatMonitorRef.current?.stop();
        if (peerMonitorDisposeRef.current) {
          peerMonitorDisposeRef.current();
          peerMonitorDisposeRef.current = null;
        }
        // iOS reports `inactive` while presenting system passkey/Face ID UI.
        // Cancelling setup here aborts the very credential operation that made
        // the app inactive and can reopen biometrics on the next `active`
        // transition. Only a true background transition cancels setup.
        if (nextState === 'inactive') return;
        if (!isConnectedRef.current && setupAbortControllerRef.current) {
          setupAbortControllerRef.current.abort();
          deliberateCloseRef.current = true;
          clearTransport();
          deliberateCloseRef.current = false;
          authFlowInProgressRef.current = false;
        }
        if (
          !isConnectedRef.current &&
          !userStoppedRef.current &&
          !automaticReconnectBlockedRef.current
        ) {
          isLoadingRef.current = false;
          setIsLoading(false);
          setIsReconnecting(true);
        }
        return;
      }

      if (nextState !== 'active' || prevState === 'active') return;
      if (userStoppedRef.current || automaticReconnectBlockedRef.current) return;

      if (isConnectedRef.current) {
        const heartbeat = heartbeatChannelRef.current;
        const control = dataChannelRef.current;
        if (!control || control.readyState !== 'open') {
          performReconnectRef.current();
          return;
        }

        // Older peers may only expose `ac2-v1`. Keep that supported fallback
        // alive across foreground transitions and let the ICE monitor judge the
        // native peer; there is no ping/pong contract to probe on this channel.
        if (!heartbeat) {
          heartbeatMonitorRef.current?.start();
          attachPeerMonitorSafely(
            () => AppState.currentState === 'active' && isConnectedRef.current,
          );
          return;
        }

        if (heartbeat.readyState !== 'open') {
          performReconnectRef.current();
          return;
        }

        // `start()` re-anchors the heartbeat deadline to foreground time. ICE
        // monitoring resumes only after the pong below proves the radio route
        // has recovered.
        heartbeatMonitorRef.current?.start();
        const inboundBeforeProbe = lastInboundActivityRef.current;
        try {
          heartbeat.send('ping');
        } catch {
          performReconnectRef.current();
          return;
        }
        foregroundHealthTimerRef.current = setTimeout(() => {
          foregroundHealthTimerRef.current = null;
          if (
            AppState.currentState === 'active' &&
            isConnectedRef.current &&
            lastInboundActivityRef.current <= inboundBeforeProbe
          ) {
            performReconnectRef.current();
          }
        }, FOREGROUND_HEALTH_TIMEOUT_MS);
        return;
      }

      if (authFlowInProgressRef.current || clientRef.current || isLoadingRef.current) {
        return;
      }

      performReconnectRef.current();
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [origin, requestId, clearTransport, attachPeerMonitorSafely]);

  const send = useCallback(
    (text: string) => {
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
    // Aborts every in-flight setup request when this run is superseded (a newer
    // reconnect/nonce bump) or unmounted, so a stalled request from an obsolete
    // attempt can't linger and race a fresh one.
    const runAbort = new AbortController();
    setupAbortControllerRef.current = runAbort;

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
      return fetch(input, {
        ...init,
        credentials: init.credentials ?? 'include',
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timer);
        runAbort.signal.removeEventListener('abort', onRunAbort);
      });
    };

    async function setupConnection() {
      if (!origin || !requestId) {
        console.error('Missing origin or requestId');
        isLoadingRef.current = false;
        setIsLoading(false);
        return;
      }

      // Never launch a passkey/biometric interaction from the background.
      // A paused reconnect is resumed by the AppState listener above.
      if (AppState.currentState !== 'active') {
        isLoadingRef.current = false;
        setIsLoading(false);
        setIsReconnecting(true);
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

      // If we are already connecting or connected, don't start again
      if (clientRef.current || isConnectedRef.current) {
        return;
      }

      isLoadingRef.current = true;
      setIsLoading(true);
      setError(null);
      authFlowInProgressRef.current = true;
      let attemptedDurablePairing = false;

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
        if (existingSession?.pairingStatus === 'revoked') {
          // Revocation is durable too. Do not turn an explicitly removed
          // pairing into a fresh WebAuthn prompt after a remount/app restart.
          pairingReauthenticationStateRef.current = 'revoked';
          automaticReconnectBlockedRef.current = true;
          isLoadingRef.current = false;
          setIsLoading(false);
          setIsReconnecting(false);
          setError(
            new Error(
              'This pairing was removed by the agent. Scan a new pairing code to connect again.',
            ),
          );
          return;
        }
        if (!existingSession) {
          // Persist the connection durably (no TTL) so it survives app
          // restarts and can be reconnected/renegotiated later using the same
          // requestId — mirroring how the OpenClaw plugin persists connections.
          addSession({ id: requestId, origin, status: 'closed' });
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
        setAddress(walletAddress);
        addressRef.current = walletAddress;

        // A v2 pairing is the durable authorization. It intentionally bypasses
        // `/auth/session` and WebAuthn on every transport reconnect, including
        // after process restarts or long periods offline.
        let pairingCredential: DurablePairingCredential | null = await loadPairingCredential(
          origin,
          requestId,
          existingSession?.pairing,
        );
        if (!active) return;
        attemptedDurablePairing = pairingCredential !== null;

        // Older servers may not issue a durable pairing yet. Authenticate at
        // most once during this mounted connection so a transient transport
        // failure never re-opens biometrics while the legacy cookie is valid.
        if (!pairingCredential && !legacyAuthCompletedRef.current) {
          if (AppState.currentState !== 'active') {
            isLoadingRef.current = false;
            setIsLoading(false);
            setIsReconnecting(true);
            return;
          }
          if (pairingReauthenticationStateRef.current === 'pending') {
            pairingReauthenticationStateRef.current = 'authenticating';
          }

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
            } catch (sessionError) {
              console.warn('Unable to parse existing auth session response:', sessionError);
            }
          }

          if (AppState.currentState !== 'active') {
            isLoadingRef.current = false;
            setIsLoading(false);
            setIsReconnecting(true);
            return;
          }

          const passkeyCreationWasAllowed = allowPasskeyCreationRef.current;
          const consumePasskeyCreation = () => {
            allowPasskeyCreationRef.current = false;
            onPasskeyCreationConsumedRef.current?.();
          };
          const authResult = await authenticateLiquidAuth({
            origin,
            requestId,
            foundKey,
            walletAddress,
            currentKeys,
            initialSessionData,
            initialSessionAddress,
            existingSessionPasskeyCredentialId: existingSession?.passkeyCredentialId,
            allowPasskeyCreation: allowPasskeyCreationRef.current,
            key: providerKeyRef.current,
            passkey: providerPasskeyRef.current,
            setAddress,
            addressRef,
            fetchWithTimeout,
            signal: runAbort.signal,
            isActive: () => active,
            onPasskeyCreated: consumePasskeyCreation,
          });
          if (authResult.superseded || !active) return;
          pairingCredential = authResult.pairing ?? null;
          legacyAuthCompletedRef.current = true;
          if (pairingReauthenticationStateRef.current === 'authenticating') {
            pairingReauthenticationStateRef.current = 'recovered';
          }
          // Assertion can also complete a scanner-initiated flow. Attestation
          // consumes this earlier, immediately after native credential creation.
          if (passkeyCreationWasAllowed && allowPasskeyCreationRef.current) {
            consumePasskeyCreation();
          }

          // Preserve the legacy session address only when it belongs to the
          // wallet key selected for this connection.
          const finalSessionCheck = await fetchWithTimeout(`${origin}/auth/session`);
          if (!active) return;
          if (finalSessionCheck.ok) {
            const sessionData = await finalSessionCheck.json();
            if (!active) return;
            const sessionAddress = sessionAddressFromData(sessionData);
            if (sessionAddress && addressMatchesKey(sessionAddress, foundKey)) {
              setAddress(sessionAddress);
              addressRef.current = sessionAddress;
            }
          }
        }

        const options: any = {
          autoConnect: true,
          withCredentials: true,
          // Prefer a real WebSocket; retain polling as a compatibility fallback
          // for constrained networks instead of forcing all mobile traffic onto
          // fragile long-poll XHR.
          transports: ['websocket', 'polling'],
          tryAllTransports: true,
        };

        if (pairingCredential) {
          options.auth = pairingCredential;
        } else if (Platform.OS === 'ios') {
          // Legacy cookie-only servers need the native Engine.IO XHR bridge.
          // Durable v2 pairing above stays WebSocket-first and never takes this
          // polling path, which avoids reintroducing the observed XHR fragility.
          options.transports = [EngineIoXHR];
          delete options.tryAllTransports;
        } else if (NativeModules.CookieModule) {
          const cookie = await NativeModules.CookieModule.getCookie(origin);
          if (!active) return;
          if (cookie) {
            options.extraHeaders = { Cookie: cookie };
            options.transports = ['polling'];
            options.transportOptions = {
              polling: { extraHeaders: { Cookie: cookie } },
            };
            delete options.tryAllTransports;
          }
        }

        const client = new SignalClient(origin, options);

        if (!active) return;

        clientRef.current = client;
        //@ts-ignore
        client.authenticated = true;

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
        });

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
                  const now = Date.now();
                  lastInboundActivityRef.current = now;
                  heartbeatMonitorRef.current?.noteInbound();
                  if (foregroundHealthTimerRef.current) {
                    clearTimeout(foregroundHealthTimerRef.current);
                    foregroundHealthTimerRef.current = null;
                  }
                  setLastHeartbeat(now);
                  // ICE monitoring is paused while backgrounded so a suspended
                  // grace timer cannot kill a viable peer on resume. A pong is
                  // proof the radio path has recovered, so it is now safe to
                  // resume terminal/disconnected peer-state monitoring.
                  if (AppState.currentState === 'active' && !peerMonitorDisposeRef.current) {
                    attachPeerMonitorSafely(() => active && isConnectedRef.current);
                  }
                },
              });
              return;
            }
            if (channel.label === 'ac2-stream') {
              streamChannelRef.current = channel;
              channel.onmessage = (event) => {
                if (!active) return;
                const now = Date.now();
                lastInboundActivityRef.current = now;
                heartbeatMonitorRef.current?.noteInbound();
                setLastHeartbeat(now);
                if (typeof event.data === 'string') applyControlFrame(event.data);
              };
              channel.onopen = () => console.log('Stream channel opened');
              channel.onclose = () => console.log('Stream channel closed');
            }
          },
        });

        if (!active) {
          // This setup run was superseded while negotiation was still winding
          // down. Avoid hard-closing the native peer here: Android's WebRTC
          // bridge may still be asynchronously applying the remote
          // description, and tearing the peer down races that work and can
          // crash with a null `PeerConnectionObserver`.
          void closeSignalClientWhenSafe(client);
          return;
        }

        dataChannelRef.current = datachannel;
        console.log(`[ac2] transport negotiated in ${Date.now() - setupStartedAt}ms`);

        // Wallet-side responders (`onSigningRequest` / `onKeyRequest`) are
        // intentionally NOT installed: inbound envelopes are mirrored into
        // `ac2MessagesStore` by `createAc2Client` and `app/chat.tsx` handles
        // approve/reject interactively against the visible store entry.
        let openClient: Ac2Client | null = null;
        let openArrivedBeforeClient = false;
        const finalizeOpen = (clientForRun: Ac2Client) => {
          const isCurrentTransport = () =>
            active &&
            dataChannelRef.current === datachannel &&
            ac2ClientRef.current === clientForRun;
          if (!isCurrentTransport() || isConnectedRef.current) return;

          console.log(`Data channel opened in ${Date.now() - setupStartedAt}ms`);
          deliberateCloseRef.current = false;
          // Log the negotiated ICE path (direct/STUN/TURN) for this session.
          logCandidatePairRef.current('connected');
          // The peer monitor evaluates synchronously. If it observes a terminal
          // state, `failConnection` clears these refs and this finalizer stops
          // before publishing a false connected state.
          if (!attachPeerMonitorSafely(isCurrentTransport)) return;

          // Start the foreground-only liveness watchdog. AppState pauses it
          // while JavaScript is suspended and re-anchors it on resume.
          heartbeatMonitorRef.current?.stop();
          heartbeatMonitorRef.current = createHeartbeatMonitor({
            intervalMs: HEARTBEAT_INTERVAL_MS,
            timeoutMs: heartbeatChannelRef.current ? HEARTBEAT_TIMEOUT_MS : Infinity,
            send: () => {
              const hb = heartbeatChannelRef.current;
              const dc = dataChannelRef.current;
              const channel =
                hb && hb.readyState === 'open' ? hb : dc && dc.readyState === 'open' ? dc : null;
              if (!channel) return;
              // A growing send buffer means frames aren't draining to the peer
              // — an early signal the transport is stalling before ICE flips.
              if (channel.bufferedAmount > HEARTBEAT_BUFFERED_WARN_BYTES) {
                console.warn(
                  `Heartbeat send buffer high (${channel.bufferedAmount} bytes) — transport may be stalling`,
                );
              }
              try {
                channel.send(channel === hb ? 'ping' : '');
              } catch (err) {
                console.warn('Heartbeat send failed; treating as a dropped connection', err);
                failConnectionRef.current('send', isCurrentTransport);
              }
            },
            onTimeout: () => failConnectionRef.current('heartbeat', isCurrentTransport),
          });
          heartbeatMonitorRef.current.start();

          // `start()` sends synchronously and can discover a dead native
          // channel. Never commit success if that failure already cleared us.
          if (!isCurrentTransport()) return;
          if (autoReconnectTimerRef.current) {
            clearTimeout(autoReconnectTimerRef.current);
            autoReconnectTimerRef.current = null;
          }
          reconnectAttemptRef.current = 0;
          automaticReconnectBlockedRef.current = false;
          pairingReauthenticationStateRef.current = 'idle';
          lastInboundActivityRef.current = Date.now();
          setReconnectAttempt(0);
          setIsReconnecting(false);
          isConnectedRef.current = true;
          setIsConnected(true);
          isLoadingRef.current = false;
          setIsLoading(false);
          setError(null);
          setAc2Client(clientForRun);
          updateSessionStatus(requestId, origin, 'active');
        };

        const { client: ac2 } = createAc2Client({
          datachannel,
          origin,
          requestId,
          getAddress: () => addressRef.current,
          getActiveThid: () => activeThidRef.current,
          onInboundEnvelope: () => {
            updateSessionActivity(requestId, origin);
            const now = Date.now();
            lastInboundActivityRef.current = now;
            heartbeatMonitorRef.current?.noteInbound();
            setLastHeartbeat(now);
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
            const now = Date.now();
            lastInboundActivityRef.current = now;
            heartbeatMonitorRef.current?.noteInbound();
            setLastHeartbeat(now);
          },
          onOpen: () => {
            if (!openClient) {
              openArrivedBeforeClient = true;
              return;
            }
            finalizeOpen(openClient);
          },
          onClose: () => {
            // Ignore a delayed close from a transport that cleanup already
            // detached (or that a newer reconnect has replaced).
            if (!active || dataChannelRef.current !== datachannel) return;
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
        openClient = ac2;
        ac2ClientRef.current = ac2;
        if (openArrivedBeforeClient) finalizeOpen(ac2);
      } catch (err: any) {
        // A superseded run (cleanup/reconnect fired, or the transport was
        // aborted) must do nothing: `clientRef` now points at the newer run's
        // client, so tearing it down here would kill a healthy connection and
        // clobber its session status. The newer run owns all recovery.
        if (!active || err?.name === 'AbortError') return;
        console.error('Failed to setup connection:', err);
        const failureKind = classifyConnectionFailure(err, attemptedDurablePairing);
        const reauthenticationFailed = pairingReauthenticationStateRef.current === 'authenticating';
        if (
          failureKind === 'pairing-revoked' ||
          failureKind === 'credential-interaction' ||
          reauthenticationFailed
        ) {
          automaticReconnectBlockedRef.current = true;
        }
        isConnectedRef.current = false;
        setIsConnected(false);
        deliberateCloseRef.current = true;
        clearTransport();
        deliberateCloseRef.current = false;
        if (failureKind === 'pairing-revoked') {
          pairingReauthenticationStateRef.current = 'revoked';
          revokeSessionPairing(requestId, origin);
          setIsReconnecting(false);
          setError(err);
          isLoadingRef.current = false;
          setIsLoading(false);
          Alert.alert(
            'Connection Removed',
            'This pairing was removed by the agent. Scan a new pairing code to connect again.',
            [{ text: 'OK' }],
          );
        } else if (failureKind === 'pairing-unauthorized') {
          // An unauthorized credential is stale/invalid, not proof that the
          // agent removed the pairing. Clear only the local secret/reference,
          // then allow one foreground passkey assertion to mint a replacement.
          await clearSessionPairingCredential(requestId, origin);
          legacyAuthCompletedRef.current = false;
          if (!active) return;

          if (pairingReauthenticationStateRef.current === 'idle') {
            pairingReauthenticationStateRef.current = 'pending';
            reconnectAttemptRef.current = 0;
            setReconnectAttempt(0);
            setError(null);
            isLoadingRef.current = false;
            setIsLoading(false);
            setIsReconnecting(true);
            updateSessionStatus(requestId, origin, 'closed');

            if (AppState.currentState === 'active') {
              performReconnectRef.current();
            }
          } else {
            pairingReauthenticationStateRef.current = 'exhausted';
            automaticReconnectBlockedRef.current = true;
            updateSessionStatus(requestId, origin, 'failed');
            setIsReconnecting(false);
            setError(err);
            isLoadingRef.current = false;
            setIsLoading(false);
            Alert.alert(
              'Authentication Required',
              'The saved connection credential could not be refreshed. Tap Reconnect to authenticate again.',
              [{ text: 'OK' }],
            );
          }
        } else if (failureKind === 'credential-interaction' || reauthenticationFailed) {
          if (reauthenticationFailed) {
            pairingReauthenticationStateRef.current = 'exhausted';
          }
          updateSessionStatus(requestId, origin, 'failed');
          setIsReconnecting(false);
          setError(err);
          isLoadingRef.current = false;
          setIsLoading(false);
          Alert.alert(
            'Connection Failed',
            err.message || 'Failed to setup connection to the peer',
            [{ text: 'OK' }],
          );
        } else {
          updateSessionStatus(requestId, origin, 'closed');
          failConnectionRef.current('setup', () => active, err);
        }
      } finally {
        // Only release the auth lock if this run is still the active one.
        // If cleanup already ran (`active = false`), it has already reset the
        // lock and a new run may have acquired it — clearing it here would
        // unblock a spurious third attempt.
        if (active) authFlowInProgressRef.current = false;
      }
    }

    setupConnection();

    return () => {
      active = false;
      // Release the auth lock before the new run starts so it isn't blocked by
      // the guard in `setupConnection`. The `finally` block is guarded by
      // `active` and will not clobber the new run's lock once it acquires it.
      authFlowInProgressRef.current = false;
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
      if (setupAbortControllerRef.current === runAbort) {
        setupAbortControllerRef.current = null;
      }
      if (autoReconnectTimerRef.current) {
        clearTimeout(autoReconnectTimerRef.current);
        autoReconnectTimerRef.current = null;
      }
      if (foregroundHealthTimerRef.current) {
        clearTimeout(foregroundHealthTimerRef.current);
        foregroundHealthTimerRef.current = null;
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
        streamChannelRef.current.close();
        streamChannelRef.current = null;
      }
      if (heartbeatChannelRef.current) {
        heartbeatChannelRef.current.close();
        heartbeatChannelRef.current = null;
      }
      if (clientRef.current) {
        // Always disconnect signaling. Only hard-close the native peer when
        // this effect owns an established transport; superseded setup runs can
        // still have Android `setRemoteDescription` work in flight.
        if (hadEstablishedTransport) closeSignalClient(clientRef.current, true);
        else void closeSignalClientWhenSafe(clientRef.current);
        clientRef.current = null;
      }
    };
  }, [
    origin,
    requestId,
    accountsLoaded,
    keysLoaded,
    reconnectNonce,
    clearTransport,
    attachPeerMonitorSafely,
  ]);

  return {
    session,
    address,
    send,
    sendAc2,
    ac2Client,
    activeStreamText,
    agentPresenceDetail,
    agentPresence,
    error,
    isError: !!error,
    isLoading,
    isConnected,
    isReconnecting,
    reconnectAttempt,
    lastHeartbeat,
    reset,
    reconnect,
    activeThid,
    openConversation,
    closeConversation,
    remoteThreads,
  };
}
