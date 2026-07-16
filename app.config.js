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
const cameraUsageDescription = 'AC2 uses the camera to scan QR codes to pair with AI agents.';

// Sentry is restricted to internal testing artifacts: nightly CI builds and
// manual/internal-TestFlight APK-style builds — never store release builds,
// and never local dev/simulator/emulator debug builds. Opt-in only: it's OFF
// unless SENTRY_ENABLED=true is explicitly set (Bitrise's ios_nightly/android
// workflows and the EAS `testing` profile set it; ios_release/android_play,
// local `expo start`, and Xcode/Android Studio debug runs never do, so they
// stay off by default). This flag gates BOTH the build-time Sentry Expo plugin
// (source-map upload) below and the runtime Sentry.init() in app/_layout.tsx
// (read via Constants.expoConfig.extra.sentryEnabled).
const sentryEnabled = process.env.SENTRY_ENABLED === 'true';
if (sentryEnabled && !process.env.SENTRY_AUTH_TOKEN) {
  throw new Error('SENTRY_ENABLED=true but SENTRY_AUTH_TOKEN is not set (needed for Sentry sourcemap upload).');
}

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
        // AES-256-GCM keystore encryption (@algorandfoundation/react-native-keystore) — all
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
        NSCameraUsageDescription: cameraUsageDescription,
      },
      associatedDomains: ['webcredentials:debug.liquidauth.com'],
      entitlements: {
        'com.apple.developer.authentication-services.autofill-credential-provider': true,
      },
    },
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash-logo.png',
      resizeMode: 'contain',
      backgroundColor: '#5858F0',
      imageWidth: 180,
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#5858F0',
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
          image: './assets/splash-logo.png',
          resizeMode: 'contain',
          backgroundColor: '#5858F0',
          imageWidth: 180,
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission: cameraUsageDescription,
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
          label: 'AC2 Wallet',
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
      // Sentry's source-map upload runs during the native build (sentry-cli,
      // needs $SENTRY_AUTH_TOKEN). Only include it for internal testing builds
      // so release builds neither upload maps nor require the token. Gated by
      // the same SENTRY_ENABLED switch that controls runtime Sentry.init().
      ...(sentryEnabled
        ? [
            [
              '@sentry/react-native/expo',
              {
                url: 'https://sentry.io/',
                project: 'ac2-wallet',
                organization: 'algorand-foundation',
              },
            ],
          ]
        : []),
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      // Runtime Sentry switch, read by app/_layout.tsx to decide whether to
      // call Sentry.init(). Baked in at build time from the SENTRY_ENABLED gate.
      sentryEnabled,
      termsOfServiceUrl:
        process.env.TERMS_OF_SERVICE_URL || 'https://ac2protocol.org/terms-of-service/',
      privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || 'https://perawallet.app/privacy-policy/',
      ac2OpenClawPluginUrl:
        process.env.AC2OPEN_CLAW_PLUGIN_URL ||
        'https://github.com/algorandfoundation/ac2/tree/master/packages/ac2-open-claw-reference',
      provider: {
        name: 'AC2 Wallet',
        primaryColor: '#5858F0',
        secondaryColor: '#EEEEFE',
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
