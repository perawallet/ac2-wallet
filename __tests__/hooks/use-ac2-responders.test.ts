const mockGenerate = jest.fn();
const mockExport = jest.fn();
const mockSign = jest.fn();
const mockRecordAgentIdentity = jest.fn();
const mockSendAc2 = jest.fn();
const mockBuildApprovedKey = jest.fn();

jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    key: { store: { generate: mockGenerate, export: mockExport, sign: mockSign } },
  }),
}));
jest.mock('@/stores/agentIdentities', () => ({
  recordAgentIdentity: (...args: unknown[]) => mockRecordAgentIdentity(...args),
}));
jest.mock('@/stores/keystore', () => ({ keyStore: { state: { keys: [] } } }));
jest.mock('@/lib/ac2/did', () => ({
  didKeyFromPublicKey: (publicKey: Uint8Array) => `did:key:agent-${publicKey[0]}`,
  didKeyFromAddress: (address: string) => `did:key:controller-${address}`,
}));
// `lib/ac2/responders` imports the `ac2-sdk/protocol` subpath, which this
// repo's Jest moduleNameMapper cannot resolve — so the builders are mocked and
// the test asserts the material handed to them instead of the built envelope.
jest.mock('@/lib/ac2/responders', () => ({
  buildApprovedKey: (...args: unknown[]) => mockBuildApprovedKey(...args),
  buildRejectedKey: jest.fn(),
  buildApprovedSigning: jest.fn(),
  buildRejectedSigning: jest.fn(),
}));
jest.mock('@/utils/algorand', () => ({ decodeAddress: jest.fn() }));

import { renderHook } from '@testing-library/react-native';
import { Alert } from 'react-native';

const ADDRESS = 'WALLETADDRESS';

/** The smallest `ac2/KeyRequest` shape the responders touch. */
const request = { body: { key_type: 'ed25519' } } as never;

function buildResponders() {
  const { useAc2Responders } = require('@/hooks/useAc2Responders');
  const { result } = renderHook(() =>
    useAc2Responders({
      address: ADDRESS,
      sendAc2: mockSendAc2,
      origin: 'https://agent.example',
      requestId: 'req-1',
    }),
  );
  return result;
}

describe('useAc2Responders approveKey', () => {
  const publicKey = new Uint8Array(32).fill(7);
  const privateKey = new Uint8Array(32).fill(9);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerate.mockResolvedValue('identity-key-id');
    mockBuildApprovedKey.mockReturnValue({ kind: 'approved-key-envelope' });
  });

  it('mints the identity as ONE extractable keystore key and exports its material', async () => {
    mockExport.mockResolvedValue({ publicKey, privateKey });

    await buildResponders().current.approveKey(request);

    // A single extractable Ed25519 generate — no detached seed record (its
    // `parentKeyId` was never honoured), and no key material minted outside
    // the keystore. `export` releases the material only because the key was
    // generated `extractable: true`.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ed25519',
        algorithm: 'EdDSA',
        extractable: true,
        keyUsages: ['sign', 'verify'],
      }),
    );
    expect(mockExport).toHaveBeenCalledWith('identity-key-id');

    // The exported material — and nothing else — is what the agent receives.
    expect(mockBuildApprovedKey).toHaveBeenCalledWith({
      request,
      controllerAddress: ADDRESS,
      publicKey,
      privateKey,
    });
    expect(mockSendAc2).toHaveBeenCalledWith({ kind: 'approved-key-envelope' });

    expect(mockRecordAgentIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'identity-key-id',
        publicKey: Buffer.from(publicKey).toString('base64'),
        agentDid: `did:key:agent-${publicKey[0]}`,
        controllerDid: `did:key:controller-${ADDRESS}`,
        origin: 'https://agent.example',
        requestId: 'req-1',
      }),
    );
  });

  it('fails the grant loudly when the keystore releases no private material', async () => {
    // The regression: a key that is not extractable exports metadata only, so
    // the grant must stop instead of handing the agent an empty key.
    mockExport.mockResolvedValue({ publicKey, privateKey: undefined });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await buildResponders().current.approveKey(request);

    expect(mockBuildApprovedKey).not.toHaveBeenCalled();
    expect(mockSendAc2).not.toHaveBeenCalled();
    expect(mockRecordAgentIdentity).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'Identity grant failed',
      expect.stringMatching(/export/i),
    );

    alertSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
