import { renderHook, waitFor } from '@testing-library/react-native';

const mockGetInformation = jest.fn();
jest.mock('@/lib/algorand/client', () => ({
  getAlgorandClient: () => ({ account: { getInformation: mockGetInformation } }),
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React = require('react');
    React.useEffect(() => cb(), [cb]);
  },
}));

import { useAccountBalance } from '@/hooks/useAccountBalance';

describe('useAccountBalance', () => {
  beforeEach(() => mockGetInformation.mockReset());

  it('parses algo and matching USDC balances', async () => {
    mockGetInformation.mockResolvedValue({
      balance: { microAlgo: 12_500_000n },
      assets: [{ assetId: 10458941n, amount: 5_000_000n }],
    });
    const { result } = renderHook(() => useAccountBalance('ADDR', 'testnet'));
    await waitFor(() => expect(result.current.algoMicro).toBe(12_500_000n));
    expect(result.current.usdcMicro).toBe(5_000_000n);
    expect(result.current.error).toBeNull();
  });

  it('reports zero USDC when the asset is not held', async () => {
    mockGetInformation.mockResolvedValue({ balance: { microAlgo: 1_000_000n }, assets: [] });
    const { result } = renderHook(() => useAccountBalance('ADDR', 'testnet'));
    await waitFor(() => expect(result.current.algoMicro).toBe(1_000_000n));
    expect(result.current.usdcMicro).toBe(0n);
  });

  it('treats an unfunded account (404) as zero balances', async () => {
    mockGetInformation.mockRejectedValue({ status: 404, message: 'account does not exist' });
    const { result } = renderHook(() => useAccountBalance('ADDR', 'testnet'));
    await waitFor(() => expect(mockGetInformation).toHaveBeenCalled());
    expect(result.current.algoMicro).toBe(0n);
    expect(result.current.usdcMicro).toBe(0n);
    expect(result.current.error).toBeNull();
  });

  it('surfaces non-404 errors', async () => {
    mockGetInformation.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useAccountBalance('ADDR', 'testnet'));
    await waitFor(() => expect(result.current.error).not.toBeNull());
  });

  it('does nothing without an address', async () => {
    const { result } = renderHook(() => useAccountBalance(undefined, 'testnet'));
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(mockGetInformation).not.toHaveBeenCalled();
  });
});
