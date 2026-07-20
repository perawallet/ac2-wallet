import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { AccessibilityInfo, Alert } from 'react-native';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => {} }),
}));
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
