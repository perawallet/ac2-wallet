const mockSet = jest.fn();
// `mock`-prefixed so the hoisted jest.mock factory may close over it; mutating it
// lets a test drive what a fresh import of the store reads from storage on init.
let mockStoredNetwork: string | undefined;
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: () => mockStoredNetwork,
    set: (_k: string, v: string) => mockSet(v),
  }),
}));

import { networkStore, setNetwork } from '@/stores/network';

describe('networkStore', () => {
  beforeEach(() => {
    mockSet.mockClear();
    mockStoredNetwork = undefined;
    networkStore.setState(() => ({ network: 'testnet' }));
  });

  it('defaults to testnet', () => {
    expect(networkStore.state.network).toBe('testnet');
  });

  it('setNetwork switches and persists the network', () => {
    setNetwork('mainnet');
    expect(networkStore.state.network).toBe('mainnet');
    expect(mockSet).toHaveBeenCalledWith('mainnet');
  });

  it('loads a previously stored network on init', () => {
    mockStoredNetwork = 'mainnet';
    let freshStore: typeof networkStore | undefined;
    jest.isolateModules(() => {
      freshStore = require('@/stores/network').networkStore;
    });
    expect(freshStore?.state.network).toBe('mainnet');
  });
});
