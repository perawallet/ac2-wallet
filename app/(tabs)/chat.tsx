import { ChatEmptyState } from '@/components/chat/ChatEmptyState';
import { ChatScreen } from '@/components/chat/ChatScreen';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { localStorage } from '@/stores/mmkv-local';
import { sessionsStore } from '@/stores/sessions';
import { setCurrentConnection, uiStore } from '@/stores/ui';
import { useStore } from '@tanstack/react-store';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

export default function ChatTab() {
  const router = useRouter();
  const sessions = useStore(sessionsStore, (s) => s.sessions);
  const currentId = useStore(uiStore, (s) => s.currentSessionId);
  const currentOrigin = useStore(uiStore, (s) => s.currentOrigin);
  const [disclaimerAccepted, setDisclaimerAccepted] = React.useState(() =>
    Boolean(localStorage.getBoolean('ac2DisclaimerSeen')),
  );

  const handleDisclaimerAccept = React.useCallback(() => {
    localStorage.set('ac2DisclaimerSeen', true);
    setDisclaimerAccepted(true);
  }, []);

  // Resolve which connection to display. Prefer an explicitly-selected
  // connection (set on scan / "open chat" / drawer) — this works even before a
  // freshly-scanned connection has a session row, since `useConnection` creates
  // the row. Otherwise fall back to the most recently active stored session.
  let origin: string | null = null;
  let requestId: string | null = null;
  if (currentId && currentOrigin) {
    origin = currentOrigin;
    requestId = currentId;
  } else {
    const ordered = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);
    const active = ordered.find((s) => s.id === currentId) ?? ordered[0] ?? null;
    if (active) {
      origin = active.origin;
      requestId = active.id;
    }
  }

  // Keep uiStore in sync with the resolved connection (the fallback branch
  // derives origin/requestId locally without writing them to the store).
  React.useEffect(() => {
    if (origin && requestId) setCurrentConnection(origin, requestId);
  }, [origin, requestId]);

  if (!origin || !requestId) {
    return (
      <Screen edges={['bottom']}>
        <ChatEmptyState onScan={() => router.push('/scan')} />
      </Screen>
    );
  }

  // Connection ready — show disclaimer on first ever agent connection.
  // ChatScreen (and its hooks) must not mount until the user accepts.
  if (!disclaimerAccepted) {
    return (
      <Screen edges={['bottom']}>
        <View className="flex-1 items-center justify-center bg-background p-5">
          <View className="w-full rounded-2xl border border-border bg-card">
            <View className="flex-row items-center gap-2 border-b border-border px-5 pb-4 pt-5">
              <MaterialIcons name="warning" size={20} color="#D97706" />
              <Text className="text-lg font-bold text-card-foreground">Connect to AI Agents</Text>
            </View>
            <ScrollView className="max-h-56 px-5 py-4">
              <Text className="text-sm leading-relaxed text-muted-foreground">
                AC2 lets you connect to AI agents through third-party plugins. These agents are not
                operated, vetted, or endorsed by Pera or by the Algorand Foundation. AI may produce
                inaccurate, unexpected, hallucinated, or harmful output, including by proposing
                transactions or signing requests that do not reflect your actual instructions. Each
                agent's own terms and privacy practices apply.
              </Text>
            </ScrollView>
            <View className="px-5 pb-5 pt-4">
              <Button onPress={handleDisclaimerAccept} accessibilityLabel="I understand">
                <Text className="text-primary-foreground">I understand</Text>
              </Button>
            </View>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <ChatScreen origin={origin} requestId={requestId} />
    </Screen>
  );
}
