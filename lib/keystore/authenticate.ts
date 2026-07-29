import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Performs a fresh, biometric-only native challenge before revealing the
 * recovery phrase. This is deliberately independent of the keystore's
 * short-lived master-key cache and also protects wallets created before the
 * master-key item was stored with biometric access control.
 */
export async function authenticateToViewRecoveryPhrase(): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Authenticate to view your recovery phrase',
      promptDescription: 'Confirm your identity before revealing these words.',
      cancelLabel: 'Cancel',
      disableDeviceFallback: true,
      fallbackLabel: '',
      biometricsSecurityLevel: 'strong',
    });

    return result.success;
  } catch {
    // Cancellation and native authentication errors both fail closed.
    return false;
  }
}
