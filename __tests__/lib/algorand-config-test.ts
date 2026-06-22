import { NETWORK_CONFIG } from '@/lib/algorand/config';

describe('NETWORK_CONFIG', () => {
  it('uses AlgoNode endpoints and correct USDC asset ids', () => {
    expect(NETWORK_CONFIG.testnet.algodUrl).toBe('https://testnet-api.algonode.cloud');
    expect(NETWORK_CONFIG.testnet.indexerUrl).toBe('https://testnet-idx.algonode.cloud');
    expect(NETWORK_CONFIG.testnet.usdcAssetId).toBe(10458941n);
    expect(NETWORK_CONFIG.mainnet.algodUrl).toBe('https://mainnet-api.algonode.cloud');
    expect(NETWORK_CONFIG.mainnet.indexerUrl).toBe('https://mainnet-idx.algonode.cloud');
    expect(NETWORK_CONFIG.mainnet.usdcAssetId).toBe(31566704n);
  });
});
