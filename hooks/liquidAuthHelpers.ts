/**
 * Pure helpers shared by the Liquid Auth connection flow in `useConnection`.
 * Kept side-effect-free (aside from `persistKeyMetadata`, which writes the
 * keystore) so they are easy to reason about and test in isolation.
 */
import type { Passkey } from '@/extensions/passkeys';
import { keyStore } from '@/stores/keystore';
import { toUrlSafe } from '@/utils/base64';
import type { Key, KeyData } from '@algorandfoundation/keystore';
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

export function passkeysFromSessionUser(sessionData: any, origin: string): Passkey[] {
  const wallet = sessionAddressFromData(sessionData) ?? undefined;
  const credentials = Array.isArray(sessionData?.user?.credentials)
    ? sessionData.user.credentials
    : [];

  return credentials
    .filter((credential: any) => typeof credential?.credId === 'string')
    .map((credential: any) => ({
      id: credential.credId,
      name: `${wallet ?? 'Liquid Auth'}@${normalizeOriginHost(origin)}`,
      userHandle: wallet,
      origin,
      publicKey: new Uint8Array(),
      algorithm: 'P256',
      metadata: {
        origin,
        userHandle: wallet,
        registered: true,
        source: 'liquid-auth-session',
      },
    }));
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
    typeof userHandle === 'string' &&
    userHandle === sessionAddress &&
    passkey.metadata?.registered === true
  );
}
