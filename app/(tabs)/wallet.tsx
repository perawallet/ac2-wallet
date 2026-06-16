import * as React from 'react';
import { ScrollView, RefreshControl, View, Pressable } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useStore } from '@tanstack/react-store';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/theme';
import { Modal } from '@/components/Modal';
import { QRCode } from '@/components/ui/QRCode';
import { networkStore, setNetwork, type Network } from '@/stores/network';
import { useActiveAccount } from '@/hooks/useActiveAccount';
import { useAccountBalance } from '@/hooks/useAccountBalance';
import { formatMicroAmount, truncateAddress } from '@/utils/format';
import { cn } from '@/lib/utils';

const NETWORKS: Network[] = ['testnet', 'mainnet'];

function BalanceCard({ label, amount }: { label: string; amount: bigint }) {
  return (
    <View className="mb-4 rounded-2xl bg-card p-5">
      <Text className="mb-1 text-sm text-muted-foreground">{label}</Text>
      <Text className="text-2xl font-bold text-card-foreground">{formatMicroAmount(amount, 6)}</Text>
    </View>
  );
}

export default function WalletTab() {
  const network = useStore(networkStore, (s) => s.network);
  const { colorScheme } = useColorScheme();
  const iconColor = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;
  const { address } = useActiveAccount();
  const { algoMicro, usdcMicro, isRefreshing, error, refetch } = useAccountBalance(address, network);
  // `copied` is shared intentionally: the address-card icon and the modal copy
  // button both reflect the same "address copied" feedback.
  const [copied, setCopied] = React.useState(false);
  const [receiveOpen, setReceiveOpen] = React.useState(false);
  const copyResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  const copyAddress = React.useCallback(async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopied(false), 1500);
  }, [address]);

  return (
    <Screen className="px-5">
      <ScrollView
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={refetch} />}
        showsVerticalScrollIndicator={false}
      >
        <View className="my-4 flex-row rounded-full bg-muted p-1">
          {NETWORKS.map((n) => (
            <Pressable
              key={n}
              onPress={() => setNetwork(n)}
              accessibilityRole="radio"
              accessibilityState={{ selected: network === n }}
              className={cn('flex-1 items-center rounded-full py-2', network === n && 'bg-background')}
            >
              <Text
                className={cn(
                  'text-sm capitalize',
                  network === n ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {n}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={copyAddress}
          accessibilityRole="button"
          accessibilityLabel="Copy wallet address"
          className="mb-4 rounded-2xl bg-card p-5"
        >
          <Text className="mb-1 text-sm text-muted-foreground">Wallet address</Text>
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-medium text-card-foreground">
              {address ? truncateAddress(address) : '—'}
            </Text>
            <MaterialIcons name={copied ? 'check' : 'content-copy'} size={20} color={iconColor} />
          </View>
        </Pressable>

        <BalanceCard label="ALGO" amount={algoMicro} />
        <BalanceCard label="USDC" amount={usdcMicro} />

        {error ? (
          <Text className="mb-4 text-sm text-destructive">
            Couldn&apos;t load balances. Pull to refresh.
          </Text>
        ) : null}

        <Button onPress={() => setReceiveOpen(true)} disabled={!address}>
          <Text>Receive</Text>
        </Button>
      </ScrollView>

      <Modal visible={receiveOpen} onClose={() => setReceiveOpen(false)} title="Receive">
        <View className="items-center gap-4">
          {address ? <QRCode value={address} /> : null}
          <Text className="text-center text-sm text-card-foreground">{address}</Text>
          <Button variant="outline" onPress={copyAddress}>
            <Text>{copied ? 'Copied' : 'Copy address'}</Text>
          </Button>
        </View>
      </Modal>
    </Screen>
  );
}
