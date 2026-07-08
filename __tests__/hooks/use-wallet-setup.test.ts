const mockClear = jest.fn().mockResolvedValue(undefined);
const mockGenerate = jest.fn().mockResolvedValue('id');
const mockImportFn = jest.fn().mockResolvedValue('seed');
const mockSetGenericPassword = jest.fn().mockResolvedValue(true);
const mockLocalStorageSet = jest.fn();

jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    key: { store: { clear: mockClear, import: mockImportFn, generate: mockGenerate } },
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
    mockImportFn.mockClear();
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
