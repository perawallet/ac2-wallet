/**
 * Shared rendering for an AC2 agent identity grant — used by both the
 * Profile overlay (current session) and the Credentials screen (all
 * granted identities) so the two surfaces stay in sync.
 */

import { Text } from '@/components/ui/text';
import { didKeyFromAddress, didKeyFromPublicKeyBase64 } from '@/lib/ac2/did';
import { THEME } from '@/lib/theme';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import { AC2MessageTypes } from '@algorandfoundation/ac2-sdk/schema';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';

export function truncateMiddle(value: string, head = 10, tail = 8): string {
  if (!value) return '';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatGrantedAt(ms?: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function DetailRow({
  label,
  value,
  mono = false,
  onPress,
  copied = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onPress?: () => void;
  copied?: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const iconColor = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;
  const isCopyable = typeof onPress === 'function' && value !== '—';
  return (
    <Pressable
      onPress={onPress}
      disabled={!isCopyable}
      accessibilityRole={isCopyable ? 'button' : undefined}
      accessibilityHint={isCopyable ? 'Tap to copy to clipboard' : undefined}
      className={`flex-row items-center gap-3 py-1 ${isCopyable ? 'active:opacity-80' : ''}`}
    >
      <Text className="shrink-0 text-sm text-muted-foreground">{label}</Text>
      <View className="min-w-0 flex-1 flex-row items-center justify-end gap-1.5">
        <Text
          className={`min-w-0 flex-1 text-right text-sm font-medium text-card-foreground ${mono ? 'font-mono' : ''}`}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {value}
        </Text>
        {isCopyable ? (
          <MaterialIcons name={copied ? 'check' : 'content-copy'} size={14} color={iconColor} />
        ) : null}
      </View>
    </Pressable>
  );
}

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
    if (env.type !== AC2MessageTypes.KEY_RESPONSE) continue;
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
    if (env.type !== AC2MessageTypes.KEY_RESPONSE) continue;
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

/**
 * Renders the standard set of agent identity fields, in a fixed order, so
 * every screen that shows a granted identity looks the same.
 */
export function AgentIdentityDetailRows({
  identity,
  keyPrefix,
  onCopy,
  copiedField,
}: {
  identity: AgentIdentitySummary;
  keyPrefix: string;
  onCopy: (field: string, value: string) => void;
  copiedField: string | null;
}) {
  const materialLabel =
    identity.materialHeld === undefined
      ? 'Unknown'
      : identity.materialHeld
        ? 'Held by agent'
        : 'Not provided';

  return (
    <View className="gap-1">
      <DetailRow
        label="Controller DID"
        value={identity.controllerDid || '—'}
        mono
        onPress={() => onCopy(`${keyPrefix}-controllerDid`, identity.controllerDid)}
        copied={copiedField === `${keyPrefix}-controllerDid`}
      />
      <DetailRow
        label="Agent DID"
        value={identity.agentDid || '—'}
        mono
        onPress={() => onCopy(`${keyPrefix}-agentDid`, identity.agentDid)}
        copied={copiedField === `${keyPrefix}-agentDid`}
      />
      <DetailRow
        label="Agent key"
        value={identity.publicKey || '—'}
        mono
        onPress={() => onCopy(`${keyPrefix}-publicKey`, identity.publicKey)}
        copied={copiedField === `${keyPrefix}-publicKey`}
      />
      <DetailRow label="Material" value={materialLabel} />
      <DetailRow label="Granted" value={formatGrantedAt(identity.grantedAt)} />
    </View>
  );
}
