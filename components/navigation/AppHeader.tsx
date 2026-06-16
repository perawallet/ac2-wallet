import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/text';
import { toggleDrawer } from '@/stores/ui';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AppHeaderProps {
  title?: string;
  // The menu and action icons are only relevant on the chat page; other pages
  // show just the centered title.
  showActions?: boolean;
}

function AppHeader({ title = 'Chat', showActions = false }: AppHeaderProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      className="border-b border-border bg-card px-2"
      style={{ paddingTop: insets.top }}
    >
      <View className="h-14 flex-row items-center justify-between">
        <View className="w-[100]">
          {showActions ? (
            <IconButton name="menu" accessibilityLabel="Open chats" onPress={toggleDrawer} />
          ) : null}
        </View>
        <View className="grow items-center justify-center">
          <Text className="text-base font-semibold text-foreground">{title}</Text>
        </View>
        <View className="w-[100] flex-row">
          {showActions ? (
            <>
              <IconButton
                name="qr-code-scanner"
                accessibilityLabel="Scan QR code"
                onPress={() => router.push('/scan')}
              />
              <IconButton
                name="history"
                accessibilityLabel="History"
                onPress={() => router.push('/history')}
              />
              <IconButton
                name="smart-toy"
                accessibilityLabel="Agent profile"
                onPress={() => router.push('/profile')}
              />
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export { AppHeader };
