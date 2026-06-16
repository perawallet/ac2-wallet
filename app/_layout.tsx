// MUST be first: installs `global.crypto` before any `@noble/hashes` import
// is evaluated. See `lib/runtime/install-crypto.ts`.
import '@/lib/runtime/install-crypto';
import '@/global.css';
import { useEventListener } from 'expo';
import { Stack } from 'expo-router';
import { keyStore } from '@/stores/keystore';
import { keyStoreHooks } from '@/stores/before-after';
import { accountsStore } from '@/stores/accounts';
import { identitiesStore } from '@/stores/identities';
import { ReactNativeProvider, WalletProvider } from '@/providers/ReactNativeProvider';
import { passkeysStore } from '@/stores/passkeys';
import { registerGlobals } from 'react-native-webrtc';
import { globalPolyfill, setupNavigatorPolyfill } from '@/lib/runtime/polyfill';
import ReactNativePasskeyAutofill from '@algorandfoundation/react-native-passkey-autofill';
import { bootstrap } from '@/lib/keystore/bootstrap';
import { PreventScreenshotProvider } from '@/providers/PreventScreenshotProvider';
import React from 'react';
import { ReactKeystoreOptions } from '@algorandfoundation/react-native-keystore';
import { ThemeProvider } from '@react-navigation/native';
import { useColorScheme } from 'nativewind';
import { NAV_THEME } from '@/lib/theme';
import { Drawer } from '@/components/navigation/Drawer';

globalPolyfill();
registerGlobals();

const biometricOptions: ReactKeystoreOptions['keystore']['authentication'] = {
  biometrics: true,
  prompt: 'Authenticate to access your wallet',
};

const provider = new ReactNativeProvider(
  {
    id: 'react-native-wallet',
    name: 'React Native Wallet',
  },
  {
    logs: true,
    accounts: {
      store: accountsStore,
      keystore: {
        autoPopulate: true,
      },
    },
    identities: {
      store: identitiesStore,
      keystore: {
        autoPopulate: true,
      },
    },
    passkeys: {
      store: passkeysStore,
      keystore: {
        autoPopulate: true,
      },
    },
    keystore: {
      store: keyStore,
      hooks: keyStoreHooks,
      authentication: biometricOptions,
    },
  },
);

setupNavigatorPolyfill();

export default function RootLayout() {
  const { colorScheme } = useColorScheme();

  React.useEffect(() => {
    bootstrap(biometricOptions).catch((e) => console.error('Bootstrap promise error:', e));
  }, []);

  useEventListener(ReactNativePasskeyAutofill, 'onPasskeyAdded', (event) => {
    console.log('Passkey added via autofill:', event);
    if (event.success) {
      bootstrap(biometricOptions).catch((e) =>
        console.error('Failed to reload keys after passkey added:', e),
      );
    }
  });

  useEventListener(ReactNativePasskeyAutofill, 'onPasskeyAuthenticated', (event) => {
    console.log('Passkey authenticated via autofill:', event);
    if (event.success) {
      bootstrap(biometricOptions).catch((e) =>
        console.error('Failed to reload keys after passkey authenticated:', e),
      );
    }
  });

  return (
    <PreventScreenshotProvider>
      <WalletProvider provider={provider}>
        <ThemeProvider value={colorScheme === 'dark' ? NAV_THEME.dark : NAV_THEME.light}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="scan" options={{ presentation: 'modal' }} />
            <Stack.Screen name="history" options={{ presentation: 'modal' }} />
            <Stack.Screen name="profile" options={{ presentation: 'modal' }} />
          </Stack>
          <Drawer />
        </ThemeProvider>
      </WalletProvider>
    </PreventScreenshotProvider>
  );
}
