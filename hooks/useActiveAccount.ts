import { useStore } from '@tanstack/react-store';
import { accountsStore } from '@/stores/accounts';
import { normalizeAlgorandAddress } from '@/utils/format';

export function useActiveAccount() {
  const account = useStore(accountsStore, (s) => s.accounts[0]);
  return { account, address: normalizeAlgorandAddress(account?.address) };
}
