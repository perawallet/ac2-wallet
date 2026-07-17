import { act, render } from '@testing-library/react-native';
import * as React from 'react';

jest.mock('react-native-mmkv', () => {
  const store: Record<string, string> = {};
  const createMMKV = () => ({
    getString: (key: string) => store[key],
    getBoolean: () => false,
    set: (key: string, value: string) => {
      store[key] = value;
    },
    delete: (key: string) => {
      delete store[key];
    },
    clearAll: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
  });
  return { createMMKV };
});

// Disclaimer already accepted so `ChatScreen` mounts immediately.
jest.mock('@/stores/mmkv-local', () => ({
  localStorage: { getBoolean: () => true, set: jest.fn() },
}));

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

// Record each mount/unmount of `ChatScreen` keyed by its connection identity so
// we can assert switching connections fully remounts it (fresh hook state)
// rather than reusing the instance.
const mounts: string[] = [];
const unmounts: string[] = [];
jest.mock('@/components/chat/ChatScreen', () => {
  const ReactLocal = require('react');
  return {
    ChatScreen: ({ origin, requestId }: { origin: string; requestId: string }) => {
      ReactLocal.useEffect(() => {
        const id = `${origin}::${requestId}`;
        mounts.push(id);
        return () => {
          unmounts.push(id);
        };
      }, []);
      return null;
    },
  };
});

import ChatTab from '@/app/(tabs)/chat';
import { sessionsStore } from '@/stores/sessions';
import { setCurrentConnection, uiStore } from '@/stores/ui';

describe('Chat tab connection switching', () => {
  beforeEach(() => {
    mounts.length = 0;
    unmounts.length = 0;
    sessionsStore.setState(() => ({ sessions: [] }));
    uiStore.setState(() => ({
      drawerOpen: false,
      currentSessionId: 'req-1',
      currentOrigin: 'https://debug.liquidauth.com',
      allowPasskeyCreation: false,
      activeThid: null,
    }));
  });

  it('remounts ChatScreen when switching to another session on the same origin', () => {
    render(<ChatTab />);
    expect(mounts).toEqual(['https://debug.liquidauth.com::req-1']);

    // Simulate scanning a second QR on the same origin with a new requestId.
    act(() => {
      setCurrentConnection('https://debug.liquidauth.com', 'req-2', {
        allowPasskeyCreation: true,
      });
    });

    // The previous connection's instance must unmount and a fresh one mount.
    // Without the per-connection key the instance would be reused, and the
    // persisted `isConnected` state would block the new connection's setup.
    expect(unmounts).toContain('https://debug.liquidauth.com::req-1');
    expect(mounts).toEqual([
      'https://debug.liquidauth.com::req-1',
      'https://debug.liquidauth.com::req-2',
    ]);
  });
});
