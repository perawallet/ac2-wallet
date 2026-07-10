import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { ac2MessagesStore, type Ac2MessageEntry } from '@/stores/ac2Messages';
import { agentIdentitiesStore } from '@/stores/agentIdentities';
import { sessionsStore } from '@/stores/sessions';
import { uiStore } from '@/stores/ui';
import { AC2MessageTypes } from '@algorandfoundation/ac2-sdk/schema';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import * as Clipboard from 'expo-clipboard';
import { Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

interface AgentKeyMetadata {
  controllerDid: string;
  publicKey: string;
  materialHeld: boolean;
  grantedAt: number;
}

function truncateMiddle(value: string, head = 10, tail = 8): string {
  if (!value) return '';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatTimestamp(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function DetailRow({
  label,
  value,
  mono = false,
  onLongPress,
  copied = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onLongPress?: () => void;
  copied?: boolean;
}) {
  const isCopyable = typeof onLongPress === 'function' && value !== '—';
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  return (
    <Pressable
      onLongPress={onLongPress}
      disabled={!isCopyable}
      delayLongPress={250}
      accessibilityRole={isCopyable ? 'button' : undefined}
      accessibilityHint={isCopyable ? 'Long press to copy to clipboard' : undefined}
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
          <MaterialIcons
            name={copied ? 'check' : 'content-copy'}
            size={14}
            color={copied ? '#10B981' : palette.mutedForeground}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

function extractAgentKey(ac2Msgs: Ac2MessageEntry[]): AgentKeyMetadata | null {
  let latest: AgentKeyMetadata | null = null;
  for (const entry of ac2Msgs) {
    const env = entry.envelope;
    if (env.type !== AC2MessageTypes.KEY_RESPONSE) continue;
    const body = env.body as {
      status?: string;
      public_key?: string;
      material?: string;
    };
    if (body.status !== 'approved') continue;
    const candidate: AgentKeyMetadata = {
      controllerDid: env.from,
      publicKey: body.public_key ?? '',
      materialHeld: !!body.material && body.material !== 'rejected',
      grantedAt: entry.receivedAt,
    };
    if (!latest || candidate.grantedAt >= latest.grantedAt) latest = candidate;
  }
  return latest;
}

export default function ProfileOverlay() {
  const sessions = useStore(sessionsStore, (s) => s.sessions);
  const currentId = useStore(uiStore, (s) => s.currentSessionId);
  const currentOrigin = useStore(uiStore, (s) => s.currentOrigin);
  const agentIdentities = useStore(agentIdentitiesStore, (s) => s.identities);
  const ac2Messages = useStore(ac2MessagesStore, (s) => s.messages);
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [copiedField, setCopiedField] = React.useState<string | null>(null);
  const copyResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  const handleCopyField = React.useCallback(async (field: string, value: string) => {
    if (!value || value === '—') return;
    await Clipboard.setStringAsync(value);
    setCopiedField(field);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedField(null), 1400);
  }, []);

  // Match Chat tab resolution rules so this route reflects the same connection.
  const resolved = React.useMemo(() => {
    if (currentId && currentOrigin) return { origin: currentOrigin, requestId: currentId };
    const ordered = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);
    const fallback = ordered.find((s) => s.id === currentId) ?? ordered[0] ?? null;
    if (!fallback) return null;
    return { origin: fallback.origin, requestId: fallback.id };
  }, [currentId, currentOrigin, sessions]);

  const scopedIdentities = React.useMemo(() => {
    if (!resolved) return [];
    return agentIdentities
      .filter((i) => i.origin === resolved.origin && i.requestId === resolved.requestId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [agentIdentities, resolved]);

  const latestIdentity = scopedIdentities[0] ?? null;

  const keyMeta = React.useMemo(() => {
    if (!resolved) return null;
    const scopedAc2 = ac2Messages.filter(
      (m) => m.origin === resolved.origin && m.requestId === resolved.requestId,
    );
    return extractAgentKey(scopedAc2);
  }, [ac2Messages, resolved]);

  return (
    <Screen className="flex-1" edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Agent Profile',
          headerShown: true,
          headerTintColor: palette.foreground,
          headerTitleStyle: {
            fontSize: 16,
            fontWeight: '600',
          },
        }}
      />

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>
        {!resolved ? (
          <View className="mt-16 items-center gap-3">
            <View className="h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <MaterialIcons name="smart-toy" size={30} color={palette.mutedForeground} />
            </View>
            <Text className="text-xl font-bold text-foreground">No active session</Text>
            <Text className="max-w-[280px] text-center text-sm text-muted-foreground">
              Open or scan a chat connection first, then return to view this agent identity.
            </Text>
          </View>
        ) : (
          <>
            <View className="mb-3 rounded-2xl bg-card p-5 gap-3">
              <View className="flex-row items-center gap-3">
                <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <MaterialIcons name="link" size={20} color={palette.mutedForeground} />
                </View>
                <View className="flex-1">
                  <Text className="text-base font-semibold text-card-foreground" numberOfLines={1}>
                    {resolved.origin}
                  </Text>
                  <Text
                    className="text-sm text-muted-foreground"
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {truncateMiddle(resolved.requestId)}
                  </Text>
                </View>
              </View>
              <DetailRow label="Request ID" value={resolved.requestId} mono />
            </View>

            <View className="rounded-2xl bg-card p-5 gap-3">
              <View className="flex-row items-center gap-3">
                <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <MaterialIcons name="vpn-key" size={20} color={palette.primary} />
                </View>
                <View className="flex-1">
                  <Text className="text-base font-semibold text-card-foreground">
                    Agent identity
                  </Text>
                  <Text className="text-sm text-muted-foreground">
                    Current chat/session key material
                  </Text>
                </View>
              </View>

              {latestIdentity || keyMeta ? (
                <View className="gap-1">
                  <DetailRow
                    label="Controller DID"
                    value={latestIdentity?.controllerDid ?? keyMeta?.controllerDid ?? '—'}
                    mono
                    onLongPress={() =>
                      handleCopyField(
                        'controllerDid',
                        latestIdentity?.controllerDid ?? keyMeta?.controllerDid ?? '',
                      )
                    }
                    copied={copiedField === 'controllerDid'}
                  />
                  <DetailRow
                    label="Agent DID"
                    value={latestIdentity?.agentDid ?? '—'}
                    mono
                    onLongPress={() => handleCopyField('agentDid', latestIdentity?.agentDid ?? '')}
                    copied={copiedField === 'agentDid'}
                  />
                  <DetailRow
                    label="Agent key"
                    value={latestIdentity?.publicKey ?? keyMeta?.publicKey ?? '—'}
                    mono
                    onLongPress={() =>
                      handleCopyField(
                        'publicKey',
                        latestIdentity?.publicKey ?? keyMeta?.publicKey ?? '',
                      )
                    }
                    copied={copiedField === 'publicKey'}
                  />
                  <DetailRow
                    label="Material"
                    value={
                      keyMeta
                        ? keyMeta.materialHeld
                          ? 'Held by agent'
                          : 'Not provided'
                        : 'Unknown'
                    }
                  />
                  <DetailRow
                    label="Granted"
                    value={formatTimestamp(latestIdentity?.createdAt ?? keyMeta?.grantedAt ?? 0)}
                  />
                  <DetailRow
                    label="Keystore ID"
                    value={latestIdentity?.keyId ?? '—'}
                    mono
                    onLongPress={() => handleCopyField('keyId', latestIdentity?.keyId ?? '')}
                    copied={copiedField === 'keyId'}
                  />
                </View>
              ) : (
                <Text className="text-sm italic text-muted-foreground">
                  No identity granted yet
                </Text>
              )}

              {latestIdentity || keyMeta ? (
                <Text className="text-xs text-muted-foreground">
                  Long press identity fields to copy
                </Text>
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
