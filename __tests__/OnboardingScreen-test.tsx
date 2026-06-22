import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import Welcome from '@/app/onboarding';

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockCreateWallet = jest.fn();
let mockKeys: unknown[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  usePathname: () => '/onboarding',
}));
jest.mock('@/hooks/useWalletSetup', () => ({
  useWalletSetup: () => ({ createWallet: mockCreateWallet }),
}));
jest.mock('@/hooks/useProvider', () => ({ useProvider: () => ({ keys: mockKeys }) }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

describe('Welcome', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockPush.mockClear();
    mockCreateWallet.mockReset();
    mockKeys = [];
  });

  it('shows the brand title and tagline', () => {
    render(<Welcome />);
    expect(screen.getByText('AC2 Wallet')).toBeTruthy();
    expect(screen.getByText('Unleash your agents. Keep control.')).toBeTruthy();
  });

  it('creates a wallet and navigates to /chat', async () => {
    mockCreateWallet.mockResolvedValue({ mnemonic: 'x' });
    render(<Welcome />);
    fireEvent.press(screen.getByLabelText('Create Wallet'));
    await waitFor(() => expect(mockCreateWallet).toHaveBeenCalled());
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/chat'));
  });

  it('navigates to the import screen', () => {
    render(<Welcome />);
    fireEvent.press(screen.getByLabelText('Import Existing Wallet'));
    expect(mockPush).toHaveBeenCalledWith('/onboarding/import');
  });
});
