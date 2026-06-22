import * as React from 'react';
import { Pressable } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { cn } from '@/lib/utils';
import { THEME } from '@/lib/theme';

type MaterialIconName = React.ComponentProps<typeof MaterialIcons>['name'];

interface IconButtonProps {
  name: MaterialIconName;
  onPress?: () => void;
  size?: number;
  tint?: 'foreground' | 'primary' | 'mutedForeground';
  accessibilityLabel: string;
  className?: string;
  disabled?: boolean;
}

function IconButton({
  name,
  onPress,
  size = 24,
  tint = 'foreground',
  accessibilityLabel,
  className,
  disabled,
}: IconButtonProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const color =
    tint === 'primary'
      ? palette.primary
      : tint === 'mutedForeground'
        ? palette.mutedForeground
        : palette.foreground;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className={cn(
        'h-10 w-10 items-center justify-center rounded-full active:bg-muted',
        disabled && 'opacity-50',
        className,
      )}
    >
      <MaterialIcons name={name} size={size} color={color} />
    </Pressable>
  );
}

export { IconButton };
export type { MaterialIconName };
