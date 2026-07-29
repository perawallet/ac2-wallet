import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/text';
import * as React from 'react';
import { View } from 'react-native';

interface BackHeaderProps {
  onPress: () => void;
  // Shown centered, mirroring the tab header. Omit it when the screen already
  // renders its own heading below the bar.
  title?: string;
  accessibilityLabel?: string;
}

// Back-navigation bar for screens that opt out of the native stack header
// (onboarding). It reuses AppHeader's geometry — a 56pt row on a bordered card
// surface with the icon in the top-left slot — so the chevron lands where the
// chat header's menu icon does.
function BackHeader({ onPress, title, accessibilityLabel = 'Back' }: BackHeaderProps) {
  return (
    <View className="border-b border-border bg-card px-2">
      <View className="h-14 flex-row items-center justify-between">
        <View className="w-[100]">
          <IconButton
            name="chevron-left"
            size={28}
            accessibilityLabel={accessibilityLabel}
            onPress={onPress}
          />
        </View>
        <View className="grow items-center justify-center">
          {title ? <Text className="text-base font-semibold text-foreground">{title}</Text> : null}
        </View>
        <View className="w-[100]" />
      </View>
    </View>
  );
}

export { BackHeader };
