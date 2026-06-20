import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/utils';
import { MaterialIcons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

interface ConnectionStatusBarProps {
  isConnected: boolean;
  isError: boolean;
  /** Briefly true on each heartbeat to flash the liveness indicator. */
  heartbeatVisible: boolean;
  onClear: () => void;
  onDisconnect: () => void;
  /** The thread switcher, rendered as the flexible middle of the bar. */
  children?: React.ReactNode;
}

// Fixed-footprint connection indicator. It normally shows a colored status dot;
// while a heartbeat is in flight it pulses and swaps to a heart, conveying
// liveness without ever changing the icon's footprint — so its neighbours never
// shift when a heartbeat arrives.
function StatusIndicator({
  isConnected,
  isError,
  heartbeatVisible,
}: Pick<ConnectionStatusBarProps, 'isConnected' | 'isError' | 'heartbeatVisible'>) {
  const scale = useSharedValue(1);
  React.useEffect(() => {
    if (heartbeatVisible) {
      scale.value = withSequence(
        withTiming(1.4, { duration: 140 }),
        withTiming(1, { duration: 360 }),
      );
    }
  }, [heartbeatVisible, scale]);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const dotClass = isConnected
    ? 'bg-emerald-500'
    : isError
      ? 'bg-destructive'
      : 'bg-muted-foreground';
  const beating = isConnected && heartbeatVisible;

  return (
    <Animated.View
      style={animatedStyle}
      className="h-9 w-6 items-center justify-center"
      accessibilityRole="image"
      accessibilityLabel={
        isConnected
          ? beating
            ? 'Heartbeat received'
            : 'Connected'
          : isError
            ? 'Connection error'
            : 'Disconnected'
      }
    >
      {beating ? (
        <MaterialIcons name="favorite" size={14} color="#10B981" />
      ) : (
        <View className={cn('h-2.5 w-2.5 rounded-full', dotClass)} />
      )}
    </Animated.View>
  );
}

// Slim status strip rendered under the tab header. The thread switcher fills the
// middle; the liveness indicator and the clear/disconnect controls sit on the
// right, keeping the whole strip to a single compact row.
function ConnectionStatusBar({
  isConnected,
  isError,
  heartbeatVisible,
  onClear,
  onDisconnect,
  children,
}: ConnectionStatusBarProps) {
  return (
    <View className="flex-row items-center border-b border-border bg-card pl-1 pr-1">
      <StatusIndicator
        isConnected={isConnected}
        isError={isError}
        heartbeatVisible={heartbeatVisible}
      />
      <View className="flex-1">{children}</View>
      <IconButton
        name="delete-outline"
        size={20}
        tint="mutedForeground"
        accessibilityLabel="Clear conversation"
        onPress={onClear}
      />
      <IconButton
        name="link-off"
        size={20}
        accessibilityLabel="Disconnect"
        onPress={onDisconnect}
      />
    </View>
  );
}

export { ConnectionStatusBar };
