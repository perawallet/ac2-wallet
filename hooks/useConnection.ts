import { ConnectionPhase, useConnectionRecovery } from '@/hooks/useConnectionRecovery';
import { useLivenessMonitors, type UseLivenessMonitorsResult } from '@/hooks/useLivenessMonitors';
import { useProvider } from '@/hooks/useProvider';
import type { MonitoredPeerConnection } from '@/lib/ac2';
import {
  buildSignalClientOptions,
  createAc2Client,
  createAc2Transport,
  createFetchWithTimeout,
  DEFAULT_THID,
  describeSelectedCandidatePair,
  generateThid,
  sendConversationClose,
  sendConversationOpen,
  summarizeSelectedCandidatePair,
} from '@/lib/ac2';
import { createControlFrameHandler } from '@/lib/ac2/streamControlFrame';
import { findWalletAccount } from '@/lib/keystore/wallet-account';
import { authenticateLiquidAuth } from '@/lib/liquid-auth/flow';
import { addressMatchesKey, sessionAddressFromData } from '@/lib/liquid-auth/helpers';
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, type AppStateStatus } from 'react-native';

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

interface ConnectionUiState {
  phase: ConnectionPhase;
  reconnectAttempt: number;
  error: Error | null;
  lastHeartbeat: number;
}

