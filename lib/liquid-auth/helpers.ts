/**
 * Pure helpers shared by the Liquid Auth connection flow in `useConnection`.
 * Kept side-effect-free (aside from `persistKeyMetadata`, which writes the
 * keystore) so they are easy to reason about and test in isolation.
 */
import type { Passkey } from '@/extensions/passkeys';
import { keyStore } from '@/stores/keystore';
import { decodeAddress } from '@/utils/algorand';
import { toUrlSafe } from '@/utils/base64';
import type { Key, KeyData } from '@algorandfoundation/keystore';
import { encodeAddress } from '@algorandfoundation/keystore';
import { encoding } from '@algorandfoundation/liquid-client';
import { encode, encryptData, storage } from '@algorandfoundation/react-native-keystore';
import { Buffer } from 'buffer';

/**
 * Re-encrypt a key record with the supplied master key and reflect the new
 * metadata in the reactive key store, bypassing the keystore library's
 * `commit()` (which would re-fetch the master key and prompt again).
 */
export function persistKeyMetadata(keyData: KeyData, masterKey: Buffer): void {
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

export function normalizeOriginHost(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

export function originMatches(storedOrigin: unknown, currentOrigin: string): boolean {
  return (
    typeof storedOrigin === 'string' &&
    storedOrigin.length > 0 &&
    normalizeOriginHost(storedOrigin) === normalizeOriginHost(currentOrigin)
  );
}

export function passkeyFromKey(keyData: Key): Passkey | null {
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

export function sessionAddressFromData(sessionData: any): string | null {
  return typeof sessionData?.address === 'string'
    ? sessionData.address
    : typeof sessionData?.user?.wallet === 'string'
      ? sessionData.user.wallet
      : typeof sessionData?.session?.wallet === 'string'
        ? sessionData.session.wallet
        : null;
}

/**
 * The requestId a `/auth/session` payload is currently bound to, if any. The
 * server persists it under `session.requestId` (and echoes it at the top level
 * in some responses), so both shapes are tolerated.
 */
export function sessionRequestIdFromData(sessionData: any): string | null {
  return typeof sessionData?.session?.requestId === 'string'
    ? sessionData.session.requestId
    : typeof sessionData?.requestId === 'string'
      ? sessionData.requestId
      : null;
}

/**
 * True when an existing `/auth/session` already authenticates this wallet key
 * for this exact requestId. When so, a reconnect can renegotiate over the
 * already-authenticated socket without a fresh passkey assertion — the server
 * re-announces presence for the bound requestId on the socket's reconnect,
 * which resolves the waiting peer's `link`.
 */
export function sessionAlreadyAuthenticatedForRequest(
  sessionData: any,
  key: Key,
  requestId: string,
): boolean {
  if (typeof requestId !== 'string' || requestId.length === 0) return false;
  const address = sessionAddressFromData(sessionData);
  return (
    !!address &&
    addressMatchesKey(address, key) &&
    sessionRequestIdFromData(sessionData) === requestId
  );
}

export function credentialIdFromData(data: any): string | null {
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

export function credentialArraysFromSession(sessionData: any): any[][] {
  return [
    sessionData?.user?.credentials,
    sessionData?.user?.passkeys,
    sessionData?.session?.credentials,
    sessionData?.session?.passkeys,
    sessionData?.credentials,
    sessionData?.passkeys,
  ].filter(Array.isArray);
}

export function credentialIdsFromSessionData(sessionData: any): string[] {
  return credentialArraysFromSession(sessionData)
    .flat()
    .map(credentialIdFromData)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function userHandleMatchesAddress(userHandle: unknown, address: string): boolean {
  if (typeof userHandle !== 'string' || userHandle.length === 0) return false;
  if (userHandle === address) return true;

  try {
    const publicKey = encoding.fromBase64Url(toUrlSafe(userHandle));
    return encodeAddress(publicKey) === address;
  } catch {
    return false;
  }
}

export function passkeysFromSessionUser(sessionData: any, origin: string): Passkey[] {
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

export function normalizeCredentialId(value: string): string {
  return toUrlSafe(value.trim());
}

export function credentialIdCandidates(credential: any): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) ids.add(normalizeCredentialId(value));
  };
  add(credential?.id);
  add(credential?.rawId ? encoding.toBase64URL(new Uint8Array(credential.rawId)) : null);
  add(credential?.rawId ? Buffer.from(new Uint8Array(credential.rawId)).toString('base64') : null);
  return ids;
}

export function keyMatchesCredential(key: Key, credentialIds: Set<string>): boolean {
  return credentialIds.has(normalizeCredentialId(key.id));
}

export function addressMatchesKey(address: string, key: Key): boolean {
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

export function passkeyMatchesConnection(
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
