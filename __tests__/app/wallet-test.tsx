import { render, fireEvent, screen } from '@testing-library/react-native';
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
  useActiveAccount: () => ({ address: 'TESTADDRESS000000000000000000000000000000000000000000000000' }),
}));
jest.mock('@/hooks/useAccountBalance', () => ({
  useAccountBalance: () => ({
    algoMicro: 12_500_000n,
    usdcMicro: 5_000_000n,
    isRefreshing: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

import * as Clipboard from 'expo-clipboard';
import { networkStore } from '@/stores/network';
import WalletTab from '@/app/(tabs)/wallet';

describe('WalletTab', () => {
  beforeEach(() => {
    networkStore.setState(() => ({ network: 'testnet' }));
    (Clipboard.setStringAsync as jest.Mock).mockClear();
  });

  it('renders truncated address and formatted balances', () => {
    render(<WalletTab />);
    expect(screen.getByText('TESTAD…0000')).toBeTruthy();
    expect(screen.getByText('5.00 USDC')).toBeTruthy();
    expect(screen.getByText('12.50 ALGO')).toBeTruthy();
  });

  it('copies the full address when the address card is pressed', () => {
    render(<WalletTab />);
    fireEvent.press(screen.getByLabelText('Copy wallet address'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      'TESTADDRESS000000000000000000000000000000000000000000000000',
    );
  });
});
