import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { getAlgorandClient } from '@/lib/algorand/client';
import { NETWORK_CONFIG } from '@/lib/algorand/config';
import { keyStore } from '@/stores/keystore';
import type { Network } from '@/stores/network';
import { decodeAddress } from '@/utils/algorand';
import { useProvider } from '@/hooks/useProvider';
import { generateAddressWithSigners } from '@algorandfoundation/algokit-utils/transact';

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
      Alert.alert('USDC opt-in failed', err instanceof Error ? err.message : String(err));
    } finally {
      setIsOptingIn(false);
    }
  }, [address, isOptingIn, key, network, onSuccess]);

  return { isOptingIn, optInToUsdc };
}
