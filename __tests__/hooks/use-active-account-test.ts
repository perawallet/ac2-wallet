import { renderHook } from '@testing-library/react-native';
import { accountsStore } from '@/stores/accounts';
import { useActiveAccount } from '@/hooks/useActiveAccount';

describe('useActiveAccount', () => {
  afterEach(() => accountsStore.setState(() => ({ accounts: [] })));

  it('returns the first account address', () => {
    accountsStore.setState(() => ({
      accounts: [
        { address: 'FIRSTADDR', balance: 0n, assets: [], type: 'ed25519' },
        { address: 'SECONDADDR', balance: 0n, assets: [], type: 'ed25519' },
      ],
    }));
    const { result } = renderHook(() => useActiveAccount());
    expect(result.current.address).toBe('FIRSTADDR');
  });

  it('returns undefined address when there are no accounts', () => {
    const { result } = renderHook(() => useActiveAccount());
    expect(result.current.address).toBeUndefined();
  });
});
