import { extractAgentKeyFromMessages, getAgentMaterialHeld } from '@/lib/ac2/identitySummary';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import { encodeAddress } from '@algorandfoundation/keystore';
import { Buffer } from 'buffer';

const CONTROLLER_PUBLIC_KEY = new Uint8Array(32).map((_, i) => i);
const CONTROLLER_ADDRESS = encodeAddress(CONTROLLER_PUBLIC_KEY);
const CONTROLLER_DID = 'did:key:z6MkeTGwHmLmuCmgg4ABYhzWVh6ZX7hTwWt8gguAretUfc9c';

const AGENT_PUBLIC_KEY = new Uint8Array(32).map((_, i) => i + 1);
const AGENT_PUBLIC_KEY_B64 = Buffer.from(AGENT_PUBLIC_KEY).toString('base64');
const AGENT_DID = 'did:key:z6MkeXCES4onVW4up9Qgz1KRnZsKmGufcaZxF6Zpv2w5QwUK';

function buildKeyResponseEntry(overrides: Partial<Ac2MessageEntry> = {}): Ac2MessageEntry {
  return {
    id: 'msg-1',
    receivedAt: 1700000000000,
    origin: 'https://example.com',
    requestId: 'req-1',
    address: CONTROLLER_ADDRESS,
    direction: 'outbound',
    envelope: {
      id: 'env-1',
      type: 'ac2/KeyResponse',
      // The wire `from` is intentionally the (invalid) legacy form here —
      // extraction must derive from key material, not this string.
      from: `did:key:${CONTROLLER_ADDRESS}`,
      to: ['did:ac2:agent'],
      created_time: 1700000000,
      body: {
        status: 'approved',
        public_key: AGENT_PUBLIC_KEY_B64,
        material: 'somematerial',
      },
    } as any,
    ...overrides,
  };
}

describe('extractAgentKeyFromMessages', () => {
  it('derives correct multibase did:key values from the address and public key', () => {
    const result = extractAgentKeyFromMessages([buildKeyResponseEntry()]);

    expect(result?.controllerDid).toBe(CONTROLLER_DID);
    expect(result?.agentDid).toBe(AGENT_DID);
    expect(result?.publicKey).toBe(AGENT_PUBLIC_KEY_B64);
    expect(result?.materialHeld).toBe(true);
  });

  it('returns null when no approved KeyResponse is present', () => {
    expect(extractAgentKeyFromMessages([])).toBeNull();

    const rejected = buildKeyResponseEntry();
    (rejected.envelope.body as any).status = 'rejected';
    expect(extractAgentKeyFromMessages([rejected])).toBeNull();
  });

  it('leaves the controller DID blank instead of throwing on an undecodable address', () => {
    const entry = buildKeyResponseEntry({ address: 'not-an-address' });

    const result = extractAgentKeyFromMessages([entry]);
    expect(result?.controllerDid).toBe('');
    expect(result?.agentDid).toBe(AGENT_DID);
    expect(result?.materialHeld).toBe(true);
  });

  it('picks the most recently received approved grant', () => {
    const older = buildKeyResponseEntry({ id: 'msg-1', receivedAt: 1 });
    const newer = buildKeyResponseEntry({ id: 'msg-2', receivedAt: 2 });
    const result = extractAgentKeyFromMessages([older, newer]);
    expect(result?.grantedAt).toBe(2);
  });
});

describe('getAgentMaterialHeld', () => {
  const scope = {
    origin: 'https://example.com',
    requestId: 'req-1',
    publicKey: AGENT_PUBLIC_KEY_B64,
  };

  it('reports material held for a matching approved grant', () => {
    expect(getAgentMaterialHeld([buildKeyResponseEntry()], scope)).toBe(true);
  });

  it('reports not held when the response carried no material', () => {
    const entry = buildKeyResponseEntry();
    (entry.envelope.body as any).material = 'rejected';
    expect(getAgentMaterialHeld([entry], scope)).toBe(false);
  });

  it('returns undefined when no response matches the connection scope', () => {
    const entry = buildKeyResponseEntry({ origin: 'https://other.example' });
    expect(getAgentMaterialHeld([entry], scope)).toBeUndefined();
  });
});
