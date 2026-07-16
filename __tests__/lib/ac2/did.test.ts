import {
  didKeyFromAddress,
  didKeyFromPublicKey,
  didKeyFromPublicKeyBase64,
  isDidKeyMultibase,
} from '@/lib/ac2/did';
import { encodeAddress } from '@algorandfoundation/keystore';
import { Buffer } from 'buffer';

// Fixed 32-byte Ed25519 public key so `did:key` output is a stable vector.
const PUBLIC_KEY = new Uint8Array(32).map((_, i) => i);
const EXPECTED_DID = 'did:key:z6MkeTGwHmLmuCmgg4ABYhzWVh6ZX7hTwWt8gguAretUfc9c';

describe('didKeyFromPublicKey', () => {
  it('encodes a raw Ed25519 public key as a multibase did:key', () => {
    expect(didKeyFromPublicKey(PUBLIC_KEY)).toBe(EXPECTED_DID);
  });
});

describe('didKeyFromPublicKeyBase64', () => {
  it('encodes a base64 Ed25519 public key the same way as the raw form', () => {
    const b64 = Buffer.from(PUBLIC_KEY).toString('base64');
    expect(didKeyFromPublicKeyBase64(b64)).toBe(EXPECTED_DID);
  });
});

describe('didKeyFromAddress', () => {
  it('derives the same did:key as the underlying public key', () => {
    const address = encodeAddress(PUBLIC_KEY);
    expect(didKeyFromAddress(address)).toBe(EXPECTED_DID);
  });

  it('throws on a malformed address instead of silently producing a bad DID', () => {
    expect(() => didKeyFromAddress('not-an-address')).toThrow();
  });
});

describe('isDidKeyMultibase', () => {
  it('accepts a proper multibase did:key', () => {
    expect(isDidKeyMultibase(EXPECTED_DID)).toBe(true);
  });

  it('rejects a base64-concatenated did:key', () => {
    expect(isDidKeyMultibase('did:key:NfFrI6c9w63xwCfZzMWCIzzCmImpej9K1gOn/8pPWtA=')).toBe(false);
  });

  it('rejects an Algorand-address-concatenated did:key', () => {
    expect(
      isDidKeyMultibase('did:key:MDWZRS7I5GKAAZDYDU3B4AQNM2G4WYDXMBPF7J6BP4SQAG3UBPIZDRDBGE'),
    ).toBe(false);
  });
});
