const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const config = getDefaultConfig(__dirname);
const localReactNativeKeystore = path.resolve(
  __dirname,
  '../../algorand/wallet-provider-extensions/keystore/react-native',
);

config.watchFolders = Array.from(
  new Set([...(config.watchFolders || []), localReactNativeKeystore]),
);
config.resolver.nodeModulesPaths = Array.from(
  new Set([
    path.resolve(__dirname, 'node_modules'),
    path.resolve(localReactNativeKeystore, 'node_modules'),
    ...(config.resolver.nodeModulesPaths || []),
  ]),
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@algorandfoundation/react-native-keystore') {
    return {
      type: 'sourceFile',
      filePath: path.join(localReactNativeKeystore, 'dist/index.js'),
    };
  }

  if (moduleName === 'crypto' || moduleName === 'node:crypto') {
    // when importing crypto, resolve to react-native-quick-crypto
    return context.resolveRequest(context, 'react-native-quick-crypto', platform);
  }

  // otherwise chain to the standard Metro resolver.
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
