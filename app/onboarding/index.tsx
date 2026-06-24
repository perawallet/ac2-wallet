import { HeaderImage } from '@/components/HeaderImage';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { useProvider } from '@/hooks/useProvider';
import { useWalletSetup } from '@/hooks/useWalletSetup';
import Constants from 'expo-constants';
import { usePathname, useRouter } from 'expo-router';
import React from 'react';
import { Alert, Linking, Pressable, Modal as RNModal, View } from 'react-native';

export default function Welcome() {
  const router = useRouter();
  const pathname = usePathname();
  const { keys } = useProvider();
  const { createWallet } = useWalletSetup();
  const [consentVisible, setConsentVisible] = React.useState(true);
  const termsUrl = Constants.expoConfig?.extra?.termsOfServiceUrl as string | undefined;
  const privacyUrl = Constants.expoConfig?.extra?.privacyPolicyUrl as string | undefined;

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

  const openLink = async (url: string | undefined) => {
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch (e) {
      Alert.alert('Could not open link', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const continueAfterConsent = () => setConsentVisible(false);

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

      <RNModal
        visible={consentVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          // Intentionally non-dismissible; user must explicitly agree.
        }}
      >
        <View className="flex-1 items-center justify-center bg-black/50 p-5">
          <View className="w-full rounded-3xl bg-card p-5 shadow-lg">
            <Text className="text-lg font-bold text-card-foreground">Terms and Privacy</Text>
            <Text className="mt-3 text-sm text-muted-foreground">
              By using the AC2 Wallet you are agreeing to the Terms and Conditions and Privacy
              Policy.
            </Text>

            <View className="mt-4 flex-row justify-start gap-5">
              {termsUrl ? (
                <Pressable
                  onPress={() => openLink(termsUrl)}
                  accessibilityRole="button"
                  accessibilityLabel="Open Terms and Conditions"
                >
                  <Text className="text-sm font-medium text-primary">Terms and Conditions</Text>
                </Pressable>
              ) : null}
              {privacyUrl ? (
                <Pressable
                  onPress={() => openLink(privacyUrl)}
                  accessibilityRole="button"
                  accessibilityLabel="Open Privacy Policy"
                >
                  <Text className="text-sm font-medium text-primary">Privacy Policy</Text>
                </Pressable>
              ) : null}
            </View>

            <View className="mt-5">
              <Button onPress={continueAfterConsent} accessibilityLabel="I agree">
                <Text className="text-primary-foreground">I agree</Text>
              </Button>
            </View>
          </View>
        </View>
      </RNModal>
    </Screen>
  );
}