const initialConnectionUiState: ConnectionUiState = {
  phase: 'connecting',
  reconnectAttempt: 0,
  error: null,
  lastHeartbeat: Date.now(),
};

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

  const [connectionUi, setConnectionUi] = useState<ConnectionUiState>(initialConnectionUiState);
  const { phase, reconnectAttempt, error, lastHeartbeat } = connectionUi;
  const isConnected = phase === 'connected';
  const isLoading = phase === 'connecting';
  const isReconnecting = phase === 'reconnecting';
  const patchConnectionUi = useCallback((patch: Partial<ConnectionUiState>) => {
    setConnectionUi((state) => ({ ...state, ...patch }));
  }, []);
  const noteHeartbeat = useCallback((at: number = Date.now()) => {
    setConnectionUi((state) => ({ ...state, lastHeartbeat: at }));
  }, []);
  const hasAccounts = accounts.length > 0;
  const hasKeys = keys.length > 0;

  const [address, setAddress] = useState<string | null>(null);
  const addressRef = useRef<string | null>(null);

  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  // Auto-reconnect progress surfaced to the UI so it can show a "Reconnecting
  // (n/max)…" state while bounded retries are in flight, and only fall back to
  // the manual Reconnect button once the budget is exhausted.
  // Bumped by `reconnect()` to re-trigger the connection effect on demand.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamChannelRef = useRef<RTCDataChannel | null>(null);
  const clientRef = useRef<SignalClient | null>(null);
  // Transport-liveness watchdogs (heartbeat + ICE monitor), owned by
  // `useLivenessMonitors`. Held in a ref so `clearTransport` (declared before
  // the hook, to break the construction cycle with the recovery hook) can tear
  // the watchdogs down.
  const livenessRef = useRef<UseLivenessMonitorsResult | null>(null);
  // Last time we observed inbound traffic from the peer (frames, envelopes,
  // heartbeat pongs) vs. the last local user action. Kept separate so an
  // outbound keepalive can never be mistaken for peer presence.
  const lastInboundActivityRef = useRef<number>(Date.now());
  const lastLocalActivityRef = useRef<number>(Date.now());
  const authFlowInProgressRef = useRef<boolean>(false);
  // Ignore one `onClose` when the transport was intentionally torn down.
  const deliberateCloseRef = useRef(false);
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
    // Stop the liveness watchdogs (and close the heartbeat channel) before
    // anything closes the peer, so a deliberate teardown can't be misread as a
    // heartbeat timeout or an ICE failure.
    livenessRef.current?.teardown();
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
    if (clientRef.current) {
      try {
        // `SignalClient.close()` never tears down the WebRTC peer connection, so
        // close it explicitly. A leaked `RTCPeerConnection` keeps the ICE
        // session to the agent alive, so the agent still treats the old peer as
        // active for this requestId and ignores the fresh offer a reconnect
        // sends — leaving negotiation hung after `setLocalDescription`.
        clientRef.current.peerClient?.close();
      } catch {
        /* noop */
      }
      try {
        // `close(true)` also disconnects the underlying signaling socket. The
        // default `close()` only detaches listeners and leaves the socket.io
        // connection alive, which would then collide with the socket a
        // subsequent (re)connect opens to the same origin — wedging signaling.
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

  const prepareReconnect = useCallback(() => {
    deliberateCloseRef.current = true;
    authFlowInProgressRef.current = false;
    lastInboundActivityRef.current = Date.now();
    lastLocalActivityRef.current = Date.now();
  }, []);

  const {
    autoReconnectTimerRef,
    userStoppedRef,
    clearPendingAutoReconnect,
    resetRecovery,
    reconnect,
    reconnectRef,
    failConnectionRef,
    markConnected,
  } = useConnectionRecovery({
    autoReconnectDelayMs: AUTO_RECONNECT_DELAY_MS,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    patchUi: patchConnectionUi,
    clearTransport,
    prepareReconnect,
    requestReconnect: () => setReconnectNonce((n) => n + 1),
    logFailure: (reason) => logCandidatePairRef.current(`failed(${reason})`),
    onRecoveryExhausted: (connectionError) => {
      if (!connectionError) return;
      Alert.alert(
        'Connection Failed',
        connectionError.message || 'Failed to setup connection to the peer',
        [{ text: 'OK' }],
      );
    },
  });

  const {
    stashPeerConnection,
    attachHeartbeat,
    noteInbound: noteLivenessInbound,
    start: startLiveness,
    teardown: teardownLiveness,
  } = useLivenessMonitors({
    intervalMs: HEARTBEAT_INTERVAL_MS,
    timeoutMs: HEARTBEAT_TIMEOUT_MS,
    bufferedWarnBytes: HEARTBEAT_BUFFERED_WARN_BYTES,
    getFallbackChannel: () => dataChannelRef.current,
    onInbound: () => {
      wasBackgroundedRef.current = false;
      lastInboundActivityRef.current = Date.now();
      noteHeartbeat();
    },
    onFailure: (reason, isCurrent) => failConnectionRef.current(reason, isCurrent),
  });
  livenessRef.current = {
    stashPeerConnection,
    attachHeartbeat,
    noteInbound: noteLivenessInbound,
    start: startLiveness,
    teardown: teardownLiveness,
  };

  const reset = useCallback(() => {
    deliberateCloseRef.current = true;
    resetRecovery(true);
    clearTransport();
    setActiveStreamText('');
    setAgentPresence(null);
    setAgentPresenceDetail(null);
    patchConnectionUi({
      phase: 'closed',
      reconnectAttempt: 0,
      error: null,
    });
    updateSessionStatus(requestId, origin, 'closed');
  }, [requestId, origin, clearTransport, patchConnectionUi, resetRecovery]);

  // Live mirrors of the connection state so the AppState listener can read the
  // current values without being torn down/re-subscribed on every change (and
  // without capturing a stale closure).
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const isReconnectingRef = useRef(isReconnecting);
  isReconnectingRef.current = isReconnecting;

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
      // a SignalClient is already set up, we're in the loading/connecting
      // state, an auto-reconnect sequence is running, or a retry timer is
      // already pending.
      if (
        authFlowInProgressRef.current ||
        clientRef.current ||
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
  }, [origin, requestId, autoReconnectTimerRef, reconnectRef, userStoppedRef]);

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
    [requestId, origin, address, failConnectionRef],
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
    [origin, requestId, address, failConnectionRef],
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
            patchConnectionUi({ phase: 'closed' });
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
  }, [
    isConnected,
    clearTransport,
    origin,
    requestId,
    patchConnectionUi,
    reconnectRef,
    userStoppedRef,
  ]);

  useEffect(() => {
    let active = true;
    // Aborts every in-flight setup request when this run is superseded (a newer
    // reconnect/nonce bump) or unmounted, so a stalled request from an obsolete
    // attempt can't linger and race a fresh one.
    const runAbort = new AbortController();

    // `fetch` with a per-request timeout, also wired to this run's abort signal.
    // A timeout or supersession rejects the request so the outer catch can hand
    // off to the bounded auto-reconnect scheduler instead of hanging.
    // `fetch` with a per-request timeout, also wired to this run's abort signal.
    // A timeout or supersession rejects the request so the outer catch can hand
    // off to the bounded auto-reconnect scheduler instead of hanging.
    const fetchWithTimeout = createFetchWithTimeout(runAbort.signal, REQUEST_TIMEOUT_MS);

    async function setupConnection() {
      if (!origin || !requestId) {
        console.error('Missing origin or requestId');
        patchConnectionUi({ phase: 'closed' });
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
      if (clientRef.current || isConnected) {
        return;
      }

      patchConnectionUi({ phase: 'connecting', error: null });
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

        const options = await buildSignalClientOptions(origin);
        if (!active) return;

        const client = new SignalClient(
          origin,
          options as ConstructorParameters<typeof SignalClient>[1],
        );

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
          setLastHeartbeat: noteHeartbeat,
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
            stashPeerConnection(pc as unknown as MonitoredPeerConnection);
          },
          onSideChannel: (channel) => {
            console.log(`[ac2] Discovered channel: ${channel.label}`);
            if (channel.label === 'ac2-heartbeat') {
              attachHeartbeat(channel);
              return;
            }
            if (channel.label === 'ac2-stream') {
              streamChannelRef.current = channel;
              channel.onmessage = (event) => {
                if (!active) return;
                // Any inbound stream frame is proof of peer liveness.
                noteLivenessInbound();
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
          client.close(true);
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
            noteLivenessInbound();
            noteHeartbeat();
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
            noteLivenessInbound();
            noteHeartbeat();
          },
          onOpen: () => {
            console.log(`Data channel opened in ${Date.now() - setupStartedAt}ms`);
            if (active) {
              deliberateCloseRef.current = false;
              wasBackgroundedRef.current = false;
              // Log the negotiated ICE path (direct/STUN/TURN) for this session.
              logCandidatePairRef.current('connected');
              // Attach the ICE monitor and start the heartbeat watchdog now the
              // channel is live. `() => active` makes a late callback from a
              // superseded run a no-op.
              startLiveness(() => active);
              // Successful connection — clear the automatic-retry budget so a
              // future drop starts a fresh set of attempts.
              markConnected();
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
        // aborted) must do nothing: `clientRef` now points at the newer run's
        // client, so tearing it down here would kill a healthy connection and
        // clobber its session status. The newer run owns all recovery.
        if (!active || err?.name === 'AbortError') return;
        console.error('Failed to setup connection:', err);
        updateSessionStatus(requestId, origin, 'failed');
        // Funnel through the single failure path: it tears down the
        // partially-established transport (peer + socket included, via
        // `clearTransport`) and hands off to the bounded auto-reconnect
        // scheduler, surfacing the terminal error + manual fallback only once
        // the retry budget is exhausted.
        failConnectionRef.current('setup', () => active, err);
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
      // Stop the watchdogs (and close the heartbeat channel) before the peer is
      // closed below, so neither observes the teardown as a failure and no
      // timers/listeners dangle.
      livenessRef.current?.teardown();
      const hadEstablishedTransport = !!(dataChannelRef.current || ac2ClientRef.current);
      runAbort.abort();
      clearPendingAutoReconnect();
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
      if (clientRef.current) {
        // Only hard-close the peer once this effect still owns an established
        // transport. For a superseded setup run, `runAbort.abort()` above has
        // already cancelled the logical attempt; force-closing the native peer
        // here can race Android's in-flight `setRemoteDescription` and crash.
        if (hadEstablishedTransport) {
          try {
            clientRef.current.peerClient?.close();
          } catch {
            /* noop */
          }
        }
        clientRef.current.close(true);
        clientRef.current = null;
      }
    };
  }, [
    origin,
    requestId,
    allowPasskeyCreation,
    attachHeartbeat,
    clearPendingAutoReconnect,
    hasAccounts,
    hasKeys,
    isConnected,
    key,
    failConnectionRef,
    markConnected,
    noteHeartbeat,
    noteLivenessInbound,
    passkey,
    patchConnectionUi,
    reconnectNonce,
    stashPeerConnection,
    startLiveness,
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
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    lastHeartbeat,
    reset,
    reconnect,
    activeThid,
    openConversation,
    closeConversation,
    remoteThreads,
  };
}
