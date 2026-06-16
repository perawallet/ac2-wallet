import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { getAlgorandClient } from '@/lib/algorand/client';
import { NETWORK_CONFIG } from '@/lib/algorand/config';
import type { Network } from '@/stores/network';

const POLL_INTERVAL_MS = 10_000;

export interface AccountBalance {
  algoMicro: bigint;
  usdcMicro: bigint;
  isRefreshing: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

function isAccountNotFound(err: unknown): boolean {
  if ((err as { status?: number })?.status === 404) return true;
  const message = (err as Error)?.message ?? '';
  return /does not exist|no accounts found|account not found/i.test(message);
}

export function useAccountBalance(
  address: string | undefined,
  network: Network,
): AccountBalance {
  const [algoMicro, setAlgoMicro] = useState(0n);
  const [usdcMicro, setUsdcMicro] = useState(0n);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // `manual` marks a user-initiated pull-to-refresh; the background poll loads
  // silently so no refresh chrome flickers every interval.
  const load = useCallback(
    async (manual: boolean) => {
      if (!address) return;
      if (manual) setIsRefreshing(true);
      try {
        const client = getAlgorandClient(network);
        const info = await client.account.getInformation(address);
        const { usdcAssetId } = NETWORK_CONFIG[network];
        const usdc = info.assets?.find((a) => a.assetId === usdcAssetId);
        setAlgoMicro(info.balance.microAlgo);
        setUsdcMicro(usdc?.amount ?? 0n);
        setError(null);
      } catch (err) {
        if (isAccountNotFound(err)) {
          setAlgoMicro(0n);
          setUsdcMicro(0n);
          setError(null);
        } else {
          setError(err as Error);
        }
      } finally {
        setIsRefreshing(false);
      }
    },
    [address, network],
  );

  const refetch = useCallback(() => load(true), [load]);

  // Fetch on focus and poll while the screen is focused; stop when blurred.
  useFocusEffect(
    useCallback(() => {
      load(false);
      const id = setInterval(() => load(false), POLL_INTERVAL_MS);
      return () => clearInterval(id);
    }, [load]),
  );

  return { algoMicro, usdcMicro, isRefreshing, error, refetch };
}
