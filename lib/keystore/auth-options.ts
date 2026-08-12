import type { ReactKeystoreOptions } from '@algorandfoundation/react-native-keystore';

export const biometricOptions: ReactKeystoreOptions['keystore']['authentication'] = {
  biometrics: true,
  prompt: 'Authenticate to access your wallet',
  // The keystore no longer caches the unlocked master key in JS, so without a
  // reuse window every material-touching call (bootstrap, then each sign)
  // prompts again. 30s is long enough to cover a bootstrap + a signing flow and
  // is enforced by the OS, not by us. Requires the bundled
  // `patches/react-native-keychain+10.0.0.patch`; on Android the value is baked
  // into the Keychain item when it is created, so an already-installed app
  // keeps its previous window until that item is recreated.
  authenticationValidityDuration: 30,
};
