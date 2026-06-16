import * as React from 'react';
import { View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { THEME } from '@/lib/theme';

interface ChatEmptyStateProps {
  onScan: () => void;
}

function ChatEmptyState({ onScan }: ChatEmptyStateProps) {
  const { colorScheme } = useColorScheme();
  const tint = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;
  return (
    <View className="flex-1 items-center justify-center gap-4 p-8">
      <View className="h-20 w-20 items-center justify-center rounded-3xl bg-secondary">
        <MaterialIcons name="qr-code-scanner" size={40} color={tint} />
      </View>
      <Text className="text-xl font-bold text-foreground">Start a new chat</Text>
      <Text className="text-center text-sm text-muted-foreground">
        Scan a QR code to connect with an agent and begin chatting.
      </Text>
      <Button onPress={onScan} accessibilityLabel="Scan QR code">
        <Text className="text-primary-foreground">Scan QR code</Text>
      </Button>
    </View>
  );
}

export { ChatEmptyState };
