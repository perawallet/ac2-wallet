import React from 'react';
import { Alert, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import SeedPhrase from '@/components/SeedPhrase';
import { getStoredMnemonic } from '@/hooks/useWalletSetup';
import { hasRecoveryPhraseAccess } from '@/lib/keystore/recovery-phrase-access';

export default function VerifyScreen() {
  const router = useRouter();
  const { accessToken } = useLocalSearchParams<{ accessToken?: string | string[] }>();
  const primaryColor = (Constants.expoConfig?.extra?.provider?.primaryColor as string) ?? '#5858F0';
  const [phrase, setPhrase] = React.useState<string[]>([]);
  const [indices, setIndices] = React.useState<number[]>([]);
  const [input, setInput] = React.useState<{ [k: number]: string }>({});

  React.useEffect(() => {
    if (!hasRecoveryPhraseAccess(accessToken)) {
      router.replace('/');
      return;
    }

    getStoredMnemonic().then((m) => {
      if (!m) return;
      const words = m.split(' ');
      setPhrase(words);
      const picks = [2, 7, 13, 19].filter((i) => i < words.length);
      setIndices(picks);
      setInput(Object.fromEntries(picks.map((i) => [i, ''])));
    });
  }, [accessToken, router]);

  const onCheck = () => {
    const ok =
      indices.length > 0 &&
      indices.every((i) => (input[i] ?? '').trim().toLowerCase() === phrase[i]);
    if (ok) router.push('/onboarding/complete');
    else
      Alert.alert('Verification failed', "The words don't match your recovery phrase. Try again.");
  };

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, gap: 16, padding: 24 }}
      >
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onPress={() => router.back()}
          accessibilityLabel="Back to recovery phrase"
        >
          <Text>Back to recovery phrase</Text>
        </Button>
        <Text className="text-2xl font-bold text-foreground">Verify your phrase</Text>
        <Text className="text-sm text-muted-foreground">
          Enter the requested words to confirm your backup.
        </Text>
        <SeedPhrase
          recoveryPhrase={phrase}
          showSeed={false}
          validateWords={input}
          onInputChange={(i, t) => setInput((prev) => ({ ...prev, [i]: t }))}
          primaryColor={primaryColor}
        />
        <Button onPress={onCheck} accessibilityLabel="Check words">
          <Text className="text-primary-foreground">Check words</Text>
        </Button>
      </ScrollView>
    </Screen>
  );
}
