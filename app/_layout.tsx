// The crypto/buffer polyfills are installed by the custom entry point
// (`index.js`) before any route module is evaluated. See that file for why.
import { LoadingScreen } from '@/components/LoadingScreen';
import { Drawer } from '@/components/navigation/Drawer';
import '@/global.css';
import { biometricOptions } from '@/lib/keystore/auth-options';
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
import ReactNativePasskeyAutofill from '@algorandfoundation/react-native-passkey-autofill';
import { MaterialIcons } from '@expo/vector-icons';
import { ThemeProvider } from '@react-navigation/native';
import { useStore } from '@tanstack/react-store';
import { useEventListener } from 'expo';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'nativewind';
import React from 'react';
import { registerGlobals } from 'react-native-webrtc';
import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: 'https://c84ccad1ce82242356b438236144cd40@o4506796769148928.ingest.us.sentry.io/4511739770699776',

  // Adds more context data to events (IP address, cookies, user, etc.)
  // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
  sendDefaultPii: true,

  // Enable Logs
  enableLogs: true,

  // Configure Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,
  integrations: [Sentry.mobileReplayIntegration(), Sentry.feedbackIntegration()],

  // uncomment the line below to enable Spotlight (https://spotlightjs.com)
  // spotlight: __DEV__,
});

globalPolyfill();
registerGlobals();

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

/**
 * Single gate for the whole app: until fonts have loaded and the keystore has
 * finished its first bootstrap (`status !== 'loading'`), render the loading
 * screen instead of the navigation tree. This guarantees no authenticated
 * screen (wallet / credentials / menu / chat) mounts before its data is
 * available on initial launch.
 *
 * The gate only blocks the *first* load. Later re-bootstraps (e.g. passkey
 * autofill events) briefly flip status back to 'loading' to refresh keys in
 * the background; tearing the navigation tree down there would bounce the user
 * out of whatever screen they're on, so once we've loaded once we stay mounted.
 */
function RootNavigation({ fontsLoaded }: { fontsLoaded: boolean }) {
  const status = useStore(keyStore, (state) => state.status);
  const [hasLoadedOnce, setHasLoadedOnce] = React.useState(false);

  const ready = fontsLoaded && status !== 'loading';
  React.useEffect(() => {
    if (ready) setHasLoadedOnce(true);
  }, [ready]);

  if (!hasLoadedOnce) {
    return <LoadingScreen fontsLoaded={fontsLoaded} />;
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="scan" options={{ presentation: 'modal' }} />
        <Stack.Screen name="history" options={{ presentation: 'modal' }} />
        <Stack.Screen name="profile" options={{ presentation: 'modal' }} />
      </Stack>
      <Drawer />
    </>
  );
}

export default Sentry.wrap(function RootLayout() {
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
            <RootNavigation fontsLoaded={fontsLoaded} />
          </ThemeProvider>
        </WalletProvider>
      </PreventScreenshotProvider>
    </FontLoadingContext.Provider>
  );
});
