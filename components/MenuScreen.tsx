import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { useProvider } from '@/hooks/useProvider';
import { clearStoredMnemonic } from '@/hooks/useWalletSetup';
import { THEME } from '@/lib/theme';
import { clearAllAc2Messages } from '@/stores/ac2Messages';
import { clearAllAgentIdentities } from '@/stores/agentIdentities';
import { clearAllMessages } from '@/stores/messages';
import { networkStore, setNetwork } from '@/stores/network';
import { clearSessions } from '@/stores/sessions';
import { clearCurrentConnection } from '@/stores/ui';
import { MaterialIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, Switch, View } from 'react-native';

function SectionHeader({ label }: { label: string }) {
  return (
    <Text className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </Text>
  );
}

interface MenuRowProps {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  onPress?: () => void;
  right?: React.ReactNode;
  isLast?: boolean;
}

function MenuRow({ icon, label, onPress, right, isLast }: MenuRowProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : 'none'}
      className={`w-full flex-row items-center bg-card px-4 py-3 active:opacity-70 ${!isLast ? 'border-b border-border' : ''}`}
    >
      <View className="mr-3 h-8 w-8 items-center justify-center rounded-lg bg-muted">
        <MaterialIcons name={icon} size={18} color={palette.mutedForeground} />
      </View>
      <Text className="flex-1 text-base text-foreground">{label}</Text>
      {right ?? <MaterialIcons name="chevron-right" size={20} color={palette.mutedForeground} />}
    </Pressable>
  );
}

export function MenuScreen() {
  const router = useRouter();
  const { key, account, identity, passkey } = useProvider();
  const { colorScheme, setColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? THEME.dark : THEME.light;
  const [currentNetwork, setCurrentNetwork] = useState(networkStore.state.network);

  useEffect(() => {
    const subscription = networkStore.subscribe(() => {
      setCurrentNetwork(networkStore.state.network);
    });
    return () => subscription.unsubscribe();
  }, []);

  const termsUrl = Constants.expoConfig?.extra?.termsOfServiceUrl as string | undefined;
  const privacyUrl = Constants.expoConfig?.extra?.privacyPolicyUrl as string | undefined;
  const ac2OpenClawPluginUrl = Constants.expoConfig?.extra?.ac2OpenClawPluginUrl as
    | string
    | undefined;

  async function openLink(url: string | undefined) {
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch (error) {
      console.error('Failed to open URL', { url, error });
    }
  }

  function confirmResetWallet() {
    Alert.alert(
      'Reset wallet?',
      'This removes local wallet data and credentials from this device. This cannot be undone.',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes',
          style: 'destructive',
          onPress: async () => {
            clearCurrentConnection();
            clearAllMessages();
            clearAllAc2Messages();
            clearAllAgentIdentities();
            await clearSessions();
            await key.store.clear();
            await account.store.clear();
            await identity.store.clear();
            await passkey.store.clear();
            await clearStoredMnemonic();
            router.replace('/onboarding');
          },
        },
      ],
    );
  }

  return (
    <Screen edges={[]} className="justify-start p-4">
      <SectionHeader label="Preferences" />
      <View className="overflow-hidden rounded-xl">
        <MenuRow
          icon="language"
          label={currentNetwork === 'mainnet' ? 'MainNet' : 'TestNet'}
          right={
            <Switch
              value={currentNetwork === 'mainnet'}
              onValueChange={(value) => setNetwork(value ? 'mainnet' : 'testnet')}
              trackColor={{ false: palette.border, true: palette.primary }}
              thumbColor={palette.background}
            />
          }
        />
        <MenuRow
          icon="dark-mode"
          label="Dark Mode"
          isLast
          right={
            <Switch
              value={isDark}
              onValueChange={(value) => setColorScheme(value ? 'dark' : 'light')}
              trackColor={{ false: palette.border, true: palette.primary }}
              thumbColor={palette.background}
            />
          }
        />
      </View>

      <SectionHeader label="Legal" />
      <View className="overflow-hidden rounded-xl">
        {termsUrl ? (
          <MenuRow icon="description" label="Terms of Service" onPress={() => openLink(termsUrl)} />
        ) : null}
        {privacyUrl ? (
          <MenuRow
            icon="privacy-tip"
            label="Privacy Policy"
            onPress={() => openLink(privacyUrl)}
            isLast
          />
        ) : null}
      </View>

      <SectionHeader label="Wallet" />
      <View className="overflow-hidden rounded-xl">
        <MenuRow
          icon="visibility"
          label="View Recovery Phrase"
          onPress={() => router.push('/onboarding/backup')}
        />
        <MenuRow icon="restart-alt" label="Reset Wallet" onPress={confirmResetWallet} isLast />
      </View>

      {ac2OpenClawPluginUrl ? (
        <>
          <SectionHeader label="Integrations" />
          <View className="overflow-hidden rounded-xl">
            <MenuRow
              icon="link"
              label="OpenClaw Plugin"
              onPress={() => openLink(ac2OpenClawPluginUrl)}
              isLast
            />
          </View>
        </>
      ) : null}

      <Text className="mt-auto pt-6 text-center text-xs text-muted-foreground">
        Version: {Constants.expoConfig?.version ?? '—'} (Build Number:{' '}
        {Constants.expoConfig?.ios?.buildNumber ??
          Constants.expoConfig?.android?.versionCode ??
          '—'}
        )
      </Text>
    </Screen>
  );
}
