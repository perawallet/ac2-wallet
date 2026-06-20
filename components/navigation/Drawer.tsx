import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/text';
import { sessionsStore, type Session } from '@/stores/sessions';
import { closeDrawer, setCurrentConnection, uiStore } from '@/stores/ui';
import { useStore } from '@tanstack/react-store';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
                <Text className="font-semibold text-foreground" numberOfLines={1}>
                  {s.origin}
                </Text>
                <Text className="text-xs text-muted-foreground">{s.status}</Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

export { Drawer };
