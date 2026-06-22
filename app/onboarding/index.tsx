import { HeaderImage } from '@/components/HeaderImage';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { useProvider } from '@/hooks/useProvider';
import { useWalletSetup } from '@/hooks/useWalletSetup';
import { usePathname, useRouter } from 'expo-router';
import React from 'react';
import { Alert, View } from 'react-native';

export default function Welcome() {
  const router = useRouter();
  const pathname = usePathname();
  const { keys } = useProvider();
  const { createWallet } = useWalletSetup();

  React.useEffect(() => {
    if (keys.length > 0 && pathname === '/onboarding') {
      router.replace('/chat');
    }
  }, [keys, pathname, router]);

  const handleCreate = async () => {
    if (keys.length > 0) {
      router.replace('/chat');
      return;
    }
    try {
      await createWallet();
      router.replace('/chat');
    } catch (e) {
      Alert.alert('Could not create wallet', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  return (
    <Screen className="justify-between">
      <View className="gap-6">
        <HeaderImage />
        <View className="gap-5 p-6">
          <Text className="text-center text-3xl font-bold text-foreground">AC2 Wallet</Text>
          <Text className="text-center text-base text-muted-foreground">
            Unleash your agents. Keep control.
          </Text>
          <Text className="text-center text-base text-muted-foreground">
            AC2 Wallet is your agentic wallet for secure and private AI interactions.
          </Text>
        </View>
      </View>
      <View className="gap-3 p-6">
        <Button onPress={handleCreate} accessibilityLabel="Create Wallet">
          <Text className="text-primary-foreground">Create Wallet</Text>
        </Button>
        <Button
          variant="outline"
          onPress={() => router.push('/onboarding/import')}
          accessibilityLabel="Import Existing Wallet"
        >
          <Text className="text-foreground">Import Existing Wallet</Text>
        </Button>
      </View>
    </Screen>
  );
}
