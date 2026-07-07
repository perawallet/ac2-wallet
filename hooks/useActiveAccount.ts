import { useStore } from '@tanstack/react-store';
import { accountsStore } from '@/stores/accounts';
import { normalizeAlgorandAddress } from '@/utils/format';
import { keyStore } from '@/stores/keystore';
import { findWalletAccount } from '@/lib/keystore/wallet-account';

export function useActiveAccount() {
  const accounts = useStore(accountsStore, (s) => s.accounts);
  const keys = useStore(keyStore, (s) => s.keys);
  const account = findWalletAccount(accounts, keys)?.account;
  return { account, address: normalizeAlgorandAddress(account?.address) };
}
