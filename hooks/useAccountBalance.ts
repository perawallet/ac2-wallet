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

// A valid address that simply isn't on chain yet isn't an error — algod returns
// it as a zero balance. But some nodes/configs signal an unknown account with a
// 404 instead, so treat that as an empty account rather than a failure. We check
// every place the status can surface (direct, nested under `response`/`body`) and
// fall back to the message text.
function isAccountNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    status?: number;
    response?: { status?: number };
    body?: { message?: string };
    message?: string;
  };
  if (e.status === 404 || e.response?.status === 404) return true;
  const message = `${e.body?.message ?? ''} ${e.message ?? ''}`;
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
          // Log the underlying cause: the UI only shows a generic "couldn't
          // load balances" message, so without this the real error (network
          // failure, unexpected status, parse error) is invisible.
          console.error('[useAccountBalance] failed to load balance', {
            network,
            address,
            error: err,
          });
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
