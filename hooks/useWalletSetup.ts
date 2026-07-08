import { useProvider } from '@/hooks/useProvider';
import { bootstrap } from '@/lib/keystore/bootstrap';
import { localStorage } from '@/stores/mmkv-local';
import * as bip39 from '@scure/bip39';
import { mnemonicToSeed } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { useCallback } from 'react';
import * as Keychain from 'react-native-keychain';

const MNEMONIC_SERVICE = 'app.perawallet.ac2.mnemonic';

/**
 * Wallet setup from a mnemonic — create (generate a new phrase) or import
 * (use a user-supplied phrase). Both run the same key derivation: clear the
 * keystore, import the HD seed, derive account + identity keys, bootstrap the
 * native side, and persist the mnemonic in the secure keychain for a later
 * backup prompt.
 */
export function useWalletSetup() {
  const { key, account, identity, passkey } = useProvider();

  const setupFromMnemonic = useCallback(
    async (mnemonic: string): Promise<void> => {
      const recoveryPhrase = mnemonic.split(' ');

      await key.store.clear();
      await account.store.clear();
      await identity.store.clear();
      await passkey.store.clear();

      const seedId = await key.store.import(
        {
          type: 'hd-seed',
          algorithm: 'raw',
          extractable: true,
          keyUsages: ['deriveKey', 'deriveBits'],
          privateKey: await mnemonicToSeed(recoveryPhrase.join(' ')),
        },
        'bytes',
      );

      const rootKeyId = await key.store.generate({
        type: 'hd-root-key',
        algorithm: 'raw',
        extractable: true,
        keyUsages: ['deriveKey', 'deriveBits'],
        params: { parentKeyId: seedId },
      });

      await key.store.generate({
        type: 'hd-derived-ed25519',
        algorithm: 'EdDSA',
        extractable: true,
        keyUsages: ['sign', 'verify'],
        params: { parentKeyId: rootKeyId, context: 0, account: 0, index: 0, derivation: 9 },
      });

      await key.store.generate({
        type: 'hd-derived-ed25519',
        algorithm: 'EdDSA',
        extractable: true,
        keyUsages: ['sign', 'verify'],
        params: { parentKeyId: rootKeyId, context: 1, account: 0, index: 0, derivation: 9 },
      });

      await bootstrap(undefined, true);

      await Keychain.setGenericPassword('mnemonic', mnemonic, { service: MNEMONIC_SERVICE });
      localStorage.set('mnemonicBackedUp', false);
    },
    [key, account, identity, passkey],
  );

  const createWallet = useCallback(async (): Promise<{ mnemonic: string }> => {
    const mnemonic = bip39.generateMnemonic(wordlist, 256);
    await setupFromMnemonic(mnemonic);
    return { mnemonic };
  }, [setupFromMnemonic]);

  const importWallet = useCallback(
    async (mnemonic: string): Promise<void> => {
      const normalized = mnemonic.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!bip39.validateMnemonic(normalized, wordlist)) {
        throw new Error('Invalid recovery phrase. Check the words and try again.');
      }
      await setupFromMnemonic(normalized);
    },
    [setupFromMnemonic],
  );

  return { createWallet, importWallet };
}

export async function getStoredMnemonic(): Promise<string | null> {
  const result = await Keychain.getGenericPassword({ service: MNEMONIC_SERVICE });
  return result ? result.password : null;
}

export async function clearStoredMnemonic(): Promise<void> {
  await Keychain.resetGenericPassword({ service: MNEMONIC_SERVICE });
}
