import { ThemedCopilotProvider } from '@/components/CopilotUI';
import { AppHeader } from '@/components/navigation/AppHeader';
import { TabBar } from '@/components/navigation/TabBar';
import { useGettingStartedGuide } from '@/hooks/useGettingStartedGuide';
import { Tabs } from 'expo-router';
import * as React from 'react';
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

  React.useEffect(() => {
    if (!shouldShowGuide) return;
    // Delay slightly so all CopilotStep components finish registering.
    const timer = setTimeout(() => {
      void start();
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
            <AppHeader title={TITLES[route.name] ?? 'AC2'} showActions={route.name === 'chat'} />
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
