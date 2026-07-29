import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSetColorScheme = jest.fn();

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: () => undefined,
    set: jest.fn(),
  }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0' } },
}));
jest.mock('nativewind', () => ({
  useColorScheme: () => ({ colorScheme: 'light', setColorScheme: mockSetColorScheme }),
}));
jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    key: { store: { clear: jest.fn() } },
    account: { store: { clear: jest.fn() } },
    identity: { store: { clear: jest.fn() } },
    passkey: { store: { clear: jest.fn() } },
  }),
}));
jest.mock('@/hooks/useWalletSetup', () => ({
  clearStoredMnemonic: jest.fn(),
}));
jest.mock('@/lib/keystore/authenticate', () => ({
  authenticateToViewRecoveryPhrase: jest.fn(),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import { MenuScreen } from '@/components/MenuScreen';
import { authenticateToViewRecoveryPhrase } from '@/lib/keystore/authenticate';

const mockAuthenticateToViewRecoveryPhrase = jest.mocked(authenticateToViewRecoveryPhrase);

describe('MenuScreen recovery phrase authentication', () => {
  beforeEach(() => {
    mockAuthenticateToViewRecoveryPhrase.mockReset();
    mockPush.mockClear();
    mockReplace.mockClear();
    mockSetColorScheme.mockClear();
  });

  it('opens the recovery phrase only after authentication succeeds', async () => {
    mockAuthenticateToViewRecoveryPhrase.mockResolvedValue(true);
    render(<MenuScreen />);

    fireEvent.press(screen.getByText('View Recovery Phrase'));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/onboarding/backup',
        params: { accessToken: expect.any(String) },
      });
    });
    expect(mockAuthenticateToViewRecoveryPhrase).toHaveBeenCalledTimes(1);
  });

  it('stays on settings when authentication fails', async () => {
    mockAuthenticateToViewRecoveryPhrase.mockResolvedValue(false);
    render(<MenuScreen />);

    fireEvent.press(screen.getByText('View Recovery Phrase'));

    await waitFor(() => {
      expect(mockAuthenticateToViewRecoveryPhrase).toHaveBeenCalledTimes(1);
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not start a second authentication prompt while one is pending', async () => {
    let finishAuthentication: ((authenticated: boolean) => void) | undefined;
    mockAuthenticateToViewRecoveryPhrase.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishAuthentication = resolve;
        }),
    );
    render(<MenuScreen />);

    const recoveryPhraseRow = screen.getByText('View Recovery Phrase');
    fireEvent.press(recoveryPhraseRow);
    fireEvent.press(recoveryPhraseRow);

    expect(mockAuthenticateToViewRecoveryPhrase).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishAuthentication?.(false);
    });
  });
});
