import { useStore } from '@tanstack/react-store';
import { accountsStore } from '@/stores/accounts';

export function useActiveAccount() {
  const account = useStore(accountsStore, (s) => s.accounts[0]);
  return { account, address: account?.address };
}
