import { render, screen, waitFor } from '@testing-library/react-native';
import BackupScreen from '@/app/onboarding/backup';
import CompleteScreen from '@/app/onboarding/complete';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: jest.fn(), delete: jest.fn() }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@/components/PreventScreenshot', () => ({
  PreventScreenshot: ({ children }: any) => children,
}));
jest.mock('@/hooks/useWalletSetup', () => ({
  getStoredMnemonic: jest.fn().mockResolvedValue('a b c d e f g h i j k l m n o p q r s t u v w x'),
}));

describe('onboarding later pages', () => {
  it('backup renders its heading and the stored phrase words', async () => {
    render(<BackupScreen />);
    expect(screen.getByText('Back up your phrase')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
  });

  it('complete renders the success heading', () => {
    render(<CompleteScreen />);
    expect(screen.getByText('Identity secured')).toBeTruthy();
  });
});
