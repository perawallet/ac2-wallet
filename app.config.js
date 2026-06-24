const { version } = require('./package.json');

const ENV = process.env.APP_ENV || 'debug';

// Per-env suffix shared by both platforms; production gets none.
const getEnvSuffix = () => {
  switch (ENV) {
    case 'development':
      return '.dev';
    case 'testing':
      return '.test';
    case 'staging':
      return '.staging';
    case 'production':
      return '';
    case 'debug':
    default:
      return '.debug';
  }
};

// iOS lives on the App Store account that owns `app.perawallet.ac2-wallet`;
// Android stays on `app.perawallet.ac2`. Keep them as separate bases.
const getIosBundleIdentifier = () => `app.perawallet.ac2-wallet${getEnvSuffix()}`;
const getAndroidPackage = () => `app.perawallet.ac2${getEnvSuffix()}`;

const getAppName = () => {
  switch (ENV) {
    case 'development':
      return 'AC2 Dev';
    case 'testing':
      return 'AC2 Test';
    case 'staging':
      return 'AC2 Staging';
    case 'production':
      return 'AC2';
    case 'debug':
    default:
      return 'AC2 Debug';
  }
};

module.exports = {
  expo: {
    name: getAppName(),
    slug: 'ac2',
    version: version,
    orientation: 'portrait',
    scheme: 'ac2',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: getIosBundleIdentifier(),
    },
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#ffffff',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: getAndroidPackage(),
      allowBackup: false,
    },
    web: {
      output: 'static',
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        {
          image: './assets/images/splash-icon.png',
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#ffffff',
          dark: {
            backgroundColor: '#000000',
          },
        },
      ],
      [
        'expo-build-properties',
        {
          android: {
            compileSdkVersion: 35,
            gradleProperties: {
              'org.gradle.jvmargs':
                '-Xmx6144m -XX:MaxMetaspaceSize=1g -XX:+UseG1GC -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8',
            },
          },
        },
      ],
      '@config-plugins/react-native-webrtc',
      [
        '@algorandfoundation/react-native-passkey-autofill',
        {
          site: 'https://debug.liquidauth.com',
          label: 'AC2-Controller',
          // Override the plugin default (group.<bundleId>.passkey-autofill) to
          // match the App Group registered under the new account.
          appGroup: 'group.app.perawallet.ac2-wallet',
        },
      ],
      // Bundled local workarounds for the autofill plugin's WIP iOS/Android
      // output (Android DP256 Maven repo, iOS unquoted DEVELOPMENT_TEAM, iOS
      // missing extension target dependency + duplicate Sources). MUST run
      // after the autofill plugin. Remove once the fixes land upstream.
      './plugins/withPasskeyAutofillFixes',
      // Wires android/app/build.gradle release builds to a release keystore
      // (decoded by CI from $ANDROID_KEYSTORE_BASE64). Falls back to debug
      // signing locally when $ANDROID_KEYSTORE_PASSWORD is absent. prebuild
      // regenerates build.gradle each run, so this re-applies every time.
      './plugins/withAndroidReleaseSigning',
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      termsOfServiceUrl:
        process.env.TERMS_OF_SERVICE_URL || 'https://perawallet.app/ac2-terms-of-services/',
      privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || 'https://perawallet.app/privacy-policy/',
      provider: {
        name: 'AC2-Controller',
        primaryColor: '#3B82F6',
        secondaryColor: '#E1EFFF',
        accentColor: '#10B981',
        welcomeMessage: 'Your identity, connected.',
        logo: '',
        showAccounts: true,
        showPasskeys: true,
        showIdentities: true,
        showConnections: true,
      },
      router: {},
      eas: {
        projectId: '1e66ec3b-f687-4617-a003-8491937c55c2',
      },
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      url: 'https://u.expo.dev/f1e6cb1b-642d-49fa-b276-53b4403f62d6',
    },
  },
};
