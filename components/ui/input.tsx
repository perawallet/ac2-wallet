import * as React from 'react';
import { TextInput } from 'react-native';
import { useColorScheme } from 'nativewind';
import { cn } from '@/lib/utils';
import { THEME } from '@/lib/theme';

function Input({ className, ...props }: React.ComponentProps<typeof TextInput>) {
  const { colorScheme } = useColorScheme();
  const placeholderColor =
    colorScheme === 'dark' ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  return (
    <TextInput
      placeholderTextColor={placeholderColor}
      className={cn(
        'h-12 rounded-md border border-input bg-background px-3 text-base text-foreground',
        props.editable === false && 'opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
