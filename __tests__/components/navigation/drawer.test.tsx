jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-mmkv', () => {
  const store: Record<string, string> = {};
  const createMMKV = () => ({
    getString: (key: string) => store[key],
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

import { Drawer } from '@/components/navigation/Drawer';
import { sessionsStore } from '@/stores/sessions';
import { uiStore } from '@/stores/ui';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

describe('Drawer', () => {
  beforeEach(() => {
    mockPush.mockClear();
    uiStore.setState(() => ({ drawerOpen: true, currentSessionId: null, currentOrigin: null }));
    sessionsStore.setState(() => ({
      sessions: [
        {
          id: 'req-1',
          origin: 'https://a.example',
          timestamp: 1,
          lastActivity: 10,
          status: 'active' as const,
        },
      ],
    }));
  });

  it('lists sessions and opens one into the chat tab', () => {
    render(<Drawer />);
    fireEvent.press(screen.getByText('https://a.example'));
    expect(uiStore.state.currentSessionId).toBe('req-1');
    expect(uiStore.state.drawerOpen).toBe(false);
    expect(mockPush).toHaveBeenCalledWith('/chat');
  });
});
