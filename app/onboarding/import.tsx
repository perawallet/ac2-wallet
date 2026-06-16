import React from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PreventScreenshot } from '@/components/PreventScreenshot';
import { useWalletSetup } from '@/hooks/useWalletSetup';

export default function ImportWallet() {
  const router = useRouter();
  const { importWallet } = useWalletSetup();
  const [phrase, setPhrase] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const onImport = async () => {
    setBusy(true);
    try {
      await importWallet(phrase);
      router.replace('/chat');
    } catch (e) {
      Alert.alert('Import failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen className="gap-4 p-6">
      <Text className="text-2xl font-bold text-foreground">Import wallet</Text>
      <Text className="text-sm text-muted-foreground">
        Enter your 24-word recovery phrase, separated by spaces.
      </Text>
      <PreventScreenshot enabled>
        <Input
          className="h-40"
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
          placeholder="word1 word2 word3 ..."
          value={phrase}
          onChangeText={setPhrase}
          accessibilityLabel="Recovery phrase"
        />
      </PreventScreenshot>
      <Button
        onPress={onImport}
        disabled={busy || phrase.trim().length === 0}
        accessibilityLabel="Import Wallet"
      >
        <Text className="text-primary-foreground">{busy ? 'Importing…' : 'Import Wallet'}</Text>
      </Button>
    </Screen>
  );
}
