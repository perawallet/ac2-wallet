import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/text';
import { toggleDrawer } from '@/stores/ui';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AppHeaderProps {
  title?: string;
}

function AppHeader({ title = 'Chat' }: AppHeaderProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-row items-center justify-between border-b border-border bg-card px-2"
      style={{ paddingTop: insets.top }}
    >
      <View className="w-[100]">
        <IconButton name="menu" accessibilityLabel="Open chats" onPress={toggleDrawer} />
      </View>
      <View className="grow items-center justify-center">
        <Text className="text-base font-semibold text-foreground">{title}</Text>
      </View>
      <View className="w-[100] flex-row justify-end gap-2">
        <IconButton
          name="qr-code-scanner"
          accessibilityLabel="Scan QR code"
          onPress={() => router.push('/scan')}
        />
        <IconButton
          name="smart-toy"
          accessibilityLabel="Agent profile"
          onPress={() => router.push('/profile')}
        />
      </View>
    </View>
  );
}

export { AppHeader };
