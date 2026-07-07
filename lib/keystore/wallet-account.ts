import type { Account } from '@algorandfoundation/accounts-store';
import type { Key } from '@algorandfoundation/keystore';
import type { KeystoreAccount } from '@algorandfoundation/accounts-keystore-extension';

type WalletAccount = Account | KeystoreAccount;

export function isWalletAccountKey(key: Key | undefined): key is Key {
  if (!key?.publicKey) return false;
  if (key.type === 'hd-derived-ed25519') return key.metadata?.context === 0;
  return false;
}

export function findWalletAccount(
  accounts: WalletAccount[],
  keys: Key[],
): { account: WalletAccount; key: Key } | null {
  for (const account of accounts) {
    const key = keys.find((k) => k.id === account.metadata?.keyId);
    if (isWalletAccountKey(key)) return { account, key };
  }

  const key = keys.find(isWalletAccountKey);
  if (!key) return null;
  const account = accounts.find((a) => a.metadata?.keyId === key.id);
  return account ? { account, key } : null;
}
