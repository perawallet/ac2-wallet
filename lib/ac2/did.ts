/**
 * DID construction for AC2 identities. Both the controller (wallet account)
 * and agent (granted identity key) are Ed25519 keys, so both must use the
 * spec-compliant `did:key` multibase encoding (multicodec `0xed01` +
 * base58btc, `z`-prefixed) — matching `generateDidKey` from
 * `@algorandfoundation/identities-store`, which the agent side already uses.
 * Never build a `did:key` by concatenating a base64 string or Algorand
 * address directly; that produces a different (invalid) identifier for the
 * same key.
 */

import { decodeAddress } from '@/utils/algorand';
import { generateDidKey } from '@algorandfoundation/identities-store';
import { Buffer } from 'buffer';

/** `did:key` for a raw Ed25519 public key. */
export function didKeyFromPublicKey(publicKey: Uint8Array): string {
  return generateDidKey(publicKey);
}

/** `did:key` for a base64-encoded Ed25519 public key. */
export function didKeyFromPublicKeyBase64(publicKeyB64: string): string {
  return generateDidKey(new Uint8Array(Buffer.from(publicKeyB64, 'base64')));
}

/** `did:key` for the Ed25519 key underlying an Algorand address. */
export function didKeyFromAddress(address: string): string {
  return generateDidKey(decodeAddress(address).publicKey);
}

/** True if `value` is a spec-compliant `did:key` (base58btc multibase). */
export function isDidKeyMultibase(value: string): boolean {
  return value.startsWith('did:key:z');
}
