/**
 * Pure helpers for summarizing an AC2 agent-identity grant from the local
 * message log. Extracted from `components/AgentIdentityDetails.tsx` (which
 * re-exports them) so they carry no UI or runtime-SDK imports and stay unit
 * testable — Jest's module mapper can't resolve `ac2-sdk` subpath exports,
 * so the SDK import below must remain type-only.
 */

import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import { didKeyFromAddress, didKeyFromPublicKeyBase64 } from '@/lib/ac2/did';
import type { AC2MessageType } from '@algorandfoundation/ac2-sdk/schema';

/** `AC2MessageTypes.KEY_RESPONSE`, inlined but compile-checked against the SDK. */
const KEY_RESPONSE = 'ac2/KeyResponse' satisfies AC2MessageType;

/** The fields shown for a granted agent identity, regardless of screen. */
export interface AgentIdentitySummary {
  controllerDid: string;
  agentDid: string;
  publicKey: string;
  /** `undefined` when we can't determine whether the agent holds material. */
  materialHeld?: boolean;
  grantedAt: number;
  keyId?: string;
}

/**
 * Determines whether the agent was handed private material for a given
 * grant, by looking for the approved `KeyResponse` scoped to the same
 * connection and public key.
 */
export function getAgentMaterialHeld(
  ac2Messages: Ac2MessageEntry[],
  params: { origin: string; requestId: string; publicKey: string },
): boolean | undefined {
  let result: boolean | undefined;
  let latestAt = -Infinity;
  for (const entry of ac2Messages) {
    if (entry.origin !== params.origin || entry.requestId !== params.requestId) continue;
    const env = entry.envelope;
    if (env.type !== KEY_RESPONSE) continue;
    const body = env.body as { status?: string; public_key?: string; material?: string };
    if (body.status !== 'approved' || body.public_key !== params.publicKey) continue;
    if (entry.receivedAt >= latestAt) {
      latestAt = entry.receivedAt;
      result = !!body.material && body.material !== 'rejected';
    }
  }
  return result;
}

/**
 * The agent identity as actually recorded on the wire, taken from the most
 * recent approved `KeyResponse` in a connection's AC2 message log. This is
 * the source of truth for what was granted — unlike the locally-stored
 * `AgentIdentity`, it can't drift out of sync with the protocol messages.
 * `ac2Messages` should already be scoped to a single connection (origin +
 * requestId).
 */
export function extractAgentKeyFromMessages(
  ac2Messages: Ac2MessageEntry[],
): Pick<
  AgentIdentitySummary,
  'controllerDid' | 'agentDid' | 'publicKey' | 'materialHeld' | 'grantedAt'
> | null {
  let latest: Pick<
    AgentIdentitySummary,
    'controllerDid' | 'agentDid' | 'publicKey' | 'materialHeld' | 'grantedAt'
  > | null = null;
  for (const entry of ac2Messages) {
    const env = entry.envelope;
    if (env.type !== KEY_RESPONSE) continue;
    const body = env.body as { status?: string; public_key?: string; material?: string };
    if (body.status !== 'approved') continue;
    const publicKey = body.public_key ?? '';
    // Derive both DIDs from the underlying key material (`entry.address` /
    // `body.public_key`) rather than the wire `from` string or a raw
    // base64 key, since neither is a valid `did:key` on its own.
    let controllerDid = '';
    try {
      controllerDid = didKeyFromAddress(entry.address);
    } catch {
      // Leave blank if the stored address can't be decoded.
    }
    let agentDid = '';
    try {
      agentDid = publicKey ? didKeyFromPublicKeyBase64(publicKey) : '';
    } catch {
      // Leave blank if the public key can't be decoded.
    }
    const candidate = {
      controllerDid,
      agentDid,
      publicKey,
      materialHeld: !!body.material && body.material !== 'rejected',
      grantedAt: entry.receivedAt,
    };
    if (!latest || candidate.grantedAt >= latest.grantedAt) latest = candidate;
  }
  return latest;
}
