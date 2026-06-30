import { IconButton } from '@/components/ui/IconButton';
import { Text } from '@/components/ui/text';
import { toggleDrawer } from '@/stores/ui';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { CopilotStep, walkthroughable } from 'react-native-copilot';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const WalkthroughableView = walkthroughable(View);

const PASSKEY_TEXT =
  Platform.OS === 'ios'
    ? `Enabling Passkey Autofill on iOS\n\n1. Open Settings.\n2. Tap General.\n3. Select Autofill & Passwords.\n4. Turn on Autofill Passwords and Passkeys.\n5. Under Allow Filling From, enable AC2 Wallet`
    : `Enabling Passkey Autofill on Android\n\n1. Open Settings.\n2. Tap Passwords, passkeys & autofill (or search for Password Manager if you don't see it).\n3. Select AC2 Wallet as your preferred passkey provider.\n4. Make sure Offer to save passwords and passkeys is enabled.\n5. If prompted, set AC2 Wallet as the default autofill service.`;

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
      {showActions ? (
        <View style={{ position: 'absolute', top: insets.top, left: 24 }}>
          <CopilotStep name="passkey-setup" order={0} text={PASSKEY_TEXT}>
            <WalkthroughableView style={{ width: 1, height: 1 }} />
          </CopilotStep>
          <CopilotStep
            name="openclaw-setup"
            order={2}
            text="To use this app you'll need an OpenClaw instance with the AC2 OpenClaw plugin installed and configured. You can find a link to the plugin's GitHub repo on the Menu tab, under Integrations."
          >
            <WalkthroughableView style={{ width: 1, height: 1 }} />
          </CopilotStep>
        </View>
      ) : null}
      <View className="h-14 flex-row items-center justify-between">
        <View className="w-[100]">
          {showActions ? (
            <CopilotStep
              name="view-chats"
              order={1}
              text="View your current and historical chats by pressing this menu icon."
            >
              <WalkthroughableView style={{ alignSelf: 'flex-start' }}>
                <IconButton name="menu" accessibilityLabel="Open chats" onPress={toggleDrawer} />
              </WalkthroughableView>
            </CopilotStep>
          ) : null}
        </View>
        <View className="grow items-center justify-center">
          <Text className="text-base font-semibold text-foreground">{title}</Text>
        </View>
        <View className="w-[100] flex-row">
          {showActions ? (
            <>
              <CopilotStep
                name="scan-qr"
                order={3}
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
                order={4}
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
                order={5}
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
