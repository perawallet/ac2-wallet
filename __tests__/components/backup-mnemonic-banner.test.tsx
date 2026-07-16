import { fireEvent, render, screen } from '@testing-library/react-native';

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

describe('BackupMnemonicBanner', () => {
  const { BackupMnemonicBanner } = require('@/components/BackupMnemonicBanner');

  beforeEach(() => {
    mockPush.mockClear();
    mockGetBoolean.mockReset();
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

  it('opens the backup phrase screen when pressed', () => {
    mockGetBoolean.mockReturnValue(false);
    render(<BackupMnemonicBanner />);

    fireEvent.press(screen.getByLabelText('Back up recovery phrase'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/onboarding/backup',
      params: { accessToken: expect.any(String) },
    });
  });
});
