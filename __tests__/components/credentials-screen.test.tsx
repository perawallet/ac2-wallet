import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { AccessibilityInfo, Alert, Platform } from 'react-native';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => {} }),
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    passkeys: [
      {
        id: 'credential-1',
        name: 'Example credential',
        publicKey: new Uint8Array(),
        algorithm: 'ES256',
        origin: 'https://agent.example',
        createdAt: 1_700_000_000_000,
      },
    ],
    passkey: { store: { removePasskey: jest.fn() } },
  }),
}));

import { CredentialsScreen } from '@/components/CredentialsScreen';
import { agentIdentitiesStore, type AgentIdentity } from '@/stores/agentIdentities';
import { sessionsStore } from '@/stores/sessions';
import { uiStore } from '@/stores/ui';

const clipboardMock = Clipboard.setStringAsync as jest.MockedFunction<
  typeof Clipboard.setStringAsync
>;
const hapticsMock = Haptics.notificationAsync as jest.MockedFunction<
  typeof Haptics.notificationAsync
>;

describe('CredentialsScreen copy feedback', () => {
  const announceSpy = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => {});
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

  beforeEach(() => {
    jest.clearAllMocks();
    clipboardMock.mockResolvedValue(true);
    hapticsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Platform.OS = 'ios';
  });

  it('shows a success toast after copying even when haptics fail', async () => {
    hapticsMock.mockRejectedValueOnce(new Error('Haptics unavailable'));
    render(<CredentialsScreen />);

    fireEvent.press(screen.getByText('Origin'));

    await waitFor(() => expect(clipboardMock).toHaveBeenCalledWith('https://agent.example'));
    expect(await screen.findByText('Copied to clipboard')).toBeTruthy();
    expect(announceSpy).toHaveBeenCalledWith('Copied to clipboard');
    expect(hapticsMock).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  // Android already shows a system confirmation for clipboard writes, so ours
  // would be a second, redundant "Copied" message.
  it('leaves the copy confirmation to the OS on Android', async () => {
    Platform.OS = 'android';
    render(<CredentialsScreen />);

    fireEvent.press(screen.getByText('Origin'));

    await waitFor(() => expect(clipboardMock).toHaveBeenCalledWith('https://agent.example'));
    expect(screen.queryByText('Copied to clipboard')).toBeNull();
    expect(announceSpy).not.toHaveBeenCalled();
    expect(hapticsMock).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  });

  it('shows a failure alert without success feedback when clipboard copying fails', async () => {
    clipboardMock.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    render(<CredentialsScreen />);

    fireEvent.press(screen.getByText('Origin'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Copy failed', 'Could not copy to the clipboard.'),
    );
    expect(screen.queryByText('Copied to clipboard')).toBeNull();
    expect(announceSpy).not.toHaveBeenCalled();
    expect(hapticsMock).not.toHaveBeenCalled();
  });
});

describe('CredentialsScreen agent identity chat association', () => {
  const identity: AgentIdentity = {
    id: 'ident-1',
    keyId: 'key-1',
    publicKey: 'cHVibGljLWtleQ==',
    agentDid: 'did:key:z6MkAgent',
    controllerDid: 'did:key:z6MkController',
    origin: 'https://agent.example',
    requestId: 'req-1',
    createdAt: 1_700_000_000_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    agentIdentitiesStore.setState((s) => ({ ...s, identities: [identity] }));
    uiStore.setState((s) => ({ ...s, currentOrigin: null, currentSessionId: null }));
  });

  afterEach(() => {
    agentIdentitiesStore.setState((s) => ({ ...s, identities: [] }));
    sessionsStore.setState((s) => ({ ...s, sessions: [] }));
  });

  it('names the associated chat and opens it from the chat button', () => {
    sessionsStore.setState((s) => ({
      ...s,
      sessions: [
        {
          id: 'req-1',
          origin: 'https://agent.example',
          name: 'My agent chat',
          status: 'active' as const,
          timestamp: Date.now(),
          lastActivity: Date.now(),
        },
      ],
    }));
    render(<CredentialsScreen />);

    expect(screen.getByText('My agent chat')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Open chat My agent chat'));

    expect(uiStore.state.currentOrigin).toBe('https://agent.example');
    expect(uiStore.state.currentSessionId).toBe('req-1');
    expect(mockPush).toHaveBeenCalledWith('/chat');
  });

  it('shows "No active chat" and hides the chat button when the session is gone', () => {
    render(<CredentialsScreen />);

    expect(screen.getByText('No active chat')).toBeTruthy();
    expect(screen.queryByLabelText(/^Open chat/)).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
