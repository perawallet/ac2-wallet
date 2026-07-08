import { useProvider } from '@/hooks/useProvider';
import {
  attachHeartbeatChannel,
  createAc2Client,
  createAc2Transport,
  DEFAULT_THID,
  generateThid,
  sendConversationClose,
  sendConversationOpen,
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
  // Bumped by `reconnect()` to re-trigger the connection effect on demand.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamChannelRef = useRef<RTCDataChannel | null>(null);
  // Dedicated `ac2-heartbeat` liveness channel — out-of-band relative to `ac2-v1`.
  const heartbeatChannelRef = useRef<RTCDataChannel | null>(null);
  const clientRef = useRef<SignalClient | null>(null);
  const lastUserActivityRef = useRef<number>(Date.now());
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

  const reset = useCallback(() => {
    deliberateCloseRef.current = true;
    userStoppedRef.current = true;
    reconnectAttemptRef.current = 0;
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    clearTransport();
    setActiveStreamText('');
    setAgentPresence(null);
    setAgentPresenceDetail(null);
    setIsConnected(false);
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
    deliberateCloseRef.current = true;
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
    clearTransport();
    authFlowInProgressRef.current = false;
    lastUserActivityRef.current = Date.now();
    setError(null);
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
  }, [origin, requestId]);

  const send = useCallback(
    (text: string) => {
      const channel = streamChannelRef.current || dataChannelRef.current;
      if (text.trim() && channel && channel.readyState === 'open' && address) {
        const thid = activeThidRef.current;
        // Tag the wire frame with the active `thid` so the agent routes it without
        // racing the separately-delivered `ac2/ConversationOpen` control frame.
        channel.send(JSON.stringify({ thid, text: text.trim() }));
        addMessage({
          text: text.trim(),
          sender: 'me',
          address,
          origin,
          requestId,
          thid,
        });
        updateSessionActivity(requestId, origin);
        lastUserActivityRef.current = Date.now();
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
      lastUserActivityRef.current = Date.now();
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
      lastUserActivityRef.current = Date.now();
    },
    [address, origin, requestId],
  );

  const sendAc2 = useCallback(
    (message: Ac2Message) => {
      const client = ac2ClientRef.current;
      if (!client) {
        throw new Error('AC2 client not ready (DataChannel not open)');
      }
      client.send(message);
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
      lastUserActivityRef.current = Date.now();
    },
    [origin, requestId, address],
  );

  useEffect(() => {
    let active = true;
    let heartbeatInterval: any = null;
    let inactivityInterval: any = null;

    if (isConnected) {
      heartbeatInterval = setInterval(() => {
        // Prefer the `ac2-heartbeat` channel; fall back to the control channel
        // (empty frame) if the peer didn't negotiate it.
        const hb = heartbeatChannelRef.current;
        if (hb && hb.readyState === 'open') {
          console.log('Sending heartbeat ping');
          hb.send('ping');
          if (active) setLastHeartbeat(Date.now());
        } else if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
          console.log('Sending heartbeat message');
          dataChannelRef.current.send('');
          if (active) setLastHeartbeat(Date.now());
        }
      }, 20000);

      inactivityInterval = setInterval(() => {
        const now = Date.now();
        const inactiveTime = now - lastUserActivityRef.current;
        if (inactiveTime >= 60000) {
          // A stale connection whose idleness is explained by the app having
          // been backgrounded (timers suspended, no heartbeats) should recover
          // automatically; a genuine foreground idle should not (avoids churn /
          // repeated biometric prompts). An intentional disconnect never
          // resumes.
          const resumeAfterBackground = !userStoppedRef.current && wasBackgroundedRef.current;
          console.log(
            resumeAfterBackground
              ? 'Closing stale connection after background; will reconnect'
              : 'Closing connection due to inactivity (1 minute)',
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
      }, 5000);
    }

    return () => {
      active = false;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
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

      // If we are already connecting or connected, don't start again
      if (clientRef.current || isConnected) {
        return;
      }

      setIsLoading(true);
      setError(null);
      authFlowInProgressRef.current = true;

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

        // Final validation of the session before connecting
        const finalSessionCheck = await fetchWithTimeout(`${origin}/auth/session`);

        if (!active) return;

        if (finalSessionCheck.ok) {
          const sessionData = await finalSessionCheck.json();

          if (!active) return;

          const sessionAddress = sessionAddressFromData(sessionData);
          if (sessionAddress) {
            setAddress(sessionAddress);
            addressRef.current = sessionAddress;
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

        // Apply one STX-prefixed control frame from the agent's stream channel.
        // See `lib/ac2/streamControlFrame.ts` / `lib/ac2/stream.ts` for the frame
        // shapes. Returns true when `raw` was a control frame (recognized or
        // malformed) — never render as chat.
        const applyControlFrame = createControlFrameHandler({
          origin,
          requestId,
          addressRef,
          activeThidRef,
          lastUserActivityRef,
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
          onSideChannel: (channel) => {
            console.log(`[ac2] Discovered channel: ${channel.label}`);
            if (channel.label === 'ac2-heartbeat') {
              heartbeatChannelRef.current = attachHeartbeatChannel(channel, {
                onPing: () => {
                  if (!active) return;
                  wasBackgroundedRef.current = false;
                  lastUserActivityRef.current = Date.now();
                  setLastHeartbeat(Date.now());
                },
              });
              return;
            }
            if (channel.label === 'ac2-stream') {
              streamChannelRef.current = channel;
              channel.onmessage = (event) => {
                if (!active) return;
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
            lastUserActivityRef.current = Date.now();
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
            lastUserActivityRef.current = Date.now();
            setLastHeartbeat(Date.now());
          },
          onOpen: () => {
            console.log('Data channel opened');
            if (active) {
              deliberateCloseRef.current = false;
              wasBackgroundedRef.current = false;
              if (autoReconnectTimerRef.current) {
                clearTimeout(autoReconnectTimerRef.current);
                autoReconnectTimerRef.current = null;
              }
              // Successful connection — clear the automatic-retry budget so a
              // future drop starts a fresh set of attempts.
              reconnectAttemptRef.current = 0;
              setReconnectAttempt(0);
              setIsReconnecting(false);
              setIsConnected(true);
              setIsLoading(false);
              setAc2Client(ac2);
              updateSessionStatus(requestId, origin, 'active');
            }
          },
          onClose: () => {
            console.log('Data channel closed');
            updateSessionStatus(requestId, origin, 'closed');
            if (active) {
              if (deliberateCloseRef.current) {
                deliberateCloseRef.current = false;
                return;
              }
              setIsConnected(false);
              // Drop every stale transport ref so the next mount / reconnect
              // isn't blocked by the connection effect's guard.
              clearTransport();
              // Kick off (or continue) the bounded, serialized retry sequence.
              // Once the budget is spent, fall back to the manual Reconnect bar.
              if (!scheduleAutoReconnectRef.current()) {
                setIsReconnecting(false);
                setIsLoading(false);
              }
            }
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
        // Tear down the partially-established SignalClient before clearing the
        // ref. The timeout handler only closes the peer connection — also close
        // the socket so the server-side session doesn't stay open and confuse
        // the next connection attempt.
        try {
          clientRef.current?.peerClient?.close();
        } catch {
          /* noop */
        }
        try {
          clientRef.current?.close(true);
        } catch {
          /* noop */
        }
        clientRef.current = null;
        updateSessionStatus(requestId, origin, 'failed');
        // Retry recoverable setup failures within the bounded budget; only
        // surface the terminal error + manual fallback once it's exhausted.
        if (!scheduleAutoReconnectRef.current()) {
          setIsReconnecting(false);
          setError(err);
          setIsLoading(false);
          Alert.alert(
            'Connection Failed',
            err.message || 'Failed to setup connection to the peer',
            [{ text: 'OK' }],
          );
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
  }, [origin, requestId, accounts.length > 0, keys.length > 0, reconnectNonce]);

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
