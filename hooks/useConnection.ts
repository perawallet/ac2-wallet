import type { Passkey } from '@/extensions/passkeys';
import { useProvider } from '@/hooks/useProvider';
import {
  attachHeartbeatChannel,
  createAc2Client,
  createAc2Transport,
  DEFAULT_THID,
  generateThid,
  parseStreamControlFrame,
  sendConversationClose,
  sendConversationOpen,
} from '@/lib/ac2';
import { biometricOptions } from '@/lib/keystore/auth-options';
import { addAc2Message, clearAc2MessagesByThread } from '@/stores/ac2Messages';
import { accountsStore } from '@/stores/accounts';
import { keyStore } from '@/stores/keystore';
import {
  addMessage,
  addToolActivity,
  clearMessagesByThread,
  setThreadHistory,
} from '@/stores/messages';
import {
  addSession,
  Session,
  sessionsStore,
  updateSessionActivity,
  updateSessionPasskeyCredentialId,
  updateSessionStatus,
} from '@/stores/sessions';
import { findWalletAccount, isWalletAccountKey } from '@/lib/keystore/wallet-account';
import { decodeAddress } from '@/utils/algorand';
import { toUrlSafe } from '@/utils/base64';
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import type { AC2BaseMessage as Ac2Message } from '@algorandfoundation/ac2-sdk/schema';
import type { Key, KeyData } from '@algorandfoundation/keystore';
import { encodeAddress } from '@algorandfoundation/keystore';
import { assertion, encoding, SignalClient } from '@algorandfoundation/liquid-client';
import ReactNativePasskeyAutofill from '@algorandfoundation/react-native-passkey-autofill';
import {
  encode,
  encryptData,
  fetchSecret,
  readMasterKey,
  storage,
} from '@algorandfoundation/react-native-keystore';
import { bootstrap } from '@/lib/keystore/bootstrap';
import { useStore } from '@tanstack/react-store';
import { Buffer } from 'buffer';
import { XHR as EngineIoXHR } from 'engine.io-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, NativeModules, Platform } from 'react-native';

/**
 * Re-encrypt a key record with the supplied master key and reflect the new
 * metadata in the reactive key store, bypassing the keystore library's
 * `commit()` (which would re-fetch the master key and prompt again).
 */
function persistKeyMetadata(keyData: KeyData, masterKey: Buffer): void {
  // Re-encrypt the full key record (incl. private material) and store it.
  storage.set(keyData.id, encryptData(Buffer.from(masterKey), encode(keyData)));
  // Reflect the metadata change in the reactive store without leaking the
  // private key/seed, de-duplicating by id so we don't append a stale copy.
  const { privateKey, seed, ...keyState } = keyData as any;
  void privateKey;
  void seed;
  keyStore.setState((state) => ({
    ...state,
    keys: [{ ...keyState }, ...state.keys.filter((k) => k.id !== keyState.id)],
  }));
}

