import { cleanup, renderHook } from '@testing-library/react-native';
import { accountsStore } from '@/stores/accounts';
import { keyStore } from '@/stores/keystore';
import { useActiveAccount } from '@/hooks/useActiveAccount';

describe('useActiveAccount', () => {
  afterEach(() => {
    cleanup();
    accountsStore.setState(() => ({ accounts: [] }));
    keyStore.setState(() => ({ keys: [], status: 'loading' }));
  });

  it('returns the first account address', () => {
    accountsStore.setState(() => ({
      accounts: [
        {
          address: 'FIRSTADDR',
          balance: 0n,
          assets: [],
          type: 'ed25519',
          metadata: { keyId: 'first-key' },
        },
        { address: 'SECONDADDR', balance: 0n, assets: [], type: 'ed25519' },
      ],
    }));
    keyStore.setState(() => ({
      keys: [
        {
          id: 'first-key',
          type: 'hd-derived-ed25519',
          algorithm: 'EdDSA',
          publicKey: new Uint8Array([1]),
          extractable: false,
          metadata: {
            address: {},
            path: "m/44'/283'/0'/0/0",
            account: 0,
            context: 0,
            index: 0,
            derivation: 0,
            parentKeyId: 'root-key',
          },
        },
      ],
      status: 'ready',
    }));
    const { result } = renderHook(() => useActiveAccount());
    expect(result.current.address).toBe('FIRSTADDR');
  });

  it('returns undefined address when there are no accounts', () => {
    const { result } = renderHook(() => useActiveAccount());
    expect(result.current.address).toBeUndefined();
  });
});
