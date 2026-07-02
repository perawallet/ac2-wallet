import type { ReactKeystoreOptions } from '@algorandfoundation/react-native-keystore';

export const biometricOptions: ReactKeystoreOptions['keystore']['authentication'] = {
  biometrics: true,
  prompt: 'Authenticate to access your wallet',
};
