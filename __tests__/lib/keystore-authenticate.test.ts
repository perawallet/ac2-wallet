jest.mock('expo-local-authentication', () => ({
  authenticateAsync: jest.fn(),
}));

import { authenticateToViewRecoveryPhrase } from '@/lib/keystore/authenticate';
import * as LocalAuthentication from 'expo-local-authentication';

const mockAuthenticateAsync = jest.mocked(LocalAuthentication.authenticateAsync);

describe('authenticateToViewRecoveryPhrase', () => {
  beforeEach(() => {
    mockAuthenticateAsync.mockReset();
  });

  it('performs a fresh biometric-only challenge', async () => {
    mockAuthenticateAsync.mockResolvedValue({ success: true });

    await expect(authenticateToViewRecoveryPhrase()).resolves.toBe(true);
    expect(mockAuthenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Authenticate to view your recovery phrase',
      promptDescription: 'Confirm your identity before revealing these words.',
      cancelLabel: 'Cancel',
      disableDeviceFallback: true,
      fallbackLabel: '',
      biometricsSecurityLevel: 'strong',
    });
  });

  it('fails closed when authentication is unavailable or cancelled', async () => {
    mockAuthenticateAsync
      .mockResolvedValueOnce({ success: false, error: 'user_cancel' })
      .mockRejectedValueOnce(new Error('unavailable'));

    await expect(authenticateToViewRecoveryPhrase()).resolves.toBe(false);
    await expect(authenticateToViewRecoveryPhrase()).resolves.toBe(false);
  });
});
