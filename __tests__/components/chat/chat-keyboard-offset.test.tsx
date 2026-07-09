import { act, render, screen } from '@testing-library/react-native';
import * as React from 'react';
import { KeyboardAvoidingView } from 'react-native';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, getBoolean: () => false, set: () => {} }),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@/lib/ac2', () => ({ DEFAULT_THID: 'default' }));
jest.mock('@/lib/ac2/messageDisplay', () => ({
  isMergedResponse: () => false,
  isResponseEnvelope: () => false,
  deriveOutcomeByThid: () => new Map(),
}));
jest.mock('@/stores/messages', () => {
  const { Store } = require('@tanstack/store');
  return {
    messagesStore: new Store({ messages: [] }),
    clearMessages: jest.fn(),
    clearMessagesByConnection: jest.fn(),
  };
});
jest.mock('@/stores/ac2Messages', () => {
  const { Store } = require('@tanstack/store');
  return {
    ac2MessagesStore: new Store({ messages: [] }),
    clearAc2Messages: jest.fn(),
    clearAc2MessagesByConnection: jest.fn(),
  };
});
jest.mock('@/stores/agentIdentities', () => ({ clearAgentIdentitiesByConnection: jest.fn() }));
jest.mock('@/stores/sessions', () => ({ removeSession: jest.fn(), renameSession: jest.fn() }));
jest.mock('@/stores/mmkv-local', () => ({ localStorage: { getBoolean: () => false } }));
jest.mock('@/stores/ui', () => {
  const { Store } = require('@tanstack/store');
  return {
    uiStore: new Store({ tabsHeaderHeight: 0, activeThid: null }),
    setActiveThid: jest.fn(),
    clearCurrentConnection: jest.fn(),
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/hooks/useAc2Responders', () => ({
  useAc2Responders: () => ({
    approveSigning: jest.fn(),
    rejectSigning: jest.fn(),
    approveKey: jest.fn(),
    rejectKey: jest.fn(),
  }),
}));
jest.mock('@/hooks/useConnection', () => ({
  useConnection: () => ({
    isConnected: false,
    isError: false,
    isLoading: false,
    isReconnecting: false,
    reconnectAttempt: 0,
    maxReconnectAttempts: 3,
    send: jest.fn(),
    sendAc2: jest.fn(),
    lastHeartbeat: Date.now(),
    reset: jest.fn(),
    reconnect: jest.fn(),
    session: null,
    address: 'TESTADDRESS',
    activeStreamText: '',
    agentPresence: null,
    agentPresenceDetail: null,
    activeThid: 'default',
    openConversation: jest.fn(),
    closeConversation: jest.fn(),
    remoteThreads: [],
  }),
}));

import { ChatScreen } from '@/components/chat/ChatScreen';
import { uiStore } from '@/stores/ui';

const renderChat = () => render(<ChatScreen origin="https://agent.example" requestId="req-1" />);

describe('ChatScreen keyboard vertical offset', () => {
  beforeEach(() => {
    act(() => {
      uiStore.setState((s) => ({ ...s, tabsHeaderHeight: 0 }));
    });
  });

  it('uses tabsHeaderHeight from the store as the keyboard vertical offset', () => {
    act(() => {
      uiStore.setState((s) => ({ ...s, tabsHeaderHeight: 90 }));
    });
    renderChat();
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(90);
  });

  it('increases the offset when the backup banner becomes visible', () => {
    act(() => {
      uiStore.setState((s) => ({ ...s, tabsHeaderHeight: 56 }));
    });
    renderChat();
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(56);

    act(() => {
      uiStore.setState((s) => ({ ...s, tabsHeaderHeight: 93 }));
    });
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(93);
  });

  it('decreases the offset when the backup banner is dismissed', () => {
    act(() => {
      uiStore.setState((s) => ({ ...s, tabsHeaderHeight: 93 }));
    });
    renderChat();
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(93);

    act(() => {
      uiStore.setState((s) => ({ ...s, tabsHeaderHeight: 56 }));
    });
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(56);
  });
});
