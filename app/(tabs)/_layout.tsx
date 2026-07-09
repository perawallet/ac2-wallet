import { BackupMnemonicBanner } from '@/components/BackupMnemonicBanner';
import { ThemedCopilotProvider } from '@/components/CopilotUI';
import { AppHeader } from '@/components/navigation/AppHeader';
import { TabBar } from '@/components/navigation/TabBar';
import { useGettingStartedGuide } from '@/hooks/useGettingStartedGuide';
import { setTabsHeaderHeight } from '@/stores/ui';
import { Tabs } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { useCopilot } from 'react-native-copilot';

const TITLES: Record<string, string> = {
  chat: 'Chat',
  wallet: 'Wallet',
  credentials: 'Credentials',
  menu: 'Menu',
};

function GettingStartedGuideStarter() {
  const { start, copilotEvents } = useCopilot();
  const { shouldShowGuide, markAsSeen } = useGettingStartedGuide();
  // `start` is recreated by copilot whenever steps register, so the initial
  // capture in the effect closure would see an empty step list. A ref lets the
  // timeout always call the latest version.
  const startRef = React.useRef(start);
  startRef.current = start;

  React.useEffect(() => {
    if (!shouldShowGuide) return;
    const timer = setTimeout(() => {
      void startRef.current();
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    copilotEvents.on('stop', markAsSeen);
    return () => {
      copilotEvents.off('stop', markAsSeen);
    };
  }, [copilotEvents, markAsSeen]);

  return null;
}

export default function TabsLayout() {
  return (
    <ThemedCopilotProvider>
      <GettingStartedGuideStarter />
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={({ route }) => ({
          headerShown: true,
          header: () => (
            <View onLayout={(e) => setTabsHeaderHeight(e.nativeEvent.layout.height)}>
              <AppHeader title={TITLES[route.name] ?? 'AC2'} showActions={route.name === 'chat'} />
              <BackupMnemonicBanner />
            </View>
          ),
        })}
      >
        <Tabs.Screen name="chat" />
        <Tabs.Screen name="wallet" />
        <Tabs.Screen name="credentials" />
        <Tabs.Screen name="menu" />
      </Tabs>
    </ThemedCopilotProvider>
  );
}
