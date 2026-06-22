import { QRCode } from '@/components/ui/QRCode';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { useAccountBalance } from '@/hooks/useAccountBalance';
import { useActiveAccount } from '@/hooks/useActiveAccount';
import { THEME } from '@/lib/theme';
import { networkStore } from '@/stores/network';
import { formatMicroAmount, truncateAddress } from '@/utils/format';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

export default function WalletTab() {
  const network = useStore(networkStore, (s) => s.network);
  const { colorScheme } = useColorScheme();
  const iconColor = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;
  const { address } = useActiveAccount();
  const { algoMicro, usdcMicro, isRefreshing, error, refetch } = useAccountBalance(
    address,
    network,
  );
  const [copied, setCopied] = React.useState(false);
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
        <View className="mb-8 mx-2 items-left">
          <Text className="mb-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Wallet Balance
          </Text>
          <Text className="text-5xl font-bold text-foreground">
            {formatMicroAmount(usdcMicro, 6)} USDC
          </Text>
          <Text className="mt-3 text-base text-muted-foreground">
            {formatMicroAmount(algoMicro, 6)} ALGO
          </Text>
        </View>

        <Pressable
          onPress={copyAddress}
          accessibilityRole="button"
          accessibilityLabel="Copy wallet address"
          className="mb-4 rounded-2xl bg-card py-10 px-5 gap-5"
        >
          <Text className="mb-1 text-sm text-muted-foreground">Wallet address</Text>
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-medium text-card-foreground">
              {address ? truncateAddress(address) : '—'}
            </Text>
            <MaterialIcons name={copied ? 'check' : 'content-copy'} size={20} color={iconColor} />
          </View>

          {address ? (
            <View className="items-center gap-4">
              <QRCode value={address} />
              <Text className="px-6 text-center text-sm text-muted-foreground">
                Scan the QR code to receive funds to this address
              </Text>
            </View>
          ) : null}
        </Pressable>

        {error ? (
          <Text className="mb-4 text-sm text-destructive">
            Couldn&apos;t load balances. Pull to refresh.
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
