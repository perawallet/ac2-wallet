import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => {} }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('react-native-qrcode-svg', () => () => null);
jest.mock('@/hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({
    address: 'TESTADDRESS000000000000000000000000000000000000000000000000',
  }),
}));
jest.mock('@/hooks/useAccountBalance', () => ({
  useAccountBalance: () => ({
    algoMicro: 12_500_000n,
    usdcMicro: 5_000_000n,
    usdcOptedIn: false,
    isRefreshing: false,
    error: null,
    refetch: jest.fn(),
  }),
}));
const mockOptInToUsdc = jest.fn();
jest.mock('@/hooks/useUsdcOptIn', () => ({
  useUsdcOptIn: () => ({
    isOptingIn: false,
    optInToUsdc: mockOptInToUsdc,
  }),
}));

import * as Clipboard from 'expo-clipboard';
import { networkStore } from '@/stores/network';
import WalletTab from '@/app/(tabs)/wallet';

describe('WalletTab', () => {
  beforeEach(() => {
    networkStore.setState(() => ({ network: 'testnet' }));
    (Clipboard.setStringAsync as jest.Mock).mockClear();
    mockOptInToUsdc.mockClear();
  });

  it('renders truncated address and formatted balances', () => {
    render(<WalletTab />);
    expect(screen.getByText('TESTAD…0000')).toBeTruthy();
    expect(screen.getByText('5.00 USDC')).toBeTruthy();
    expect(screen.getByText('12.50 ALGO')).toBeTruthy();
  });

  it('copies the full address when the address card is pressed', async () => {
    render(<WalletTab />);
    fireEvent.press(screen.getByLabelText('Copy wallet address'));
    await waitFor(() =>
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
        'TESTADDRESS000000000000000000000000000000000000000000000000',
      ),
    );
  });

  it('opts the account into USDC when the add button is pressed', () => {
    render(<WalletTab />);
    fireEvent.press(screen.getByLabelText('Opt in to USDC'));
    expect(mockOptInToUsdc).toHaveBeenCalledTimes(1);
  });
});
