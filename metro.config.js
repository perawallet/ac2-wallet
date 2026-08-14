const path = require('path');
const { withNativeWind } = require('nativewind/metro');
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

// `react-native-liquid-auth` is vendored as an Expo local module under
// `modules/` (see modules/react-native-liquid-auth/VENDORED.md), which is NOT on
// the node resolution path. Alias the bare specifier to the vendored `src` so
// every existing `require('react-native-liquid-auth')` / import resolves
// unchanged and Metro bundles the module's TypeScript directly (no build step).
// When the package is published, delete this alias and add a scoped dependency.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'react-native-liquid-auth': path.resolve(__dirname, 'modules/react-native-liquid-auth/src'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'crypto' || moduleName === 'node:crypto') {
    // when importing crypto, resolve to react-native-quick-crypto
    return context.resolveRequest(context, 'react-native-quick-crypto', platform);
  }

  if (moduleName === 'falcon-1024') {
    // `falcon-1024` is the WASM Falcon binding behind keystore-core's lazy
    // `import('falcon-1024')` default — an *optional* peer that pnpm
    // auto-installs, which makes Metro bundle its ESM build whose
    // `import.meta.url` is a syntax error under Hermes. React Native uses the
    // native `@joe-p/react-native-falcon` binding instead, so resolve the WASM
    // module to an empty stub; keystore-core treats the empty module like a
    // missing library and leaves the Falcon shim out of the default stack.
    return { type: 'empty' };
  }

  // otherwise chain to the standard Metro resolver.
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
