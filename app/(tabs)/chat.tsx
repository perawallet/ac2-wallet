import { useRouter } from 'expo-router';
import { useStore } from '@tanstack/react-store';
import { Screen } from '@/components/ui/Screen';
import { ChatScreen } from '@/components/chat/ChatScreen';
import { ChatEmptyState } from '@/components/chat/ChatEmptyState';
import { uiStore } from '@/stores/ui';
import { sessionsStore } from '@/stores/sessions';

export default function ChatTab() {
  const router = useRouter();
  const sessions = useStore(sessionsStore, (s) => s.sessions);
  const currentId = useStore(uiStore, (s) => s.currentSessionId);

  const ordered = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);
  const active = ordered.find((s) => s.id === currentId) ?? ordered[0] ?? null;

  if (!active) {
    return (
      <Screen edges={['bottom']}>
        <ChatEmptyState onScan={() => router.push('/scan')} />
      </Screen>
    );
  }
  return (
    <Screen edges={['bottom']}>
      <ChatScreen session={active} />
    </Screen>
  );
}
