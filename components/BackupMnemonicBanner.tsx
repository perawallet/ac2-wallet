import { Text } from '@/components/ui/text';
import { authenticateToViewRecoveryPhrase } from '@/lib/keystore/authenticate';
import { createRecoveryPhraseAccessToken } from '@/lib/keystore/recovery-phrase-access';
import { localStorage } from '@/stores/mmkv-local';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import * as React from 'react';
import { Pressable } from 'react-native';

function BackupMnemonicBanner() {
  const router = useRouter();
  const [visible, setVisible] = React.useState(() => !localStorage.getBoolean('mnemonicBackedUp'));
  const authPending = React.useRef(false);

  useFocusEffect(
    React.useCallback(() => {
      setVisible(!localStorage.getBoolean('mnemonicBackedUp'));
    }, []),
  );

  if (!visible) return null;

  const openBackup = async () => {
    if (authPending.current) return;

    authPending.current = true;
    try {
      const authenticated = await authenticateToViewRecoveryPhrase();
      if (!authenticated) return;

      const accessToken = createRecoveryPhraseAccessToken();
      router.push({ pathname: '/onboarding/backup', params: { accessToken } });
    } finally {
      authPending.current = false;
    }
  };

  return (
    <Pressable
      onPress={openBackup}
      accessibilityRole="button"
      accessibilityLabel="Back up recovery phrase"
      className="flex-row items-center gap-2 border-b border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30"
    >
      <MaterialIcons name="warning-amber" size={18} color="#D97706" />
      <Text className="flex-1 text-sm font-semibold text-amber-800 dark:text-amber-300">
        Action Required: Backup Mnemonic
      </Text>
      <Pressable
        onPress={() => setVisible(false)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Dismiss backup reminder"
        className="p-1"
      >
        <MaterialIcons name="close" size={18} color="#D97706" />
      </Pressable>
    </Pressable>
  );
}

export { BackupMnemonicBanner };
