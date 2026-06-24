import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';

interface ReconnectBarProps {
  onReconnect: () => void;
  /** When true the previous attempt failed; copy reflects an error vs. a drop. */
  isError?: boolean;
}

// Footer shown in place of the composer when the transport has dropped. Mirrors
// the composer's bar styling so the chat surface keeps a consistent footprint,
// and gives the user an explicit affordance to re-establish the connection.
function ReconnectBar({ onReconnect, isError }: ReconnectBarProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  return (
    <View
      className="flex-row items-center gap-3 border-t border-border bg-card p-3"
      style={{ paddingBottom: 12 }}
    >
      <MaterialIcons name="cloud-off" size={20} color={palette.mutedForeground} />
      <Text className="flex-1 text-sm text-muted-foreground">
        {isError ? 'Connection failed.' : 'Disconnected.'}
      </Text>
      <Pressable
        onPress={onReconnect}
        accessibilityRole="button"
        accessibilityLabel="Reconnect"
        className="flex-row items-center gap-1.5 rounded-md bg-primary px-4 py-2 active:opacity-90"
      >
        <MaterialIcons name="refresh" size={16} color={THEME.dark.foreground} />
        <Text className="text-sm font-semibold text-primary-foreground">Reconnect</Text>
      </Pressable>
    </View>
  );
}

export { ReconnectBar };
