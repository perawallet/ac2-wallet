const mockFromConfig = jest.fn((cfg) => ({ __cfg: cfg }));
jest.mock('@algorandfoundation/algokit-utils', () => ({
  AlgorandClient: { fromConfig: (cfg: unknown) => mockFromConfig(cfg) },
}));

import { getAlgorandClient } from '@/lib/algorand/client';

describe('getAlgorandClient', () => {
  beforeEach(() => mockFromConfig.mockClear());

  it('builds a client from the network algod url', () => {
    getAlgorandClient('testnet');
    expect(mockFromConfig).toHaveBeenCalledWith({
      algodConfig: { server: 'https://testnet-api.algonode.cloud', port: 443, token: '' },
    });
  });

  it('memoizes the client per network', () => {
    const a = getAlgorandClient('mainnet');
    const b = getAlgorandClient('mainnet');
    expect(a).toBe(b);
    expect(mockFromConfig).toHaveBeenCalledTimes(1);
  });
});
