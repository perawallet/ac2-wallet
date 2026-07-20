/**
 * MMKV-backed store of Ed25519 identity keys the wallet has granted to AC2
 * agents (in response to a bootstrap `KeyRequest`). Holds metadata only —
 * private material lives in `lib/keystore` keyed by `keyId`.
 */

import { didKeyFromAddress, didKeyFromPublicKeyBase64, isDidKeyMultibase } from '@/lib/ac2/did';
import { Store } from '@tanstack/react-store';
import { createMMKV } from 'react-native-mmkv';

export interface AgentIdentity {
  /** Local id for list rendering; not part of any wire envelope. */
  id: string;
  /** Keystore key id holding the private material (in `./keystore.ts`). */
  keyId: string;
  /** The agent identity public key issued to the agent (base64). */
  publicKey: string;
  /** The agent's DID, derived from `publicKey` (did:key form). */
  agentDid: string;
  /** DID of the account that granted the identity (the connected wallet). */
  controllerDid: string;
  /** Connection scoping — mirrors `messages.ts` / `ac2Messages.ts`. */
  origin: string;
  requestId: string;
  /** When the identity was granted (ms). */
  createdAt: number;
}

export interface AgentIdentitiesState {
  identities: AgentIdentity[];
}

const agentIdentitiesStorage = createMMKV({ id: 'agent-identities' });

/**
 * Older builds stored `agentDid`/`controllerDid` as raw base64/address
 * concatenation (`did:key:<base64>`, `did:key:<address>`) instead of proper
 * multibase `did:key` identifiers. Re-derive them from the key material
 * (`publicKey`, `controllerDid`'s embedded address) that was always correct.
 */
function normalizeIdentity(identity: AgentIdentity): AgentIdentity {
  // Stored JSON may predate the current schema — treat missing/non-string
  // fields as empty rather than throwing (which would blank the whole list
  // via `loadInitial`'s catch).
  let agentDid = typeof identity.agentDid === 'string' ? identity.agentDid : '';
  let controllerDid = typeof identity.controllerDid === 'string' ? identity.controllerDid : '';
  if (!isDidKeyMultibase(agentDid) && identity.publicKey) {
    try {
      agentDid = didKeyFromPublicKeyBase64(identity.publicKey);
    } catch {
      // Leave the stored value as-is if it can't be re-derived.
    }
  }
  if (!isDidKeyMultibase(controllerDid) && controllerDid) {
    try {
      controllerDid = didKeyFromAddress(controllerDid.replace(/^did:key:/, ''));
    } catch {
      // Leave the stored value as-is if it can't be re-derived.
    }
  }
  return { ...identity, agentDid, controllerDid };
}

const loadInitial = (): AgentIdentitiesState => {
  try {
    const stored = agentIdentitiesStorage.getString('identities');
    if (stored) {
      const identities = (JSON.parse(stored) as AgentIdentity[]).map(normalizeIdentity);
      return { identities };
    }
  } catch (error) {
    console.error('Failed to load agent identities from storage:', error);
  }
  return { identities: [] };
};

export const agentIdentitiesStore = new Store<AgentIdentitiesState>(loadInitial());

agentIdentitiesStore.subscribe(() => {
  try {
    agentIdentitiesStorage.set('identities', JSON.stringify(agentIdentitiesStore.state.identities));
  } catch (error) {
    console.error('Failed to save agent identities to storage:', error);
  }
});

/**
 * Record (or refresh) an agent identity grant. De-duped by `publicKey` within a
 * connection so re-granting the same key updates the existing record in place
 * rather than appending a duplicate.
 */
export function recordAgentIdentity(identity: Omit<AgentIdentity, 'id' | 'createdAt'>) {
  agentIdentitiesStore.setState((state) => {
    const existingIndex = state.identities.findIndex(
      (i) =>
        i.publicKey === identity.publicKey &&
        i.origin === identity.origin &&
        i.requestId === identity.requestId,
    );
    if (existingIndex !== -1) {
      const identities = [...state.identities];
      identities[existingIndex] = {
        ...identities[existingIndex],
        ...identity,
      };
      return { ...state, identities };
    }
    return {
      ...state,
      identities: [
        ...state.identities,
        {
          ...identity,
          id: Math.random().toString(36).slice(2, 10),
          createdAt: Date.now(),
        },
      ],
    };
  });
}

/**
 * Remove every agent identity granted on a connection, regardless of the local
 * address. Used when forgetting a persisted connection.
 */
export function clearAgentIdentitiesByConnection(origin: string, requestId: string) {
  agentIdentitiesStore.setState((state) => ({
    ...state,
    identities: state.identities.filter((i) => i.origin !== origin || i.requestId !== requestId),
  }));
}

export function clearAllAgentIdentities() {
  agentIdentitiesStore.setState((state) => ({ ...state, identities: [] }));
}
