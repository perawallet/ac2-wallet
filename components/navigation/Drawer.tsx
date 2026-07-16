import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { sessionsStore, type Session } from '@/stores/sessions';
import { closeDrawer, setCurrentConnection, uiStore } from '@/stores/ui';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const HEARTBEAT_WINDOW_MS = 1000;

function SessionStatusIndicator({ session }: { session: Session }) {
  const [heartbeatVisible, setHeartbeatVisible] = React.useState(false);
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;

  React.useEffect(() => {
    if (session.status !== 'active') {
      setHeartbeatVisible(false);
      return;
    }

    const elapsed = Date.now() - session.lastActivity;
    if (elapsed < HEARTBEAT_WINDOW_MS) {
      setHeartbeatVisible(true);
      const timer = setTimeout(() => setHeartbeatVisible(false), HEARTBEAT_WINDOW_MS - elapsed);
      return () => clearTimeout(timer);
    }

    setHeartbeatVisible(false);
  }, [session.lastActivity, session.status]);

  const color =
    session.status === 'failed'
      ? '#EF4444'
      : session.status === 'active'
        ? '#10B981'
        : palette.mutedForeground;

  return (
    <View className="h-6 w-6 items-center justify-center" accessibilityRole="image">
      {session.status === 'active' && heartbeatVisible ? (
        <MaterialIcons name="favorite" size={14} color={color} />
      ) : (
        <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      )}
    </View>
  );
}

function Drawer() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const open = useStore(uiStore, (s) => s.drawerOpen);
  const sessions = useStore(sessionsStore, (s) => s.sessions);
  const panelWidth = Math.min(320, width * 0.82);

  const ordered = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: withTiming(open ? 0 : -panelWidth, { duration: 220 }) }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: withTiming(open ? 1 : 0, { duration: 220 }),
  }));

  const openSession = (session: Session) => {
    setCurrentConnection(session.origin, session.id);
    closeDrawer();
    router.push('/chat');
  };

  return (
    <View pointerEvents={open ? 'auto' : 'none'} className="absolute inset-0" testID="drawer-root">
      <Animated.View style={backdropStyle} className="absolute inset-0 bg-black/50">
        <Pressable className="flex-1" accessibilityLabel="Close chats" onPress={closeDrawer} />
      </Animated.View>
      <Animated.View
        style={[panelStyle, { width: panelWidth, paddingTop: insets.top }]}
        className="absolute bottom-0 left-0 top-0 bg-card"
      >
        <View className="flex-row items-center justify-between border-b border-border p-4">
          <Text className="text-lg font-bold text-foreground">Chats</Text>
          <IconButton name="close" accessibilityLabel="Close chats" onPress={closeDrawer} />
        </View>
        <ScrollView className="flex-1">
          {ordered.length === 0 ? (
            <Text className="p-4 text-sm text-muted-foreground">
              No chats yet. Scan a QR code to start one.
            </Text>
          ) : (
            ordered.map((s) => (
              <Pressable
                key={`${s.origin}:${s.id}`}
                accessibilityRole="button"
                onPress={() => openSession(s)}
                className="border-b border-border p-4 active:bg-muted"
              >
                <View className="flex-row items-center gap-2">
                  <SessionStatusIndicator session={s} />
                  <Text className="flex-1 font-semibold text-foreground" numberOfLines={1}>
                    {s.name?.trim() || s.origin}
                  </Text>
                </View>
                <Text className="ml-8 text-xs text-muted-foreground" numberOfLines={1}>
                  {s.id}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

export { Drawer };
