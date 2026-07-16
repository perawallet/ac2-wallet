import { encodeAddress } from '@algorandfoundation/keystore';
import { Buffer } from 'buffer';

const PUBLIC_KEY = new Uint8Array(32).map((_, i) => i);
const PUBLIC_KEY_B64 = Buffer.from(PUBLIC_KEY).toString('base64');
const ADDRESS = encodeAddress(PUBLIC_KEY);
const EXPECTED_DID = 'did:key:z6MkeTGwHmLmuCmgg4ABYhzWVh6ZX7hTwWt8gguAretUfc9c';

// Simulates a record written by the pre-fix code, which built `did:key:`
// by concatenating a raw base64 key / Algorand address instead of encoding
// the key as multibase.
const MALFORMED_STORED_IDENTITY = {
  id: 'abc123',
  keyId: 'key-1',
  publicKey: PUBLIC_KEY_B64,
  agentDid: `did:key:${PUBLIC_KEY_B64}`,
  controllerDid: `did:key:${ADDRESS}`,
  origin: 'https://example.com',
  requestId: 'req-1',
  createdAt: 1700000000000,
};

describe('agentIdentitiesStore load-time normalization', () => {
  it('re-derives malformed did:key values stored by older builds', () => {
    jest.resetModules();
    jest.doMock('react-native-mmkv', () => ({
      createMMKV: () => ({
        getString: () => JSON.stringify([MALFORMED_STORED_IDENTITY]),
        set: () => {},
      }),
    }));

    const { agentIdentitiesStore } = require('@/stores/agentIdentities');
    const [identity] = agentIdentitiesStore.state.identities;

    expect(identity.agentDid).toBe(EXPECTED_DID);
    expect(identity.controllerDid).toBe(EXPECTED_DID);
    // Untouched fields survive normalization.
    expect(identity.publicKey).toBe(PUBLIC_KEY_B64);
    expect(identity.id).toBe('abc123');

    jest.dontMock('react-native-mmkv');
  });

  it('leaves already-correct multibase did:key values untouched', () => {
    jest.resetModules();
    jest.doMock('react-native-mmkv', () => ({
      createMMKV: () => ({
        getString: () =>
          JSON.stringify([
            { ...MALFORMED_STORED_IDENTITY, agentDid: EXPECTED_DID, controllerDid: EXPECTED_DID },
          ]),
        set: () => {},
      }),
    }));

    const { agentIdentitiesStore } = require('@/stores/agentIdentities');
    const [identity] = agentIdentitiesStore.state.identities;

    expect(identity.agentDid).toBe(EXPECTED_DID);
    expect(identity.controllerDid).toBe(EXPECTED_DID);

    jest.dontMock('react-native-mmkv');
  });
});
