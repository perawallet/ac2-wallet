const mockClear = jest.fn().mockResolvedValue(undefined);
const mockGenerate = jest.fn().mockResolvedValue('id');
const mockImportFn = jest.fn().mockResolvedValue('seed');
const mockSetGenericPassword = jest.fn().mockResolvedValue(true);
const mockLocalStorageSet = jest.fn();
const mockClearSessions = jest.fn().mockResolvedValue(undefined);
const mockClearMessages = jest.fn();
const mockClearAc2Messages = jest.fn();
const mockClearAgentIdentities = jest.fn();
const mockClearCurrentConnection = jest.fn();

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
jest.mock('@/stores/sessions', () => ({ clearSessions: mockClearSessions }));
jest.mock('@/stores/messages', () => ({ clearAllMessages: mockClearMessages }));
jest.mock('@/stores/ac2Messages', () => ({ clearAllAc2Messages: mockClearAc2Messages }));
jest.mock('@/stores/agentIdentities', () => ({
  clearAllAgentIdentities: mockClearAgentIdentities,
}));
jest.mock('@/stores/ui', () => ({ clearCurrentConnection: mockClearCurrentConnection }));

import { renderHook } from '@testing-library/react-native';

describe('useWalletSetup', () => {
  const { useWalletSetup } = require('@/hooks/useWalletSetup');

  beforeEach(() => {
    mockClear.mockClear();
    mockImportFn.mockClear();
    mockSetGenericPassword.mockClear();
    mockLocalStorageSet.mockClear();
    mockClearSessions.mockClear();
    mockClearMessages.mockClear();
    mockClearAc2Messages.mockClear();
    mockClearAgentIdentities.mockClear();
    mockClearCurrentConnection.mockClear();
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
    expect(mockClearCurrentConnection).toHaveBeenCalledTimes(1);
    expect(mockClearSessions).toHaveBeenCalledTimes(1);
    expect(mockClearMessages).toHaveBeenCalledTimes(1);
    expect(mockClearAc2Messages).toHaveBeenCalledTimes(1);
    expect(mockClearAgentIdentities).toHaveBeenCalledTimes(1);
  });
});
