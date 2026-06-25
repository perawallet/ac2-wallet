import { HeaderImage } from '@/components/HeaderImage';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { useProvider } from '@/hooks/useProvider';
import { useWalletSetup } from '@/hooks/useWalletSetup';
import { THEME } from '@/lib/theme';
import { MaterialIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { usePathname, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import React from 'react';
import { Alert, Linking, Pressable, Modal as RNModal, ScrollView, View } from 'react-native';

export default function Welcome() {
  const router = useRouter();
  const pathname = usePathname();
  const { keys } = useProvider();
  const { createWallet } = useWalletSetup();
  const [consentVisible, setConsentVisible] = React.useState(true);
  const [ageConfirmed, setAgeConfirmed] = React.useState(false);
  const [sanctionsConfirmed, setSanctionsConfirmed] = React.useState(false);
  const { colorScheme } = useColorScheme();
  const iconColor =
    colorScheme === 'dark' ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const primaryColor = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;
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
          <View className="w-full max-h-[90%] rounded-3xl bg-card shadow-lg">
            {/* Header */}
            <View className="flex-shrink-0 border-b border-border px-5 pb-4 pt-5">
              <Text className="text-lg font-bold text-card-foreground">
                ⚠️ Please read before you accept
              </Text>
            </View>

            <ScrollView className="px-5 py-4">
              {/* Arbitration notice */}
              <Text className="text-sm leading-relaxed text-muted-foreground">
                By accepting, you agree that any dispute between you and Pera Wallet, Lda relating
                to the AC2 Wallet will be resolved by binding individual arbitration, not in court.
                You give up your right to a jury trial and your right to participate in a class
                action. You can opt out of arbitration by emailing{' '}
                <Text
                  className="text-sm font-medium text-primary"
                  onPress={() => openLink('mailto:legal@algorand.foundation')}
                >
                  legal@algorand.foundation
                </Text>{' '}
                within 30 days of accepting. See Section 16 of the Terms of Service for details.
              </Text>

              {/* Terms & Privacy links */}
              <View className="mt-4 flex-row gap-5">
                {termsUrl ? (
                  <Pressable
                    onPress={() => openLink(termsUrl)}
                    accessibilityRole="button"
                    accessibilityLabel="Open Terms of Service"
                  >
                    <Text className="text-sm font-medium text-primary">Terms of Service</Text>
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

              {/* Checkboxes */}
              <View className="mt-5 gap-4">
                {/* Age confirmation */}
                <Pressable
                  className="flex-row items-start gap-3"
                  onPress={() => setAgeConfirmed((v) => !v)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: ageConfirmed }}
                  accessibilityLabel="I am 18 years of age or older"
                >
                  <MaterialIcons
                    name={ageConfirmed ? 'check-box' : 'check-box-outline-blank'}
                    size={22}
                    color={ageConfirmed ? primaryColor : iconColor}
                    style={{ marginTop: 1 }}
                  />
                  <Text className="flex-1 text-sm leading-relaxed text-card-foreground">
                    I confirm that I am 18 years of age or older.
                  </Text>
                </Pressable>

                {/* Sanctions representation */}
                <Pressable
                  className="flex-row items-start gap-3"
                  onPress={() => setSanctionsConfirmed((v) => !v)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: sanctionsConfirmed }}
                  accessibilityLabel="Sanctions representation"
                >
                  <MaterialIcons
                    name={sanctionsConfirmed ? 'check-box' : 'check-box-outline-blank'}
                    size={22}
                    color={sanctionsConfirmed ? primaryColor : iconColor}
                    style={{ marginTop: 1 }}
                  />
                  <Text className="flex-1 text-sm leading-relaxed text-card-foreground">
                    I am not located in, and I am not a national or resident of, a country or region
                    subject to comprehensive UN, EU, US (OFAC), or UK sanctions, and I am not on any
                    prohibited- or restricted-persons list.
                  </Text>
                </Pressable>
              </View>
            </ScrollView>

            {/* Accept button */}
            <View className="flex-shrink-0 px-5 pb-5 pt-4">
              <Button
                onPress={continueAfterConsent}
                disabled={!ageConfirmed || !sanctionsConfirmed}
                accessibilityLabel="I accept"
              >
                <Text className="text-primary-foreground">I accept</Text>
              </Button>
            </View>
          </View>
        </View>
      </RNModal>
    </Screen>
  );
}
