import * as React from 'react';
import { View, Pressable } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import type { MaterialIconName } from '@/components/ui/IconButton';

const ICONS: Record<string, MaterialIconName> = {
  chat: 'chat-bubble-outline',
  wallet: 'account-balance-wallet',
  audit: 'fact-check',
  menu: 'menu',
};

const LABELS: Record<string, string> = {
  chat: 'Chat',
  wallet: 'Wallet',
  audit: 'Audit',
  menu: 'Menu',
};

function TabBar({ state, navigation }: BottomTabBarProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const insets = useSafeAreaInsets();
  return (
    <View
      className="flex-row border-t border-border bg-card"
      style={{ paddingBottom: insets.bottom }}
    >
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        };
        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            accessibilityLabel={LABELS[route.name] ?? route.name}
            className="flex-1 items-center justify-center gap-1 py-2"
          >
            <MaterialIcons
              name={ICONS[route.name] ?? 'circle'}
              size={24}
              color={focused ? palette.primary : palette.mutedForeground}
            />
            <Text
              className={
                focused ? 'text-xs font-semibold text-primary' : 'text-xs text-muted-foreground'
              }
            >
              {LABELS[route.name] ?? route.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export { TabBar };