function normalizeOriginHost(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function originMatches(storedOrigin: unknown, currentOrigin: string): boolean {
  return (
    typeof storedOrigin === 'string' &&
    storedOrigin.length > 0 &&
    normalizeOriginHost(storedOrigin) === normalizeOriginHost(currentOrigin)
  );
}

function passkeyFromKey(keyData: Key): Passkey | null {
  if (
    (keyData.type !== 'xhd-derived-p256' && keyData.type !== 'hd-derived-p256') ||
    !keyData.publicKey
  ) {
    return null;
  }

  const metadata = (keyData.metadata ?? {}) as Record<string, any>;
  const username = metadata.userHandle || 'Unnamed User';
  const origin = metadata.origin || 'Unnamed Origin';

  return {
    id: toUrlSafe(keyData.id),
    name: `${username}@${origin}`,
    userHandle: metadata.userHandle,
    origin: metadata.origin,
    publicKey: keyData.publicKey,
    algorithm: keyData.algorithm || 'P256',
    createdAt: metadata.createdAt || Date.now(),
    metadata: {
      ...metadata,
      keyId: keyData.id,
      type: keyData.type,
      registered: metadata.registered ?? false,
    },
  };
}

function sessionAddressFromData(sessionData: any): string | null {
  return typeof sessionData?.address === 'string'
    ? sessionData.address
    : typeof sessionData?.user?.wallet === 'string'
      ? sessionData.user.wallet
      : typeof sessionData?.session?.wallet === 'string'
        ? sessionData.session.wallet
        : null;
}

function credentialIdFromData(data: any): string | null {
  if (!data) return null;
  if (typeof data === 'string') return data;

  const candidates = [
    data.credId,
    data.credentialId,
    data.id,
    data.rawId,
    data.credential?.credId,
    data.credential?.credentialId,
    data.credential?.id,
    data.passkey?.credId,
    data.passkey?.credentialId,
    data.passkey?.id,
  ];

  const id = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return id ?? null;
}

function credentialArraysFromSession(sessionData: any): any[][] {
  return [
    sessionData?.user?.credentials,
    sessionData?.user?.passkeys,
    sessionData?.session?.credentials,
    sessionData?.session?.passkeys,
    sessionData?.credentials,
    sessionData?.passkeys,
  ].filter(Array.isArray);
}

function credentialIdsFromSessionData(sessionData: any): string[] {
  return credentialArraysFromSession(sessionData)
    .flat()
    .map(credentialIdFromData)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function userHandleMatchesAddress(userHandle: unknown, address: string): boolean {
  if (typeof userHandle !== 'string' || userHandle.length === 0) return false;
  if (userHandle === address) return true;

  try {
    const publicKey = encoding.fromBase64Url(toUrlSafe(userHandle));
    return encodeAddress(publicKey) === address;
  } catch {
    return false;
  }
}

function passkeysFromSessionUser(sessionData: any, origin: string): Passkey[] {
  const wallet = sessionAddressFromData(sessionData) ?? undefined;
  const credentials = credentialArraysFromSession(sessionData).flat();

  return credentials
    .map((credential: any) => ({ credential, id: credentialIdFromData(credential) }))
    .filter((entry): entry is { credential: any; id: string } => typeof entry.id === 'string')
    .map(({ credential, id }) => {
      const userHandle =
        credential.userHandle ??
        credential.userId ??
        credential.credential?.userHandle ??
        credential.credential?.userId ??
        credential.passkey?.userHandle ??
        credential.passkey?.userId ??
        wallet;

      return {
        id,
        name: `${wallet ?? 'Liquid Auth'}@${normalizeOriginHost(origin)}`,
        userHandle,
        origin,
        publicKey: new Uint8Array(),
        algorithm: 'P256',
        metadata: {
          origin,
          userHandle,
          registered: true,
          source: 'liquid-auth-session',
        },
      };
    });
}

function normalizeCredentialId(value: string): string {
  return toUrlSafe(value.trim());
}

function credentialIdCandidates(credential: any): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) ids.add(normalizeCredentialId(value));
  };
  add(credential?.id);
  add(credential?.rawId ? encoding.toBase64URL(new Uint8Array(credential.rawId)) : null);
  add(credential?.rawId ? Buffer.from(new Uint8Array(credential.rawId)).toString('base64') : null);
  return ids;
}

function keyMatchesCredential(key: Key, credentialIds: Set<string>): boolean {
  return credentialIds.has(normalizeCredentialId(key.id));
}

function addressMatchesKey(address: string, key: Key): boolean {
  try {
    const publicKey = decodeAddress(address).publicKey;
    return (
      !!key.publicKey &&
      key.publicKey.length === publicKey.length &&
      key.publicKey.every((value, index) => value === publicKey[index])
    );
  } catch {
    return false;
  }
}

