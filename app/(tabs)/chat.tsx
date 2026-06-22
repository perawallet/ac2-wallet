import { ChatEmptyState } from '@/components/chat/ChatEmptyState';
import { Screen } from '@/components/ui/Screen';
import { sessionsStore } from '@/stores/sessions';
import { setCurrentConnection, uiStore } from '@/stores/ui';
import { useStore } from '@tanstack/react-store';
import { useRouter } from 'expo-router';
import * as React from 'react';

// Lazily load the live chat surface. `ChatScreen` pulls in the keystore /
// wallet-provider chain (via `useConnection`/`useAc2Responders`), which must
// only be evaluated AFTER the root layout installs the crypto/buffer polyfills.
// A static import here would evaluate `react-native-keystore` during the
// startup module-eval phase — before those polyfills run — and crash with
// "Base64Module.install is not a function". Deferring to render time keeps the
// keystore import after the polyfills are installed.
const ChatScreen = React.lazy(() =>
  import('@/components/chat/ChatScreen').then((m) => ({ default: m.ChatScreen })),
);

export default function ChatTab() {
  const router = useRouter();
  const sessions = useStore(sessionsStore, (s) => s.sessions);
  const currentId = useStore(uiStore, (s) => s.currentSessionId);
  const currentOrigin = useStore(uiStore, (s) => s.currentOrigin);

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
  return (
    <Screen edges={[]}>
      <React.Suspense fallback={null}>
        <ChatScreen origin={origin} requestId={requestId} />
      </React.Suspense>
    </Screen>
  );
}
