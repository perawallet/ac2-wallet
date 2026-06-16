import { Store } from '@tanstack/react-store';
import { createMMKV } from 'react-native-mmkv';

export type Network = 'testnet' | 'mainnet';

export interface NetworkState {
  network: Network;
}

const networkLocalStorage = createMMKV({ id: 'network' });

const loadInitialNetwork = (): NetworkState => {
  try {
    const stored = networkLocalStorage.getString('network');
    if (stored === 'testnet' || stored === 'mainnet') {
      return { network: stored };
    }
  } catch (error) {
    console.error('Failed to load network from storage:', error);
  }
  return { network: 'testnet' };
};

export const networkStore = new Store<NetworkState>(loadInitialNetwork());

networkStore.subscribe(() => {
  try {
    networkLocalStorage.set('network', networkStore.state.network);
  } catch (error) {
    console.error('Failed to save network to storage:', error);
  }
});

export function setNetwork(network: Network) {
  networkStore.setState((s) => ({ ...s, network }));
}
