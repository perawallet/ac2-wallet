import { formatTime } from '@/components/chat/format';
import { Button } from '@/components/ui/button';
import { RawContentViewer } from '@/components/ui/RawContentViewer';
import { Text } from '@/components/ui/text';
import { DEFAULT_THID } from '@/lib/ac2';
import { THEME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import { ac2MessagesStore } from '@/stores/ac2Messages';
import { uiStore } from '@/stores/ui';
import type { AC2SigningResponse } from '@algorandfoundation/ac2-sdk/schema';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { Stack } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Alert, FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SUCCESS = '#10B981';

function getSignature(entry: Ac2MessageEntry): string | null {
  if (entry.envelope.type !== 'ac2/SigningResponse') return null;
  return (entry.envelope as AC2SigningResponse).body.signature ?? null;
}

async function copyToClipboard(value: string, label: string) {
  try {
    await Clipboard.setStringAsync(value);
    Alert.alert('Copied', `${label} copied to clipboard.`);
  } catch {
    Alert.alert('Copy failed', 'Could not copy to the clipboard.');
  }
}

function MessageCard({ entry }: { entry: Ac2MessageEntry }) {
  const isOutbound = entry.direction === 'outbound';
  const { envelope } = entry;
  const signature = getSignature(entry);

  return (
    <View
      className={cn(
        'mb-3 self-stretch rounded-xl border border-border bg-white p-3 dark:bg-slate-800',
        isOutbound ? 'border-r-4 border-r-primary' : 'border-l-4 border-l-primary',
      )}
    >
      {/* Header — matches Ac2MessageCard layout */}
      <View className="flex-row items-center gap-1.5">
        <MaterialIcons name="vpn-key" size={14} color="#6366F1" />
        <Text className="flex-1 font-mono text-xs font-bold text-primary" numberOfLines={1}>
          {envelope.type}
        </Text>
        <Text className="text-[11px] font-semibold text-primary">
          {isOutbound ? '→ peer' : 'peer →'}
        </Text>
      </View>

      {/* Metadata rows */}
      <Text
        className="mt-1.5 font-mono text-xs text-muted-foreground"
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        From: {envelope.from}
      </Text>
      {entry.thid && (
        <Text
          className="mt-0.5 font-mono text-xs text-muted-foreground"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          Thread: {entry.thid}
        </Text>
      )}
      {envelope.id && (
        <Text className="mb-1.5 mt-0.5 font-mono text-xs font-bold text-emerald-500">
          ID: {envelope.id.slice(0, 16)}...
        </Text>
      )}

      {signature && (
        <View className="mb-2 rounded-lg bg-slate-800 p-2 dark:bg-slate-950">
          <View className="mb-1 flex-row items-center gap-1">
            <MaterialIcons name="verified" size={13} color={SUCCESS} />
            <Text className="flex-1 font-mono text-xs font-bold text-slate-200">Signature</Text>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onPress={() => copyToClipboard(signature, 'Signature')}
            >
              <MaterialIcons name="content-copy" size={13} color="#E2E8F0" />
              <Text className="text-xs text-slate-200">Copy</Text>
            </Button>
          </View>
          <Text
            className="font-mono text-[11px] text-emerald-400"
            numberOfLines={2}
            ellipsizeMode="middle"
          >
            {signature}
          </Text>
        </View>
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

  const handleExport = React.useCallback(async () => {
    if (entries.length === 0) {
      Alert.alert('Nothing to export', 'There are no AC2 messages to export yet.');
      return;
    }
    try {
      const json = JSON.stringify(entries, null, 2);
      const filename = `ac2-telemetry-${new Date().toISOString().replace(/:/g, '-')}.json`;
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
  }, [entries]);

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
          headerRight: () => (
            <Button variant="secondary" size="sm" onPress={handleExport}>
              <Text className="text-sm">Export JSON</Text>
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
