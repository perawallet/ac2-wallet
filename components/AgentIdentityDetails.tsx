/**
 * Shared rendering for an AC2 agent identity grant — used by both the
 * Profile overlay (current session) and the Credentials screen (all
 * granted identities) so the two surfaces stay in sync.
 */

import { Text } from '@/components/ui/text';
import { type AgentIdentitySummary } from '@/lib/ac2/identitySummary';
import { THEME } from '@/lib/theme';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';

export {
  extractAgentKeyFromMessages,
  getAgentMaterialHeld,
  type AgentIdentitySummary,
} from '@/lib/ac2/identitySummary';

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
