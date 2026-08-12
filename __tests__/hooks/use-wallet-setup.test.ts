const mockClear = jest.fn().mockResolvedValue(undefined);
const mockGenerate = jest.fn().mockResolvedValue('root-id');
const mockImportFn = jest.fn().mockResolvedValue('seed');
const mockImportSeed = jest.fn().mockResolvedValue('seed');
const mockDeriveFromSeed = jest.fn().mockResolvedValue('derived-id');
const mockSetGenericPassword = jest.fn().mockResolvedValue(true);
const mockLocalStorageSet = jest.fn();

jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    key: {
      store: {
        clear: mockClear,
        import: mockImportFn,
        importSeed: mockImportSeed,
        generate: mockGenerate,
        deriveFromSeed: mockDeriveFromSeed,
      },
    },
    account: { store: { clear: mockClear } },
    identity: { store: { clear: mockClear } },
    passkey: { store: { clear: mockClear } },
  }),
}));
jest.mock('@/lib/keystore/bootstrap', () => ({
  bootstrap: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('react-native-keychain', () => ({
  setGenericPassword: mockSetGenericPassword,
  getGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));
jest.mock('@/stores/mmkv-local', () => ({
  localStorage: {
    set: mockLocalStorageSet,
  },
}));

import { renderHook } from '@testing-library/react-native';

describe('useWalletSetup', () => {
  const { useWalletSetup } = require('@/hooks/useWalletSetup');

  beforeEach(() => {
    mockClear.mockClear();
    mockGenerate.mockClear();
    mockImportFn.mockClear();
    mockImportSeed.mockClear();
    mockDeriveFromSeed.mockClear();
    mockSetGenericPassword.mockClear();
    mockLocalStorageSet.mockClear();
  });

  it('rejects an invalid mnemonic before touching the stores', async () => {
    const { result } = renderHook(() => useWalletSetup());
    await expect(result.current.importWallet('not a real phrase')).rejects.toThrow(
      /Invalid recovery phrase/,
    );
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockImportFn).not.toHaveBeenCalled();
    expect(mockImportSeed).not.toHaveBeenCalled();
  });

  it('imports the seed and derives the context keys instead of generating them', async () => {
    const { result } = renderHook(() => useWalletSetup());
    const { mnemonic } = await result.current.createWallet();
    expect(typeof mnemonic).toBe('string');

    // The seed goes through the keystore's own `importSeed` entry point, never
    // a typed `import` (whose deprecated `hd-seed` spelling broke wallet
    // creation), and account/identity keys come from `deriveFromSeed` —
    // `generate({ type: 'hd-derived-ed25519' })` now falls through to the host
    // WebCrypto and throws for EdDSA.
    expect(mockImportSeed).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(mockImportFn).not.toHaveBeenCalled();

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hd-root-key', params: { parentKeyId: 'seed' } }),
    );

    expect(mockDeriveFromSeed).toHaveBeenCalledTimes(2);
    expect(mockDeriveFromSeed).toHaveBeenNthCalledWith(
      1,
      'root-id',
      "m/44'/283'/0'/0/0",
      expect.objectContaining({
        algorithm: 'EdDSA',
        metadata: { context: 0, account: 0, index: 0, derivation: 9 },
      }),
    );
    expect(mockDeriveFromSeed).toHaveBeenNthCalledWith(
      2,
      'root-id',
      "m/44'/0'/0'/0/0",
      expect.objectContaining({
        algorithm: 'EdDSA',
        metadata: { context: 1, account: 0, index: 0, derivation: 9 },
      }),
    );
  });

  it('marks a newly imported mnemonic as needing backup', async () => {
    const { result } = renderHook(() => useWalletSetup());
    await result.current.importWallet(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
    );

    expect(mockSetGenericPassword).toHaveBeenCalledWith(
      'mnemonic',
      expect.any(String),
      expect.objectContaining({ service: 'app.perawallet.ac2.mnemonic' }),
    );
    expect(mockLocalStorageSet).toHaveBeenCalledWith('mnemonicBackedUp', false);
  });
});
