import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, View } from 'react-native';
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
  onRename: () => void;
  onClear: () => void;
  onDisconnect: () => void;
  onForget: () => void;
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
// middle; the liveness indicator and a kebab menu sit on the right.
function ConnectionStatusBar({
  isConnected,
  isError,
  heartbeatVisible,
  onRename,
  onClear,
  onDisconnect,
  onForget,
  children,
}: ConnectionStatusBarProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [menuVisible, setMenuVisible] = React.useState(false);
  const [menuTop, setMenuTop] = React.useState(0);
  const [menuRight, setMenuRight] = React.useState(8);
  const kebabRef = React.useRef<View>(null);

  const openMenu = () => {
    kebabRef.current?.measure((_x, _y, width, height, pageX, pageY) => {
      const screenWidth = Dimensions.get('window').width;
      setMenuTop(pageY + height + 4);
      setMenuRight(screenWidth - pageX - width);
      setMenuVisible(true);
    });
  };

  const closeAndCall = (fn: () => void) => {
    setMenuVisible(false);
    fn();
  };

  const menuItems: {
    label: string;
    icon: React.ComponentProps<typeof MaterialIcons>['name'];
    onPress: () => void;
    destructive?: boolean;
  }[] = [
    { label: 'Rename', icon: 'edit', onPress: () => closeAndCall(onRename) },
    { label: 'Clear', icon: 'delete-outline', onPress: () => closeAndCall(onClear) },
    { label: 'Disconnect', icon: 'link-off', onPress: () => closeAndCall(onDisconnect) },
    {
      label: 'Forget',
      icon: 'delete-forever',
      onPress: () => closeAndCall(onForget),
      destructive: true,
    },
  ];

  return (
    <View className="flex-row items-center border-b border-border bg-card pl-1 pr-1">
      <StatusIndicator
        isConnected={isConnected}
        isError={isError}
        heartbeatVisible={heartbeatVisible}
      />
      <View className="flex-1">{children}</View>
      <View ref={kebabRef}>
        <IconButton
          name="more-vert"
          size={20}
          accessibilityLabel="Connection options"
          onPress={openMenu}
        />
      </View>

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuVisible(false)} />
        <View
          className="absolute rounded-xl border border-border bg-card"
          style={{ top: menuTop, right: menuRight, minWidth: 180, elevation: 8 }}
        >
          {menuItems.map((item, index) => (
            <Pressable
              key={item.label}
              onPress={item.onPress}
              className={cn(
                'flex-row items-center gap-3 px-4 py-3',
                index < menuItems.length - 1 && 'border-b border-border',
              )}
            >
              <MaterialIcons
                name={item.icon}
                size={18}
                color={item.destructive ? '#EF4444' : palette.foreground}
              />
              <Text
                className={cn(
                  'text-sm font-medium',
                  item.destructive ? 'text-destructive' : 'text-foreground',
                )}
              >
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </View>
  );
}

export { ConnectionStatusBar };
