import * as React from 'react';
import { View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import type { MaterialIconName } from '@/components/ui/IconButton';

interface PlaceholderScreenProps {
  icon: MaterialIconName;
  title: string;
  subtitle?: string;
}

function PlaceholderScreen({ icon, title, subtitle }: PlaceholderScreenProps) {
  const { colorScheme } = useColorScheme();
  const tint = colorScheme === 'dark' ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  return (
    <Screen className="items-center justify-center gap-3 p-8">
      <View className="h-16 w-16 items-center justify-center rounded-2xl bg-muted">
        <MaterialIcons name={icon} size={32} color={tint} />
      </View>
      <Text className="text-xl font-bold text-foreground">{title}</Text>
      {subtitle ? (
        <Text className="text-center text-sm text-muted-foreground">{subtitle}</Text>
      ) : null}
    </Screen>
  );
}

export { PlaceholderScreen };
