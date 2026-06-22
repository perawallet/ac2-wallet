import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import ImportWallet from '@/app/onboarding/import';

const mockReplace = jest.fn();
const mockImportWallet = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('@/hooks/useWalletSetup', () => ({
  useWalletSetup: () => ({ importWallet: mockImportWallet }),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@/components/PreventScreenshot', () => ({
  PreventScreenshot: ({ children }: any) => children,
}));

describe('ImportWallet', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockImportWallet.mockReset();
  });

  it('imports a phrase and navigates to /chat', async () => {
    mockImportWallet.mockResolvedValue(undefined);
    render(<ImportWallet />);
    fireEvent.changeText(screen.getByLabelText('Recovery phrase'), 'alpha bravo charlie');
    fireEvent.press(screen.getByLabelText('Import Wallet'));
    await waitFor(() => expect(mockImportWallet).toHaveBeenCalledWith('alpha bravo charlie'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/chat'));
  });

  it('does not navigate when import fails', async () => {
    mockImportWallet.mockRejectedValue(
      new Error('Invalid recovery phrase. Check the words and try again.'),
    );
    render(<ImportWallet />);
    fireEvent.changeText(screen.getByLabelText('Recovery phrase'), 'bad');
    fireEvent.press(screen.getByLabelText('Import Wallet'));
    await waitFor(() => expect(mockImportWallet).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
