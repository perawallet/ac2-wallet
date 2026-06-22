import { AlgorandClient } from '@algorandfoundation/algokit-utils';
import type { Network } from '@/stores/network';
import { NETWORK_CONFIG } from './config';

const clients: Partial<Record<Network, AlgorandClient>> = {};

export function getAlgorandClient(network: Network): AlgorandClient {
  const existing = clients[network];
  if (existing) return existing;

  const { algodUrl } = NETWORK_CONFIG[network];
  const client = AlgorandClient.fromConfig({
    algodConfig: { server: algodUrl, port: 443, token: '' },
  });
  clients[network] = client;
  return client;
}
