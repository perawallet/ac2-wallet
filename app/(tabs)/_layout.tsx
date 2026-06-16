import { Tabs } from 'expo-router';
import { TabBar } from '@/components/navigation/TabBar';
import { AppHeader } from '@/components/navigation/AppHeader';

const TITLES: Record<string, string> = {
  chat: 'Chat',
  wallet: 'Wallet',
  audit: 'Audit',
  menu: 'Menu',
};

export default function TabsLayout() {
  return (
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
      <Tabs.Screen name="audit" />
      <Tabs.Screen name="menu" />
    </Tabs>
  );
}