async function findPasskeyKeyForCredential({
  credential,
  passkeys,
  origin,
  walletAddress,
}: {
  credential: any;
  passkeys: Passkey[];
  origin: string;
  walletAddress: string;
}): Promise<Key | undefined> {
  const credentialIds = credentialIdCandidates(credential);
  const findMatch = () => {
    const matchedPasskey = passkeys.find((p) => credentialIds.has(normalizeCredentialId(p.id)));
    return (
      keyStore.state.keys.find((k) => k.id === matchedPasskey?.metadata?.keyId) ||
      keyStore.state.keys.find((k) => keyMatchesCredential(k, credentialIds)) ||
      keyStore.state.keys.find(
        (k) =>
          (k.type === 'hd-derived-p256' || k.type === 'xhd-derived-p256') &&
          originMatches(k.metadata?.origin, origin) &&
          k.metadata?.userHandle === walletAddress,
      )
    );
  };

  let matchedKey = findMatch();
  for (let attempt = 0; !matchedKey && attempt < 3; attempt += 1) {
    await bootstrap(biometricOptions, false);
    matchedKey = findMatch();
    if (!matchedKey) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return matchedKey;
}

async function nativeStoredPasskeys(): Promise<Passkey[]> {
  const credentials = await ReactNativePasskeyAutofill.getStoredCredentials().catch(() => []);
  return credentials
    .filter((credential: any) => typeof credential?.credentialId === 'string')
    .map((credential: any) => {
      const id = credential.credentialId.trim();
      const origin = credential.relyingPartyIdentifier || credential.rpId || credential.origin;
      const userHandle = credential.userHandle;
      return {
        id,
        name: `${userHandle || 'Liquid Auth'}@${origin || 'Unknown Origin'}`,
        userHandle,
        origin,
        publicKey: new Uint8Array(),
        algorithm: 'P256',
        createdAt: credential.createdAt || Date.now(),
        metadata: {
          origin,
          userHandle,
          registered: true,
          source: 'native-autofill-store',
        },
      };
    });
}

function passkeyMatchesConnection(
  passkey: Passkey,
  origin: string,
  sessionAddress: string | null,
): boolean {
  if (originMatches(passkey.metadata?.origin ?? passkey.origin, origin)) return true;
  const userHandle = passkey.metadata?.userHandle ?? passkey.userHandle;
  return (
    typeof sessionAddress === 'string' &&
    userHandleMatchesAddress(userHandle, sessionAddress) &&
    passkey.metadata?.registered === true
  );
}

async function fetchAssertionOptions(
  origin: string,
  credentialId: string,
): Promise<{ credentialId: string; options: any } | null> {
  const response = await fetch(`${origin}/assertion/request/${encodeURIComponent(credentialId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userVerification: 'required',
    }),
  });

  if (!response.ok) return null;
  return { credentialId, options: await response.json() };
}

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
  // Bumped by `reconnect()` to re-trigger the connection effect on demand.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamChannelRef = useRef<RTCDataChannel | null>(null);
  // Dedicated `ac2-heartbeat` liveness channel — out-of-band relative to `ac2-v1`.
  const heartbeatChannelRef = useRef<RTCDataChannel | null>(null);
  const clientRef = useRef<SignalClient | null>(null);
  const lastUserActivityRef = useRef<number>(Date.now());
  const authFlowInProgressRef = useRef<boolean>(false);

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
        clientRef.current.close();
      } catch {
        /* noop */
      }
      clientRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTransport();
    setActiveStreamText('');
    setAgentPresence(null);
    setAgentPresenceDetail(null);
    setIsConnected(false);
    setIsLoading(false);
    setError(null);
    updateSessionStatus(requestId, origin, 'closed');
  }, [requestId, origin, clearTransport]);

  // Manually re-establish a dropped connection. Tears down any stale transport
  // (so the connection effect's guard doesn't short-circuit), flips back into
  // the loading/connecting state, and bumps the nonce to re-run setup.
  const reconnect = useCallback(() => {
    clearTransport();
    authFlowInProgressRef.current = false;
    lastUserActivityRef.current = Date.now();
    setError(null);
    setIsConnected(false);
    setIsLoading(true);
    setReconnectNonce((n) => n + 1);
  }, [clearTransport]);

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
          console.log('Closing connection due to inactivity (1 minute)');
          // Fully tear down so the connection effect's guard doesn't keep a
          // stale client around — otherwise a later reconnect is impossible.
          clearTransport();
          updateSessionStatus(requestId, origin, 'closed');
          if (active) {
            setIsConnected(false);
            setIsLoading(false);
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

        const sessionCheck = await fetch(`${origin}/auth/session`);
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

        {
          const storedPasskeys = await passkey.store.getPasskeys();
          const passkeysById = new Map<string, Passkey>(
            storedPasskeys.map((currentPasskey) => [
              normalizeCredentialId(currentPasskey.id),
              currentPasskey,
            ]),
          );
          const addPasskeyCandidate = (candidate: Passkey) => {
            const normalizedId = normalizeCredentialId(candidate.id);
            if (!passkeysById.has(normalizedId)) {
              passkeysById.set(normalizedId, candidate);
            }
          };

          (await nativeStoredPasskeys()).forEach(addPasskeyCandidate);

          passkeysFromSessionUser(initialSessionData, origin).forEach(addPasskeyCandidate);

          currentKeys.forEach((currentKey) => {
            const keyBackedPasskey = passkeyFromKey(currentKey);
            if (keyBackedPasskey) addPasskeyCandidate(keyBackedPasskey);
          });

          const currentPasskeys = [...passkeysById.values()];
          const relevantPasskeys = currentPasskeys.filter((p) =>
            passkeyMatchesConnection(p, origin, initialSessionAddress),
          );

          const assertionCredentialIds = [
            existingSession?.passkeyCredentialId,
            ...credentialIdsFromSessionData(initialSessionData),
            ...relevantPasskeys.map((p) => p.id),
            walletAddress,
          ].filter((id): id is string => typeof id === 'string' && id.length > 0);
          const seenAssertionCredentialIds = new Set<string>();
          const uniqueAssertionCredentialIds = assertionCredentialIds.filter((id) => {
            const normalized = normalizeCredentialId(id);
            if (seenAssertionCredentialIds.has(normalized)) return false;
            seenAssertionCredentialIds.add(normalized);
            return true;
          });

          let assertionOptions: { credentialId: string; options: any } | null = null;
          for (const credentialId of uniqueAssertionCredentialIds) {
            assertionOptions = await fetchAssertionOptions(origin, credentialId);
            if (!active) return;
            if (assertionOptions) break;
          }

          if (assertionOptions) {
            console.log(
              'Found existing passkey assertion options for credential:',
              assertionOptions.credentialId,
            );

            const decodedOptions = assertion.encoder.decodeOptions(assertionOptions.options);

            // Ensure all relevant passkeys are allowed in the options to allow user selection in the intent
            if (relevantPasskeys.length > 1) {
              if (!decodedOptions.allowCredentials) {
                decodedOptions.allowCredentials = [];
              }
              const existingIds = new Set(
                decodedOptions.allowCredentials.map((c: { id: ArrayBuffer }) =>
                  encoding.toBase64URL(new Uint8Array(c.id as ArrayBuffer)),
                ),
              );
              relevantPasskeys.forEach((p) => {
                if (!existingIds.has(p.id)) {
                  decodedOptions.allowCredentials!.push({
                    id: encoding.fromBase64Url(p.id),
                    type: 'public-key',
                  });
                }
              });
            }

            const challenge = encoding.fromBase64Url(assertionOptions.options.challenge);

            const liquidOptions = {
              requestId,
              origin,
              type: 'algorand',
              address: walletAddress,
              signature: encoding.toBase64URL(await key.store.sign(foundKey.id, challenge)),
              device: 'Demo Web Wallet',
            };

            const credential = (await navigator.credentials.get({
              publicKey: decodedOptions,
            })) as any;
            if (!active) return;
            authFlowInProgressRef.current = false;

            if (!credential) {
              throw new Error('Credential creation failed');
            }

            const currentPasskeys = await passkey.store.getPasskeys();
            let selectedAddress: string | null = null;
            if (credential.response?.userHandle) {
              try {
                selectedAddress = encodeAddress(new Uint8Array(credential.response.userHandle));
              } catch (e) {
                console.error('Failed to encode address from userHandle', e);
              }
            }

            if (!selectedAddress) {
              const matchedPasskey =
                relevantPasskeys.find((p) => p.id === credential.id) ||
                currentPasskeys.find((p) => p.id === credential.id);
              const userHandle = matchedPasskey?.metadata?.userHandle;
              if (userHandle) {
                try {
                  // Handle different possible formats of userHandle in store (Uint8Array or serialized object)
                  const handleArray =
                    userHandle instanceof Uint8Array
                      ? userHandle
                      : typeof userHandle === 'object'
                        ? new Uint8Array(Object.values(userHandle))
                        : null;
                  if (handleArray) {
                    selectedAddress = encodeAddress(handleArray);
                  }
                } catch (e) {
                  console.error('Failed to encode address from stored userHandle', e);
                }
              }
            }

            if (selectedAddress) {
              console.log('Selected address from passkey:', selectedAddress);
              setAddress(selectedAddress);
              addressRef.current = selectedAddress;
              liquidOptions.address = selectedAddress;

              // Re-sign the challenge if the address changed to match the selected passkey
              const selectedPublicKey = decodeAddress(selectedAddress).publicKey;
              const selectedKey = keyStore.state.keys.find(
                (k) =>
                  isWalletAccountKey(k) &&
                  k.publicKey &&
                  k.publicKey.length === selectedPublicKey.length &&
                  k.publicKey.every((v, i) => v === selectedPublicKey[i]),
              );

              if (selectedKey) {
                console.log('Found key for selected address, re-signing challenge');
                liquidOptions.signature = encoding.toBase64URL(
                  await key.store.sign(selectedKey.id, challenge),
                );
              } else {
                console.warn('Could not find key for selected address', selectedAddress);
              }
            }

            const encodedCredential = assertion.encoder.encodeCredential(credential);
            encodedCredential.clientExtensionResults = {
              ...encodedCredential.clientExtensionResults,
              liquid: liquidOptions,
            } as any;

            const submitResponse = await fetch(`${origin}/assertion/response`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(encodedCredential),
            });

            if (!submitResponse.ok) {
              throw new Error(
                `Failed to submit assertion response: ${submitResponse.status} ${submitResponse.statusText}`,
              );
            }
            updateSessionPasskeyCredentialId(requestId, origin, credential.id);

            const matchedKey = await findPasskeyKeyForCredential({
              credential,
              passkeys: [...currentPasskeys, ...relevantPasskeys],
              origin,
              walletAddress: selectedAddress ?? liquidOptions.address,
            });

            if (matchedKey) {
              try {
                // Pass a defensive copy via `options.masterKey` so `fetchSecret`
                // can zero its own buffer in `finally` without wiping ours.
                const masterKey = await readMasterKey(biometricOptions);
                const keyData = await fetchSecret<KeyData>({
                  keyId: matchedKey.id,
                  options: { masterKey: Buffer.from(masterKey) },
                });
                if (keyData) {
                  keyData.metadata = {
                    ...keyData.metadata,
                    origin,
                    ...(selectedAddress ? { userHandle: selectedAddress } : {}),
                    registered: true,
                  };
                  persistKeyMetadata(keyData, masterKey);
                }
              } catch (error) {
                console.error('Failed to update key metadata after assertion:', error);
              }
            }
          } else {
            if (!allowPasskeyCreation) {
              throw new Error(
                'No existing passkey was found for this connection. Scan the agent QR code again to create one.',
              );
            }

            console.log('No existing passkey for origin, using attestation');

            const optionsResponse = await fetch(`${origin}/attestation/request`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                attestationType: 'none',
                authenticatorSelection: {
                  authenticatorAttachment: 'platform',
                  userVerification: 'required',
                  residentKey: 'required',
                  requireResidentKey: true,
                },
                extensions: {
                  liquid: true,
                },
              }),
            });

            if (!active) return;

            if (!optionsResponse.ok) {
              throw new Error(
                `Failed to get attestation request: ${optionsResponse.status} ${optionsResponse.statusText}`,
              );
            }

            const encodedAttestationOptions = await optionsResponse.json();
            if (!active) return;
            const challenge = encoding.fromBase64Url(encodedAttestationOptions.challenge);

            const liquidOptions = {
              requestId,
              origin: origin,
              type: 'algorand',
              address: walletAddress,
              signature: encoding.toBase64URL(await key.store.sign(foundKey.id, challenge)),
              device: 'Demo Web Wallet',
            };

            const decodedPublicKey = {
              ...encodedAttestationOptions,
              user: {
                ...encodedAttestationOptions.user,
                id: decodeAddress(liquidOptions.address).publicKey,
                name: liquidOptions.address,
                displayName: liquidOptions.address,
              },
              challenge: encoding.fromBase64Url(encodedAttestationOptions.challenge),
              excludeCredentials: encodedAttestationOptions.excludeCredentials?.map(
                (cred: any) => ({
                  ...cred,
                  id: encoding.fromBase64Url(cred.id),
                }),
              ),
            };

            const credential = (await navigator.credentials.create({
              publicKey: decodedPublicKey,
            })) as any;
            if (!active) return;
            authFlowInProgressRef.current = false;

            if (!credential) {
              throw new Error('Credential creation failed');
            }

            setAddress(liquidOptions.address);
            addressRef.current = liquidOptions.address;

            const response = credential.response;
            const encodedCredential = {
              id: credential.id,
              rawId: encoding.toBase64URL(credential.rawId),
              type: credential.type,
              response: {
                clientDataJSON: encoding.toBase64URL(response.clientDataJSON),
                attestationObject: encoding.toBase64URL(response.attestationObject),
                clientExtensionResults: response.clientExtensionResults || {},
              },
              clientExtensionResults: {
                ...(credential.getClientExtensionResults
                  ? credential.getClientExtensionResults()
                  : credential.clientExtensionResults || {}),
                liquid: liquidOptions,
              },
            };

            const submitResponse = await fetch(`${origin}/attestation/response`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(encodedCredential),
            });

            if (!active) return;

            if (!submitResponse.ok) {
              throw new Error(
                `Failed to submit attestation response: ${submitResponse.status} ${submitResponse.statusText}`,
              );
            }
            updateSessionPasskeyCredentialId(requestId, origin, credential.id);

            const currentPasskeys = await passkey.store.getPasskeys();
            const matchedKey = await findPasskeyKeyForCredential({
              credential,
              passkeys: currentPasskeys,
              origin,
              walletAddress: liquidOptions.address,
            });

            if (matchedKey) {
              try {
                // Pass a defensive copy via `options.masterKey` so `fetchSecret`
                // can zero its own buffer in `finally` without wiping ours.
                const masterKey = await readMasterKey(biometricOptions);
                const keyData = await fetchSecret<KeyData>({
                  keyId: matchedKey.id,
                  options: { masterKey: Buffer.from(masterKey) },
                });
                if (keyData) {
                  keyData.metadata = {
                    ...keyData.metadata,
                    origin,
                    userHandle: liquidOptions.address,
                    registered: true,
                  };
                  persistKeyMetadata(keyData, masterKey);
                }
              } catch (error) {
                console.error('Failed to update key metadata after attestation:', error);
              }
            }
          }
        }

        // Final validation of the session before connecting
        const finalSessionCheck = await fetch(`${origin}/auth/session`);

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

        // Apply one STX-prefixed control frame from the agent's stream channel.
        // See `lib/ac2/stream.ts` for the frame shapes. Returns true when `raw`
        // was a control frame (recognized or malformed) — never render as chat.
        const applyControlFrame = (raw: string): boolean => {
          const parsed = parseStreamControlFrame(raw);
          if (parsed === null) return false;
          // Any inbound control frame means the agent is alive — reset the
          // inactivity watchdog so a long "thinking" turn is never torn down.
          lastUserActivityRef.current = Date.now();
          if (parsed === undefined) return true; // malformed payload, swallow
          const frame: any = parsed;
          const fthid: string =
            typeof frame?.thid === 'string' && frame.thid.length > 0
              ? frame.thid
              : activeThidRef.current;
          const isActiveThread = fthid === activeThidRef.current;
          switch (frame?.t) {
            case 'preview': {
              // Live draft for `fthid`; only reflect it in the on-screen UI
              // when it belongs to the conversation currently open.
              if (isActiveThread) {
                if (frame.phase === 'tool') {
                  setAgentPresence('tool');
                  setAgentPresenceDetail(typeof frame.detail === 'string' ? frame.detail : null);
                } else if (frame.phase === 'typing') {
                  setAgentPresence('typing');
                  setAgentPresenceDetail(null);
                } else {
                  // `thinking` (and any unknown phase) → thinking indicator.
                  setAgentPresence('thinking');
                  setAgentPresenceDetail(null);
                }
                if (typeof frame.text === 'string') setActiveStreamText(frame.text);
              }
              break;
            }
            case 'finalize': {
              // Commit the streamed draft in place as the agent's message for
              // its thread; clear the live preview if it's the active thread.
              const text = typeof frame.text === 'string' ? frame.text.trim() : '';
              if (text && addressRef.current) {
                addMessage({
                  text,
                  sender: 'peer',
                  address: addressRef.current,
                  origin,
                  requestId,
                  thid: fthid,
                });
                updateSessionActivity(requestId, origin);
                setLastHeartbeat(Date.now());
              }
              if (isActiveThread) {
                setActiveStreamText('');
                setAgentPresence(null);
                setAgentPresenceDetail(null);
              }
              break;
            }
            case 'discard': {
              if (isActiveThread) {
                setActiveStreamText('');
                setAgentPresence(null);
                setAgentPresenceDetail(null);
              }
              break;
            }
            case 'conversations': {
              if (Array.isArray(frame.threads)) {
                // The agent advertised the conversations it already holds for
                // this connection. Surface them so the controller can show
                // (and restore) threads it has no local copy of.
                setRemoteThreads(
                  frame.threads
                    .filter((t: any) => typeof t?.thid === 'string' && t.thid.length > 0)
                    .map((t: any) => ({
                      thid: t.thid as string,
                      ...(typeof t.title === 'string' ? { title: t.title } : {}),
                      ...(typeof t.updatedAt === 'number' ? { updatedAt: t.updatedAt } : {}),
                    })),
                );
              }
              break;
            }
            case 'tool': {
              // Durable tool-activity card: a record of one tool/exec step the
              // agent ran. Persist it (de-duped by the agent-supplied id) so it
              // renders as a distinct "tool card" in the thread's timeline,
              // independent of the ephemeral `preview` (phase tool) indicator.
              if (typeof frame.id === 'string' && addressRef.current) {
                addToolActivity({
                  toolId: frame.id,
                  address: addressRef.current,
                  origin,
                  requestId,
                  thid: fthid,
                  ...(typeof frame.name === 'string' ? { tool: frame.name } : {}),
                  ...(typeof frame.command === 'string' ? { command: frame.command } : {}),
                  ...(typeof frame.output === 'string' ? { output: frame.output } : {}),
                });
                updateSessionActivity(requestId, origin);
              }
              break;
            }
            case 'history': {
              if (
                typeof frame.thid === 'string' &&
                Array.isArray(frame.messages) &&
                addressRef.current
              ) {
                // The agent replayed an existing conversation's history (e.g.
                // after we opened/switched to it). Restore it into the local
                // store, idempotently replacing our copy of that thread.
                const history = frame.messages
                  .filter(
                    (m: any) =>
                      (m?.role === 'user' || m?.role === 'assistant' || m?.role === 'tool') &&
                      (typeof m?.text === 'string' || m?.role === 'tool'),
                  )
                  .map((m: any) => {
                    if (m.role === 'tool') {
                      // A persisted tool/exec card replayed by the agent — carry
                      // through its id (so it coalesces with live frames) and
                      // tool/command/output fields.
                      return {
                        role: 'tool' as const,
                        text: '',
                        ...(typeof m.id === 'string' ? { toolId: m.id } : {}),
                        ...(typeof m.name === 'string' ? { tool: m.name } : {}),
                        ...(typeof m.command === 'string' ? { command: m.command } : {}),
                        ...(typeof m.output === 'string' ? { output: m.output } : {}),
                        ...(typeof m.at === 'number' ? { at: m.at } : {}),
                      };
                    }
                    return {
                      role: m.role as 'user' | 'assistant',
                      text: m.text as string,
                      ...(typeof m.at === 'number' ? { at: m.at } : {}),
                    };
                  });
                setThreadHistory(addressRef.current, origin, requestId, frame.thid, history);
              }
              break;
            }
            default:
              break;
          }
          return true;
        };

        const { datachannel } = await createAc2Transport({
          requestId,
          signalClient: client,
          onSideChannel: (channel) => {
            console.log(`[ac2] Discovered channel: ${channel.label}`);
            if (channel.label === 'ac2-heartbeat') {
              heartbeatChannelRef.current = attachHeartbeatChannel(channel, {
                onPing: () => {
                  if (!active) return;
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
          client.close();
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
            lastUserActivityRef.current = Date.now();
            setLastHeartbeat(Date.now());
          },
          onOpen: () => {
            console.log('Data channel opened');
            if (active) {
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
              setIsConnected(false);
              setIsLoading(false);
              // Drop every stale transport ref so the next mount / reconnect
              // isn't blocked by the connection effect's guard.
              clearTransport();
            }
          },
        });
        ac2ClientRef.current = ac2;
      } catch (err: any) {
        console.error('Failed to setup connection:', err);
        clientRef.current = null;
        updateSessionStatus(requestId, origin, 'failed');
        if (active) {
          setError(err);
          setIsLoading(false);
          Alert.alert(
            'Connection Failed',
            err.message || 'Failed to setup connection to the peer',
            [{ text: 'OK' }],
          );
        }
      } finally {
        authFlowInProgressRef.current = false;
      }
    }

    setupConnection();

    return () => {
      active = false;
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
        clientRef.current.close();
        clientRef.current = null;
      }
    };
  }, [
    origin,
    requestId,
    accounts.length > 0,
    keys.length > 0,
    reconnectNonce,
    allowPasskeyCreation,
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
    lastHeartbeat,
    reset,
    reconnect,
    activeThid,
    openConversation,
    closeConversation,
    remoteThreads,
  };
}
