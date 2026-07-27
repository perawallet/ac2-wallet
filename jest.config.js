module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['@testing-library/jest-native/extend-expect', '<rootDir>/jest.setup.js'],
  testPathIgnorePatterns: [],
  transformIgnorePatterns: [
    'node_modules/(?!(\\.pnpm|((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|expo-router|@scure/.*|@noble/.*|react-native-reanimated|react-native-nitro-modules|@algorandfoundation/.*|before-after-hook|nativewind|react-native-css-interop|uuid))',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@algorandfoundation/(.*)$': '<rootDir>/node_modules/@algorandfoundation/$1',
    // `react-native-liquid-auth` is vendored as an Expo local module under
    // `modules/` and resolved at runtime via a Metro alias; mirror that here so
    // the specifier resolves in Jest too. (Harmless in practice — the hook is
    // factory-mocked and the transport takes an injected fake, so the real
    // module is never imported by the suite.)
    '^react-native-liquid-auth$': '<rootDir>/modules/react-native-liquid-auth/src',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
