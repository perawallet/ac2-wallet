import { useProvider } from '@/hooks/useProvider';
import { getAlgorandClient } from '@/lib/algorand/client';
import { NETWORK_CONFIG } from '@/lib/algorand/config';
import { keyStore } from '@/stores/keystore';
import type { Network } from '@/stores/network';
import { decodeAddress } from '@/utils/algorand';
import { generateAddressWithSigners } from '@algorandfoundation/algokit-utils/transact';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

export interface UsdcOptIn {
  isOptingIn: boolean;
  optInToUsdc: () => Promise<void>;
}

function findActiveKey(address: string) {
  const publicKey = decodeAddress(address).publicKey;
  return keyStore.state.keys.find(
    (k) =>
      k.publicKey &&
      k.publicKey.length === publicKey.length &&
      k.publicKey.every((v, i) => v === publicKey[i]),
  );
}

export function useUsdcOptIn(
  address: string | undefined,
  network: Network,
  onSuccess?: () => Promise<void> | void,
): UsdcOptIn {
  const { key } = useProvider();
  const [isOptingIn, setIsOptingIn] = useState(false);

  const optInToUsdc = useCallback(async () => {
    if (!address || isOptingIn) return;

    setIsOptingIn(true);
    try {
      const matchedKey = findActiveKey(address);
      if (!matchedKey?.publicKey) throw new Error('No matching key for active address');

      const signer = generateAddressWithSigners({
        ed25519Pubkey: new Uint8Array(matchedKey.publicKey),
        rawEd25519Signer: (bytesToSign) => key.store.sign(matchedKey.id, bytesToSign),
      }).signer;

      await getAlgorandClient(network).send.assetOptIn({
        sender: address,
        signer,
        assetId: NETWORK_CONFIG[network].usdcAssetId,
        suppressLog: true,
      });

      try {
        await onSuccess?.();
      } catch (refreshErr) {
        console.error('[useUsdcOptIn] failed to refresh balance after opt-in', {
          network,
          address,
          error: refreshErr,
        });
      }
      Alert.alert('USDC enabled', 'This account is opted into USDC.');
    } catch (err) {
      console.error('[useUsdcOptIn] failed to opt in to USDC', {
        network,
        address,
        error: err,
      });

      const errorMessage = err instanceof Error ? err.message : String(err);
      const isInsufficientFunds = errorMessage.toLowerCase().includes('overspend');

      let alertMessage = errorMessage;
      if (isInsufficientFunds) {
        try {
          const suggestedParams = await getAlgorandClient(network).client.algod.suggestedParams();

          // 0.1 ALGO = 100_000 microalgos, minFee is already in microalgos
          const minFee = suggestedParams.minFee;
          const optInCost = 100_000n;
          const totalMicroAlgo = minFee + optInCost;
          // Convert to ALGO and remove trailing zeros for cleaner display
          const totalAlgo = Number(totalMicroAlgo) / 1_000_000;
          const displayCost = parseFloat(totalAlgo.toFixed(6)).toString();
          alertMessage = `You need at least ${displayCost} ALGO in your account to opt into USDC.`;
        } catch (feeErr) {
          console.error('[useUsdcOptIn] failed to query minimum fee', { error: feeErr });
          alertMessage =
            "You don't have enough ALGO in your account to opt into USDC. Please fund your wallet.";
        }
      }

      Alert.alert('USDC opt-in failed', alertMessage);
    } finally {
      setIsOptingIn(false);
    }
  }, [address, isOptingIn, key, network, onSuccess]);

  return { isOptingIn, optInToUsdc };
}
