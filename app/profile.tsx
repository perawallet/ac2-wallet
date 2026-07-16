import {
  AgentIdentityDetailRows,
  DetailRow,
  extractAgentKeyFromMessages,
  truncateMiddle,
  type AgentIdentitySummary,
} from '@/components/AgentIdentityDetails';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { ac2MessagesStore } from '@/stores/ac2Messages';
import { agentIdentitiesStore } from '@/stores/agentIdentities';
import { sessionsStore } from '@/stores/sessions';
import { uiStore } from '@/stores/ui';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

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
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopiedField(field);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedField(null), 1500);
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

  // Cross-reference the AC2 message log — the source of truth for what was
  // actually granted on the wire — in case the local store record is
  // missing or out of sync (mirrors the diagnostics screen).
  const keyMeta = React.useMemo(() => {
    if (!resolved) return null;
    const scopedAc2 = ac2Messages.filter(
      (m) => m.origin === resolved.origin && m.requestId === resolved.requestId,
    );
    return extractAgentKeyFromMessages(scopedAc2);
  }, [ac2Messages, resolved]);

  const agentSummary: AgentIdentitySummary | null = React.useMemo(() => {
    if (!resolved || (!latestIdentity && !keyMeta)) return null;
    return {
      controllerDid: latestIdentity?.controllerDid ?? keyMeta?.controllerDid ?? '',
      agentDid: latestIdentity?.agentDid ?? keyMeta?.agentDid ?? '',
      publicKey: latestIdentity?.publicKey ?? keyMeta?.publicKey ?? '',
      materialHeld: keyMeta?.materialHeld,
      grantedAt: latestIdentity?.createdAt ?? keyMeta?.grantedAt ?? 0,
      keyId: latestIdentity?.keyId,
    };
  }, [keyMeta, latestIdentity, resolved]);

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
                  <MaterialIcons name="smart-toy" size={22} color="#6366F1" />
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

              {agentSummary ? (
                <AgentIdentityDetailRows
                  identity={agentSummary}
                  keyPrefix="profile"
                  onCopy={handleCopyField}
                  copiedField={copiedField}
                />
              ) : (
                <Text className="text-sm italic text-muted-foreground">
                  No identity granted yet
                </Text>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
