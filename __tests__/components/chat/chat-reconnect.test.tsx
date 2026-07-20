import { render, screen } from '@testing-library/react-native';
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
    addMessage: jest.fn(),
    addToolActivity: jest.fn(),
    setThreadHistory: jest.fn(),
  };
});
jest.mock('@/stores/ac2Messages', () => {
  const { Store } = require('@tanstack/store');
  return {
    ac2MessagesStore: new Store({ messages: [] }),
    clearAc2Messages: jest.fn(),
    clearAc2MessagesByConnection: jest.fn(),
    addAc2Message: jest.fn(),
  };
});
jest.mock('@/stores/agentIdentities', () => ({ clearAgentIdentitiesByConnection: jest.fn() }));
jest.mock('@/stores/sessions', () => ({ removeSession: jest.fn(), renameSession: jest.fn() }));
jest.mock('@/stores/mmkv-local', () => ({ localStorage: { getBoolean: () => false } }));
jest.mock('@/stores/ui', () => ({ setActiveThid: jest.fn(), clearCurrentConnection: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 162 }));
jest.mock('@/hooks/useAc2Responders', () => ({
  useAc2Responders: () => ({
    approveSigning: jest.fn(),
    rejectSigning: jest.fn(),
    approveKey: jest.fn(),
    rejectKey: jest.fn(),
  }),
}));

type ConnectionState = ReturnType<typeof baseConnection>;

const reconnect = jest.fn();

function baseConnection() {
  return {
    isConnected: false,
    isError: false,
    isLoading: false,
    isReconnecting: false,
    reconnectAttempt: 0,
    send: jest.fn(),
    sendAc2: jest.fn(),
    lastHeartbeat: Date.now(),
    reset: jest.fn(),
    reconnect,
    session: { id: 'req-1', origin: 'https://agent.example', status: 'active', name: 'Agent' },
    address: 'TESTADDRESS',
    activeStreamText: '',
    agentPresence: null,
    agentPresenceDetail: null,
    activeThid: 'default',
    openConversation: jest.fn(),
    closeConversation: jest.fn(),
    remoteThreads: [],
  };
}

let mockConnectionState: ConnectionState = baseConnection();

jest.mock('@/hooks/useConnection', () => ({
  useConnection: () => mockConnectionState,
}));

import { ChatScreen } from '@/components/chat/ChatScreen';

const renderChat = () => render(<ChatScreen origin="https://agent.example" requestId="req-1" />);

describe('ChatScreen reconnect footer', () => {
  beforeEach(() => {
    mockConnectionState = baseConnection();
    reconnect.mockClear();
  });

  it('shows a reconnecting composer (not the manual bar) while auto-retries are in flight', () => {
    mockConnectionState = { ...baseConnection(), isReconnecting: true, reconnectAttempt: 2 };
    renderChat();

    expect(screen.getByPlaceholderText('Reconnecting (attempt 2)…')).toBeTruthy();
    expect(screen.queryByLabelText('Reconnect')).toBeNull();
  });

  it('shows the manual Reconnect bar when automatic recovery is not active', () => {
    mockConnectionState = { ...baseConnection(), isReconnecting: false, isLoading: false };
    renderChat();

    expect(screen.getByLabelText('Reconnect')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Reconnecting/)).toBeNull();
  });

  it('shows the live composer when connected', () => {
    mockConnectionState = { ...baseConnection(), isConnected: true };
    const view = renderChat();

    expect(screen.getByPlaceholderText('Message')).toBeTruthy();
    expect(screen.queryByLabelText('Reconnect')).toBeNull();
    expect(view.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(162);
  });
});
