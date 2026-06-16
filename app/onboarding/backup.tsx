import React from 'react';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { PreventScreenshot } from '@/components/PreventScreenshot';
import SeedPhrase from '@/components/SeedPhrase';
import { getStoredMnemonic } from '@/hooks/useWalletSetup';

export default function BackupScreen() {
  const router = useRouter();
  const primaryColor = (Constants.expoConfig?.extra?.provider?.primaryColor as string) ?? '#0052FF';
  const [phrase, setPhrase] = React.useState<string[]>([]);

  React.useEffect(() => {
    getStoredMnemonic().then((m) => {
      if (m) setPhrase(m.split(' '));
    });
  }, []);

  return (
    <Screen className="gap-4 p-6">
      <Text className="text-2xl font-bold text-foreground">Back up your phrase</Text>
      <Text className="text-sm text-muted-foreground">
        Write down these 24 words in order and store them somewhere safe and offline.
      </Text>
      <PreventScreenshot enabled>
        <SeedPhrase recoveryPhrase={phrase} showSeed primaryColor={primaryColor} />
      </PreventScreenshot>
      <Button
        onPress={() => router.push('/onboarding/verify')}
        accessibilityLabel="I have written it down"
      >
        <Text className="text-primary-foreground">I've written it down</Text>
      </Button>
    </Screen>
  );
}
