import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/text';
import { toggleDrawer } from '@/stores/ui';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { CopilotStep, walkthroughable } from 'react-native-copilot';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const WalkthroughableView = walkthroughable(View);

interface AppHeaderProps {
  title?: string;
  // The menu and action icons are only relevant on the chat page; other pages
  // show just the centered title.
  showActions?: boolean;
}

function AppHeader({ title = 'Chat', showActions = false }: AppHeaderProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View className="border-b border-border bg-card px-2" style={{ paddingTop: insets.top }}>
      <View className="h-14 flex-row items-center justify-between">
        <View className="w-[100]">
          {showActions ? (
            <CopilotStep
              name="view-chats"
              order={0}
              text="View your current and historical chats by pressing this menu icon."
            >
              <WalkthroughableView>
                <IconButton name="menu" accessibilityLabel="Open chats" onPress={toggleDrawer} />
              </WalkthroughableView>
            </CopilotStep>
          ) : null}
        </View>
        <View className="grow items-center justify-center">
          {showActions ? (
            <CopilotStep
              name="openclaw-setup"
              order={1}
              text="To use this app you'll need an OpenClaw instance with the AC2 OpenClaw plugin installed and configured. You can find a link to the plugin's GitHub repo on the Menu tab, under Integrations."
            >
              <WalkthroughableView>
                <Text className="text-base font-semibold text-foreground">{title}</Text>
              </WalkthroughableView>
            </CopilotStep>
          ) : (
            <Text className="text-base font-semibold text-foreground">{title}</Text>
          )}
        </View>
        <View className="w-[100] flex-row">
          {showActions ? (
            <>
              <CopilotStep
                name="scan-qr"
                order={2}
                text="Tap the QR code button to scan an AC2 QR code and start a new chat with an agent."
              >
                <WalkthroughableView>
                  <IconButton
                    name="qr-code-scanner"
                    accessibilityLabel="Scan QR code"
                    onPress={() => router.push('/scan')}
                  />
                </WalkthroughableView>
              </CopilotStep>
              <CopilotStep
                name="history"
                order={3}
                text="History shows a full audit log of every AC2 message you've sent and received for the current chat. You can also export the history as a PDF or JSON file for your own records."
              >
                <WalkthroughableView>
                  <IconButton
                    name="history"
                    accessibilityLabel="History"
                    onPress={() => router.push('/history')}
                  />
                </WalkthroughableView>
              </CopilotStep>
              <CopilotStep
                name="agent-profile"
                order={4}
                text="Agent Profile shows the connected agent's DID, your controller DID, and other identity details."
              >
                <WalkthroughableView>
                  <IconButton
                    name="smart-toy"
                    accessibilityLabel="Agent profile"
                    onPress={() => router.push('/profile')}
                  />
                </WalkthroughableView>
              </CopilotStep>
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export { AppHeader };
