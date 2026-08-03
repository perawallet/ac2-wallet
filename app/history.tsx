import { formatTime } from '@/components/chat/format';
import { Button } from '@/components/ui/button';
import { RawContentViewer } from '@/components/ui/RawContentViewer';
import { Text } from '@/components/ui/text';
import { DEFAULT_THID } from '@/lib/ac2';
import { directionLabel } from '@/lib/ac2/messageDisplay';
import { THEME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import { ac2MessagesStore } from '@/stores/ac2Messages';
import { uiStore } from '@/stores/ui';
import type { AC2SigningResponse } from '@algorandfoundation/ac2-sdk/schema';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import * as FileSystem from 'expo-file-system/legacy';
import { Stack } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Alert, FlatList, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function getSignature(entry: Ac2MessageEntry): string | null {
  if (entry.envelope.type !== 'ac2/SigningResponse') return null;
  return (entry.envelope as AC2SigningResponse).body.signature ?? null;
}

function MetaRow({
  label,
  value,
  mono,
  ellipsis,
}: {
  label: string;
  value: string;
  mono?: boolean;
  ellipsis?: 'middle' | 'tail';
}) {
  return (
    <View className="flex-row items-center gap-3 px-3 py-2">
      <Text className="w-16 text-xs font-medium text-muted-foreground">{label}</Text>
      <Text
        className={cn('flex-1 text-right text-xs text-foreground', mono && 'font-mono')}
        numberOfLines={1}
        ellipsizeMode={ellipsis ?? 'tail'}
      >
        {value}
      </Text>
    </View>
  );
}

function MessageCard({ entry }: { entry: Ac2MessageEntry }) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const { envelope } = entry;
  const signature = getSignature(entry);
  const threadLabel = !entry.thid || entry.thid === DEFAULT_THID ? 'Main' : entry.thid;

  return (
    <View
      className={cn(
        'mb-3 self-stretch rounded-xl border border-border bg-card p-3',
        entry.direction === 'outbound'
          ? 'border-r-4 border-r-primary'
          : 'border-l-4 border-l-primary',
      )}
    >
      {/* Header */}
      <View className="flex-row items-center gap-1.5">
        <MaterialIcons name="vpn-key" size={18} color={palette.primary} />
        <Text className="flex-1 font-mono text-xs font-bold text-primary" numberOfLines={1}>
          {envelope.type}
        </Text>
      </View>

      {/* Metadata table — matches TechnicalDetails DetailRow style */}
      <View className="mt-2 divide-y divide-border rounded-lg border border-border">
        <MetaRow label="Direction" value={directionLabel(entry.direction)} />
        <MetaRow label="From" value={envelope.from ?? ''} mono ellipsis="middle" />
        <MetaRow label="Thread" value={threadLabel} />
        {envelope.id && <MetaRow label="ID" value={envelope.id} mono ellipsis="middle" />}
      </View>

      {signature && (
        <RawContentViewer
          className="mb-2 mt-2"
          contentType="signature"
          content={signature}
          collapsedLines={2}
        />
      )}

      <RawContentViewer
        className="mt-2"
        contentType="json"
        content={JSON.stringify(envelope, null, 2)}
      />
      <Text className="mt-1 self-end text-[10px] text-muted-foreground">
        {formatTime(entry.receivedAt)}
      </Text>
    </View>
  );
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;

  const origin = useStore(uiStore, (s) => s.currentOrigin);
  const requestId = useStore(uiStore, (s) => s.currentSessionId);
  const activeThid = useStore(uiStore, (s) => s.activeThid);

  const threadLabel = activeThid === DEFAULT_THID || activeThid === null ? 'Main' : activeThid;

  const entries = useStore(ac2MessagesStore, (state) =>
    state.messages
      .filter(
        (m) =>
          m.origin === origin &&
          m.requestId === requestId &&
          (m.thid ?? DEFAULT_THID) === (activeThid ?? DEFAULT_THID),
      )
      .sort((a, b) => a.receivedAt - b.receivedAt),
  );

  const getExportPayload = React.useCallback(() => {
    if (entries.length === 0) {
      Alert.alert('Nothing to export', 'There are no AC2 messages to export yet.');
      return null;
    }
    return {
      json: JSON.stringify(entries, null, 2),
      filename: `ac2-telemetry-${new Date().toISOString().replace(/:/g, '-')}.json`,
    };
  }, [entries]);

  const handleShare = React.useCallback(async () => {
    const payload = getExportPayload();
    if (!payload) return;
    const { json, filename } = payload;
    try {
      const fileUri = `${FileSystem.documentDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(fileUri, json);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/json',
          dialogTitle: 'Export AC2 Telemetry Trace',
          UTI: 'public.json',
        });
      } else {
        Alert.alert('Export saved', `Saved telemetry trace to ${filename}.`);
      }
    } catch {
      Alert.alert('Export failed', 'Could not export the telemetry trace.');
    }
  }, [getExportPayload]);

  // Android's share sheet doesn't reliably persist to a user-chosen location,
  // so this lets the user pick a destination directory directly via SAF.
  const handleSaveAndroid = React.useCallback(async () => {
    const payload = getExportPayload();
    if (!payload) return;
    const { json, filename } = payload;
    try {
      const permissions =
        await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permissions.granted) return;
      const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
        permissions.directoryUri,
        filename,
        'application/json',
      );
      await FileSystem.writeAsStringAsync(fileUri, json);
      Alert.alert('Export saved', `Saved telemetry trace to ${filename}.`);
    } catch {
      Alert.alert('Export failed', 'Could not export the telemetry trace.');
    }
  }, [getExportPayload]);

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'AC2 History',
          headerTintColor: palette.foreground,
          headerTitleStyle: {
            fontSize: 16,
            fontWeight: '600',
          },
          headerRight: () =>
            Platform.OS === 'android' ? (
              <View className="flex-row gap-2">
                <Button variant="secondary" size="sm" onPress={handleSaveAndroid}>
                  <Text className="text-sm">Export</Text>
                </Button>
                <Button variant="secondary" size="sm" onPress={handleShare}>
                  <Text className="text-sm">Share</Text>
                </Button>
              </View>
            ) : (
              <Button variant="secondary" size="sm" onPress={handleShare}>
                <Text className="text-sm">Export</Text>
              </Button>
            ),
        }}
      />

      <View className="border-b border-border bg-card px-4 py-2">
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          Thread: {threadLabel}
        </Text>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(entry) => entry.id}
        renderItem={({ item }) => <MessageCard entry={item} />}
        contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 16 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View className="items-center py-16">
            <MaterialIcons name="inbox" size={32} color={palette.mutedForeground} />
            <Text className="mt-2 text-sm text-muted-foreground">No AC2 messages yet.</Text>
          </View>
        }
      />
    </View>
  );
}
