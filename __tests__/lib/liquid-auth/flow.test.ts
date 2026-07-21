// `flow.ts` pulls in native/keystore modules at load time, so they are mocked
// here to keep the pure helper under test free of the native bridge.
jest.mock('@/lib/keystore/auth-options', () => ({ biometricOptions: {} }));
jest.mock('@/lib/keystore/bootstrap', () => ({ bootstrap: jest.fn() }));
jest.mock('@/lib/keystore/wallet-account', () => ({ isWalletAccountKey: jest.fn() }));
jest.mock('@/lib/liquid-auth/helpers', () => ({
  credentialIdCandidates: jest.fn(() => new Set()),
  credentialIdsFromSessionData: jest.fn(() => new Set()),
  keyMatchesCredential: jest.fn(),
  normalizeCredentialId: (value: string) => value,
  originMatches: jest.fn(),
  passkeyFromKey: jest.fn(),
  passkeyMatchesConnection: jest.fn(),
  passkeysFromSessionUser: jest.fn(() => []),
  persistKeyMetadata: jest.fn(),
}));
jest.mock('@/stores/keystore', () => ({ keyStore: { state: { keys: [] } } }));
jest.mock('@/stores/sessions', () => ({ updateSessionPasskeyCredentialId: jest.fn() }));
jest.mock('@/utils/algorand', () => ({ decodeAddress: jest.fn() }));
jest.mock('@algorandfoundation/keystore', () => ({ encodeAddress: jest.fn() }));
jest.mock('@algorandfoundation/liquid-client', () => ({
  assertion: { encoder: {} },
  encoding: {},
}));
jest.mock('@algorandfoundation/react-native-keystore', () => ({
  fetchSecret: jest.fn(),
  readMasterKey: jest.fn(),
}));
jest.mock('@algorandfoundation/react-native-passkey-autofill', () => ({
  __esModule: true,
  default: { getStoredCredentials: jest.fn(() => Promise.resolve([])) },
}));

import { isRecoverableAssertionFailure } from '@/lib/liquid-auth/flow';

describe('isRecoverableAssertionFailure', () => {
  it('treats a native "cannot be validated" failure as recoverable', () => {
    expect(
      isRecoverableAssertionFailure({
        error: 'Native error',
        message: 'Error: The incoming request cannot be validated',
      }),
    ).toBe(true);
  });

  it('treats missing/unknown-shape errors as recoverable', () => {
    expect(isRecoverableAssertionFailure(new Error('boom'))).toBe(true);
    expect(isRecoverableAssertionFailure(null)).toBe(true);
    expect(isRecoverableAssertionFailure(undefined)).toBe(true);
    expect(isRecoverableAssertionFailure({})).toBe(true);
  });

  it('does not recover from user-driven aborts', () => {
    expect(isRecoverableAssertionFailure({ error: 'UserCancelled' })).toBe(false);
    expect(isRecoverableAssertionFailure({ error: 'TimedOut' })).toBe(false);
    expect(isRecoverableAssertionFailure({ error: 'Interrupted' })).toBe(false);
  });
});
