import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import BackupScreen from '@/app/onboarding/backup';
import CompleteScreen from '@/app/onboarding/complete';
import VerifyScreen from '@/app/onboarding/verify';
import { getStoredMnemonic } from '@/hooks/useWalletSetup';
import { createRecoveryPhraseAccessToken } from '@/lib/keystore/recovery-phrase-access';

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockAccessToken: string | undefined;

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: jest.fn(), delete: jest.fn() }),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ accessToken: mockAccessToken }),
  useRouter: () => ({ back: mockBack, push: mockPush, replace: mockReplace }),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@/components/PreventScreenshot', () => ({
  PreventScreenshot: ({ children }: any) => children,
}));
jest.mock('@/hooks/useWalletSetup', () => ({
  getStoredMnemonic: jest.fn(),
}));

const mockGetStoredMnemonic = jest.mocked(getStoredMnemonic);

describe('onboarding later pages', () => {
  beforeEach(() => {
    mockBack.mockClear();
    mockGetStoredMnemonic.mockReset();
    mockGetStoredMnemonic.mockResolvedValue('a b c d e f g h i j k l m n o p q r s t u v w x');
    mockPush.mockClear();
    mockReplace.mockClear();
    mockAccessToken = undefined;
  });

  it('backup renders its heading and the stored phrase words', async () => {
    mockAccessToken = createRecoveryPhraseAccessToken();
    render(<BackupScreen />);
    expect(screen.getByText('Back up your phrase')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
  });

  it('backup returns to the previous screen', async () => {
    mockAccessToken = createRecoveryPhraseAccessToken();
    render(<BackupScreen />);

    fireEvent.press(screen.getByLabelText('Back'));

    expect(mockBack).toHaveBeenCalledTimes(1);
    await screen.findByText('a');
  });

  it('continues to a protected verification route', async () => {
    mockAccessToken = createRecoveryPhraseAccessToken();
    render(<BackupScreen />);
    await screen.findByText('a');

    fireEvent.press(screen.getByLabelText('I have written it down'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/onboarding/verify',
      params: { accessToken: expect.any(String) },
    });
  });

  it('redirects a direct backup route without revealing the phrase', async () => {
    render(<BackupScreen />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockGetStoredMnemonic).not.toHaveBeenCalled();
  });

  it('verification returns to the recovery phrase', async () => {
    mockAccessToken = createRecoveryPhraseAccessToken();
    render(<VerifyScreen />);
    await screen.findByPlaceholderText('Word #3');

    fireEvent.press(screen.getByLabelText('Back to recovery phrase'));

    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('redirects a direct verification route without loading the phrase', async () => {
    render(<VerifyScreen />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockGetStoredMnemonic).not.toHaveBeenCalled();
  });

  it('complete renders the success heading', () => {
    render(<CompleteScreen />);
    expect(screen.getByText('Identity secured')).toBeTruthy();
  });
});
