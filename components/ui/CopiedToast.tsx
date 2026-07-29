import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { View } from 'react-native';

/**
 * Transient "Copied to clipboard" confirmation, pinned to the bottom of the
 * screen. Visibility is decided by `useCopyFeedback`, which only asks for this
 * on platforms that give no native copy feedback.
 */
export function CopiedToast({ visible }: { visible: boolean }) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;

  if (!visible) return null;

  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel="Copied to clipboard"
      className="absolute bottom-4 left-4 right-4 items-center"
    >
      <View className="flex-row items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-lg">
        <MaterialIcons name="check-circle" size={18} color={palette.primary} />
        <Text className="text-sm font-semibold text-card-foreground">Copied to clipboard</Text>
      </View>
    </View>
  );
}
