jest.mock('react-native-keychain', () => ({
  __esModule: true,
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));

import {
  loadPairingCredential,
  PairingCredentialUnavailableError,
  parsePairingCredential,
  persistPairingCredential,
  removePairingCredential,
} from '@/lib/liquid-auth/pairing-credentials';

const keychainMock = jest.requireMock('react-native-keychain') as {
  setGenericPassword: jest.Mock;
  getGenericPassword: jest.Mock;
  resetGenericPassword: jest.Mock;
};
const mockSetGenericPassword = keychainMock.setGenericPassword;
const mockGetGenericPassword = keychainMock.getGenericPassword;
const mockResetGenericPassword = keychainMock.resetGenericPassword;

const pairing = {
  version: 2 as const,
  pairingId: 'pairing-123',
  role: 'controller' as const,
  credential: 'opaque-secret',
};

describe('Liquid Auth durable pairing credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetGenericPassword.mockResolvedValue({ service: 'stored' });
  });

  it('validates the v2 controller credential shape', () => {
    expect(parsePairingCredential(pairing)).toEqual(pairing);
    expect(parsePairingCredential({ ...pairing, version: 1 })).toBeNull();
    expect(parsePairingCredential({ ...pairing, credential: { token: 'secret' } })).toBeNull();
    expect(parsePairingCredential({ ...pairing, credential: '  ' })).toBeNull();
  });

  it('stores the opaque credential in Keychain and returns only a non-secret reference', async () => {
    const reference = await persistPairingCredential(
      'https://agent.example',
      'request-123',
      pairing,
    );

    expect(reference).toEqual({
      version: 2,
      pairingId: 'pairing-123',
      role: 'controller',
      storage: 'keychain',
    });
    expect(JSON.stringify(reference)).not.toContain('opaque-secret');
    expect(mockSetGenericPassword).toHaveBeenCalledWith(
      'pairing-123',
      JSON.stringify(pairing),
      expect.objectContaining({ accessible: 'WhenUnlockedThisDeviceOnly' }),
    );
  });

  it('loads only the credential matching the persisted pairing reference', async () => {
    const reference = {
      version: 2 as const,
      pairingId: 'pairing-123',
      role: 'controller' as const,
      storage: 'keychain' as const,
    };
    mockGetGenericPassword.mockResolvedValue({
      username: 'pairing-123',
      password: JSON.stringify(pairing),
    });
    await expect(
      loadPairingCredential('https://agent.example', 'request-123', reference),
    ).resolves.toEqual(pairing);

    mockGetGenericPassword.mockResolvedValue({
      username: 'another-pairing',
      password: JSON.stringify({ ...pairing, pairingId: 'another-pairing' }),
    });
    await expect(
      loadPairingCredential('https://agent.example', 'request-123', reference),
    ).rejects.toBeInstanceOf(PairingCredentialUnavailableError);
  });

  it('does not fall back to WebAuthn when secure storage fails transiently', async () => {
    const reference = {
      version: 2 as const,
      pairingId: 'pairing-123',
      role: 'controller' as const,
      storage: 'keychain' as const,
    };
    mockGetGenericPassword.mockRejectedValue(new Error('Keychain temporarily unavailable'));

    await expect(
      loadPairingCredential('https://agent.example', 'request-123', reference),
    ).rejects.toMatchObject({
      name: 'PairingCredentialUnavailableError',
      code: 'PAIRING_CREDENTIAL_UNAVAILABLE',
    });
  });

  it('returns null only when Keychain explicitly reports no saved item', async () => {
    const reference = {
      version: 2 as const,
      pairingId: 'pairing-123',
      role: 'controller' as const,
      storage: 'keychain' as const,
    };
    mockGetGenericPassword.mockResolvedValue(false);

    await expect(
      loadPairingCredential('https://agent.example', 'request-123', reference),
    ).resolves.toBeNull();
  });

  it('removes the Keychain item when the pairing is forgotten', async () => {
    mockResetGenericPassword.mockResolvedValue(true);
    await removePairingCredential('https://agent.example', 'request-123');
    expect(mockResetGenericPassword).toHaveBeenCalledWith(
      expect.objectContaining({ service: expect.stringContaining('liquid-pairing') }),
    );
  });
});
