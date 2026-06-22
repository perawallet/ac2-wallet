import type { Network } from '@/stores/network';

export interface AlgorandNetworkConfig {
  algodUrl: string;
  indexerUrl: string;
  usdcAssetId: bigint;
}

export const NETWORK_CONFIG: Record<Network, AlgorandNetworkConfig> = {
  testnet: {
    algodUrl: 'https://testnet-api.algonode.cloud',
    indexerUrl: 'https://testnet-idx.algonode.cloud',
    usdcAssetId: 10458941n,
  },
  mainnet: {
    algodUrl: 'https://mainnet-api.algonode.cloud',
    indexerUrl: 'https://mainnet-idx.algonode.cloud',
    usdcAssetId: 31566704n,
  },
};
