import React from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { PreventScreenshot } from '@/components/PreventScreenshot';
import SeedPhrase from '@/components/SeedPhrase';
import { getStoredMnemonic } from '@/hooks/useWalletSetup';
import {
  createRecoveryPhraseAccessToken,
  hasRecoveryPhraseAccess,
} from '@/lib/keystore/recovery-phrase-access';

export default function BackupScreen() {
  const router = useRouter();
  const { accessToken } = useLocalSearchParams<{ accessToken?: string | string[] }>();
  const primaryColor = (Constants.expoConfig?.extra?.provider?.primaryColor as string) ?? '#5858F0';
  const [phrase, setPhrase] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!hasRecoveryPhraseAccess(accessToken)) {
      router.replace('/');
      return;
    }

    getStoredMnemonic().then((m) => {
      if (m) setPhrase(m.split(' '));
    });
  }, [accessToken, router]);

  const continueToVerification = () => {
    const verificationAccessToken = createRecoveryPhraseAccessToken();
    router.push({
      pathname: '/onboarding/verify',
      params: { accessToken: verificationAccessToken },
    });
  };

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ flexGrow: 1, gap: 16, padding: 24 }}
      >
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onPress={() => router.back()}
          accessibilityLabel="Back"
        >
          <Text>Back</Text>
        </Button>
        <Text className="text-2xl font-bold text-foreground">Back up your phrase</Text>
        <Text className="text-sm text-muted-foreground">
          Write down these 24 words in order and store them somewhere safe and offline.
        </Text>
        <PreventScreenshot enabled>
          <SeedPhrase recoveryPhrase={phrase} showSeed primaryColor={primaryColor} />
        </PreventScreenshot>
        <Button onPress={continueToVerification} accessibilityLabel="I have written it down">
          <Text className="text-primary-foreground">I've written it down</Text>
        </Button>
      </ScrollView>
    </Screen>
  );
}
