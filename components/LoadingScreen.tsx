import Logo from '@/components/Logo';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { logsStore } from '@/stores/logs';
import { useStore } from '@tanstack/react-store';
import { useColorScheme } from 'nativewind';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';

/**
 * Full-screen loading state shown while fonts load and the keystore bootstraps.
 * Rendered by the root gate (see `app/_layout.tsx`) so no authenticated screen
 * mounts before its data is ready.
 */
export function LoadingScreen({ fontsLoaded }: { fontsLoaded: boolean }) {
  const { colorScheme } = useColorScheme();
  const logs = useStore(logsStore, (state) => state.logs);
  const lastLog = logs.length > 0 ? logs[0].message : 'Initializing...';

  const primaryColor = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;

  return (
    <View className="flex-1 items-center justify-center bg-background p-6">
      <View className="mb-10">
        <Logo size={100} />
      </View>
      <ActivityIndicator size="large" color={primaryColor} />
      <View className="mt-6 items-center">
        <Text className="text-center text-lg font-semibold text-foreground">
          {fontsLoaded ? lastLog : 'Loading fonts...'}
        </Text>
        <Text className="mt-2 text-center text-sm text-muted-foreground">
          Securing your keys and passkeys
        </Text>
      </View>
    </View>
  );
}
