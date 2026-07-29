import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockGetBoolean = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void) => {
    const React = require('react');
    React.useEffect(callback, [callback]);
  },
}));
jest.mock('@/stores/mmkv-local', () => ({
  localStorage: {
    getBoolean: mockGetBoolean,
  },
}));
jest.mock('@/lib/keystore/authenticate', () => ({
  authenticateToViewRecoveryPhrase: jest.fn(),
}));

import { authenticateToViewRecoveryPhrase } from '@/lib/keystore/authenticate';

const mockAuthenticateToViewRecoveryPhrase = jest.mocked(authenticateToViewRecoveryPhrase);

describe('BackupMnemonicBanner', () => {
  const { BackupMnemonicBanner } = require('@/components/BackupMnemonicBanner');

  beforeEach(() => {
    mockPush.mockClear();
    mockGetBoolean.mockReset();
    mockAuthenticateToViewRecoveryPhrase.mockReset();
  });

  it('renders when the mnemonic has not been backed up', () => {
    mockGetBoolean.mockReturnValue(false);
    render(<BackupMnemonicBanner />);

    expect(screen.getByText('Action Required: Backup Mnemonic')).toBeTruthy();
  });

  it('does not render when the mnemonic is backed up', () => {
    mockGetBoolean.mockReturnValue(true);
    render(<BackupMnemonicBanner />);

    expect(screen.queryByText('Action Required: Backup Mnemonic')).toBeNull();
  });

  it('opens the backup phrase screen only after authentication succeeds', async () => {
    mockGetBoolean.mockReturnValue(false);
    mockAuthenticateToViewRecoveryPhrase.mockResolvedValue(true);
    render(<BackupMnemonicBanner />);

    fireEvent.press(screen.getByLabelText('Back up recovery phrase'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/onboarding/backup',
        params: { accessToken: expect.any(String) },
      });
    });
    expect(mockAuthenticateToViewRecoveryPhrase).toHaveBeenCalledTimes(1);
  });

  it('stays put when authentication fails', async () => {
    mockGetBoolean.mockReturnValue(false);
    mockAuthenticateToViewRecoveryPhrase.mockResolvedValue(false);
    render(<BackupMnemonicBanner />);

    fireEvent.press(screen.getByLabelText('Back up recovery phrase'));

    await waitFor(() => {
      expect(mockAuthenticateToViewRecoveryPhrase).toHaveBeenCalledTimes(1);
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not start a second authentication prompt while one is pending', async () => {
    mockGetBoolean.mockReturnValue(false);
    let finishAuthentication: ((authenticated: boolean) => void) | undefined;
    mockAuthenticateToViewRecoveryPhrase.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishAuthentication = resolve;
        }),
    );
    render(<BackupMnemonicBanner />);

    const banner = screen.getByLabelText('Back up recovery phrase');
    fireEvent.press(banner);
    fireEvent.press(banner);

    expect(mockAuthenticateToViewRecoveryPhrase).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishAuthentication?.(false);
    });
  });
});
