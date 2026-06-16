import { renderHook } from '@testing-library/react-native';

const mockClear = jest.fn().mockResolvedValue(undefined);
const mockGenerate = jest.fn().mockResolvedValue('id');
const mockImportFn = jest.fn().mockResolvedValue('seed');
const mockSetGenericPassword = jest.fn().mockResolvedValue(true);

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
}));

import { useWalletSetup } from '@/hooks/useWalletSetup';

describe('useWalletSetup.importWallet', () => {
  beforeEach(() => {
    mockClear.mockClear();
    mockImportFn.mockClear();
  });

  it('rejects an invalid mnemonic before touching the stores', async () => {
    const { result } = renderHook(() => useWalletSetup());
    await expect(result.current.importWallet('not a real phrase')).rejects.toThrow(
      /Invalid recovery phrase/,
    );
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockImportFn).not.toHaveBeenCalled();
  });
});
