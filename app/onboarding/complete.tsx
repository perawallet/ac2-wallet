import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { localStorage } from '@/stores/mmkv-local';

export default function CompleteScreen() {
  const router = useRouter();
  React.useEffect(() => {
    localStorage.set('mnemonicBackedUp', true);
  }, []);
  return (
    <Screen className="items-center justify-center gap-4 p-8">
      <View className="h-20 w-20 items-center justify-center rounded-full bg-primary">
        <MaterialIcons name="check" size={48} color="#FFFFFF" />
      </View>
      <Text className="text-2xl font-bold text-foreground">Identity secured</Text>
      <Text className="text-center text-sm text-muted-foreground">
        Your recovery phrase is backed up.
      </Text>
      <Button onPress={() => router.replace('/chat')} accessibilityLabel="Done">
        <Text className="text-primary-foreground">Done</Text>
      </Button>
    </Screen>
  );
}
