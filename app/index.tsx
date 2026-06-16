import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useStore } from '@tanstack/react-store';
import { logsStore } from '@/stores/logs';
import Logo from '@/components/Logo';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { useProvider } from '@/hooks/useProvider';

export default function Index() {
  const { keys, status } = useProvider();
  const { colorScheme } = useColorScheme();
  const logs = useStore(logsStore, (state) => state.logs);
  const lastLog = logs.length > 0 ? logs[0].message : 'Initializing...';

  const primaryColor = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;

  if (status === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-background p-6">
        <View className="mb-10">
          <Logo size={100} />
        </View>
        <ActivityIndicator size="large" color={primaryColor} />
        <View className="mt-6 items-center">
          <Text className="text-center text-lg font-semibold text-foreground">{lastLog}</Text>
          <Text className="mt-2 text-center text-sm text-muted-foreground">
            Securing your keys and passkeys
          </Text>
        </View>
      </View>
    );
  }

  if (keys.length > 0) return <Redirect href="/chat" />;
  return <Redirect href="/onboarding" />;
}
