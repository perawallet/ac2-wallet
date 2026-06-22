// MUST be first: installs `global.crypto` before any `@noble/hashes` import
// is evaluated. See `lib/runtime/install-crypto.ts`.
import '@/lib/runtime/install-crypto';
// Installs `global.Buffer` before any algokit-utils module (which uses a bare
// global `Buffer`) is evaluated.
import '@/lib/runtime/install-buffer';
import { Drawer } from '@/components/navigation/Drawer';
import '@/global.css';
import { bootstrap } from '@/lib/keystore/bootstrap';
import { globalPolyfill, setupNavigatorPolyfill } from '@/lib/runtime/polyfill';
import { NAV_THEME } from '@/lib/theme';
import { PreventScreenshotProvider } from '@/providers/PreventScreenshotProvider';
import { ReactNativeProvider, WalletProvider } from '@/providers/ReactNativeProvider';
import { accountsStore } from '@/stores/accounts';
import { keyStoreHooks } from '@/stores/before-after';
import { identitiesStore } from '@/stores/identities';
import { keyStore } from '@/stores/keystore';
import { passkeysStore } from '@/stores/passkeys';
import { ReactKeystoreOptions } from '@algorandfoundation/react-native-keystore';
import ReactNativePasskeyAutofill from '@algorandfoundation/react-native-passkey-autofill';
import { MaterialIcons } from '@expo/vector-icons';
import { ThemeProvider } from '@react-navigation/native';
import { useEventListener } from 'expo';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import React from 'react';
import { registerGlobals } from 'react-native-webrtc';

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

// Create a context to track font loading status
const FontLoadingContext = React.createContext<{ fontsLoaded: boolean }>({ fontsLoaded: false });

export function useFontsLoaded() {
  const context = React.useContext(FontLoadingContext);
  return context.fontsLoaded;
}

export default function RootLayout() {
  const { colorScheme } = useColorScheme();
  const [fontsLoaded] = useFonts({
    ...MaterialIcons.font,
  });

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
    <FontLoadingContext.Provider value={{ fontsLoaded }}>
      <PreventScreenshotProvider>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
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
    </FontLoadingContext.Provider>
  );
}
