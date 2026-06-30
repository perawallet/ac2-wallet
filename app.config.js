const { version } = require('./package.json');

const ENV = process.env.APP_ENV || 'debug';

// iOS build number / Android versionCode, driven by the monotonic CI
// BUILD_NUMBER ($BITRISE_BUILD_NUMBER); falls back to 1 locally. Baking it here
// means `expo prebuild` writes it straight into the native projects (iOS
// CFBundleVersion, android/app/build.gradle versionCode), so the artifacts
// carry it directly — the `android.injected.*` Gradle property proved
// unreliable for the bundle task. Mirrors pera-rn's resolveBuildNumber (which
// also adds a committed versionCodeBase to floor above existing store builds —
// not needed here since AC2 is a fresh listing). The iOS Fastfile still runs
// agvtool to propagate this to the PasskeyAutofill extension target.
const buildNumber = process.env.BUILD_NUMBER ? Number(process.env.BUILD_NUMBER) : 1;

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
      supportsTablet: false,
      bundleIdentifier: getIosBundleIdentifier(),
      buildNumber: String(buildNumber),
      infoPlist: {
        // Declare export-compliance up front so TestFlight stops prompting for
        // "Missing Compliance" on every upload. The app's crypto is P256/ECDSA
        // signing + WebAuthn (auth, exempt), TLS/WebRTC transport (exempt), and
        // AES-256-GCM keystore encryption (lib/keystore/crypto.ts) — all
        // standard published algorithms in a mass-market app, claimed exempt
        // under EAR License Exception ENC. Revisit if non-standard/proprietary
        // confidentiality crypto is added.
        ITSAppUsesNonExemptEncryption: false,
        // react-native-keychain reads biometry-protected items on launch.
        // On a physical device SecItemCopyMatching routes through
        // LocalAuthentication/TCC, which hard-aborts the process (TCC 0) unless
        // this usage string is present. The Simulator has no TCC biometric
        // enforcement, which is why the crash only shows up on TestFlight.
        NSFaceIDUsageDescription:
          'AC2 uses Face ID to unlock your wallet and authorize sensitive actions.',
      },
      associatedDomains: ['webcredentials:debug.liquidauth.com'],
      entitlements: {
        'com.apple.developer.authentication-services.autofill-credential-provider': true,
      },
    },
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#0052FF',
      imageWidth: 578,
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0052FF',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: getAndroidPackage(),
      versionCode: buildNumber,
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
          image: './assets/splash.png',
          resizeMode: 'contain',
          backgroundColor: '#0052FF',
          imageWidth: 578,
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
          appleTeamId: 'KHH37325LN',
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
      // Strips READ_MEDIA_IMAGES / READ_EXTERNAL_STORAGE that expo-screen-capture
      // contributes for its (unused) screenshot-detection API. We only use
      // screenshot prevention (FLAG_SECURE), which needs no permission, and Play
      // flags READ_MEDIA_IMAGES as a sensitive photo/video permission.
      './plugins/withRemoveMediaPermissions',
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      termsOfServiceUrl:
        process.env.TERMS_OF_SERVICE_URL || 'https://ac2protocol.org/terms-of-service/',
      privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || 'https://perawallet.app/privacy-policy/',
      // TURN credentials for the Liquid Auth WebRTC relay, injected at build
      // time (e.g. Bitrise secrets). Nodely falls back to the previously-shipped
      // credential so local/dev builds keep working; metered.ca has no fallback
      // and is only added to the ICE list when both values are present.
      turn: {
        nodely: {
          username: process.env.NODELY_TURN_USERNAME || '',
          credential: process.env.NODELY_TURN_CREDENTIAL || '',
        },
        metered: {
          username: process.env.METERED_TURN_USERNAME || '',
          credential: process.env.METERED_TURN_CREDENTIAL || '',
        },
      },
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
