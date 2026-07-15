jest.mock('@/lib/liquid-auth/helpers', () => ({
  credentialIdsFromSessionData: () => [],
  normalizeCredentialId: (value: string) => value,
  passkeyFromKey: () => null,
  passkeyMatchesConnection: () => false,
  passkeysFromSessionUser: () => [],
}));

jest.mock('@/lib/liquid-auth/pairing-credentials', () => ({
  parsePairingCredential: () => null,
  persistPairingCredential: jest.fn(),
}));

jest.mock('@/stores/sessions', () => ({
  updateSessionPairing: jest.fn(),
  updateSessionPasskeyCredentialId: jest.fn(),
}));

jest.mock('@/utils/algorand', () => ({
  decodeAddress: () => ({ publicKey: new Uint8Array([1, 2, 3]) }),
}));

jest.mock('@algorandfoundation/keystore', () => ({
  encodeAddress: () => 'WALLET_ADDRESS',
}));

jest.mock('@algorandfoundation/liquid-client', () => ({
  assertion: {
    encoder: {
      decodeOptions: jest.fn(() => ({})),
      encodeCredential: jest.fn(() => ({ type: 'public-key' })),
    },
  },
  encoding: {
    fromBase64Url: jest.fn(() => new Uint8Array([1, 2, 3])),
    toBase64URL: jest.fn(() => 'encoded'),
  },
}));

jest.mock('@algorandfoundation/react-native-passkey-autofill', () => ({
  __esModule: true,
  default: { getStoredCredentials: jest.fn(() => Promise.resolve([])) },
}));

import { authenticateLiquidAuth, bytesFromBufferSource } from '@/lib/liquid-auth/flow';

function response(ok: boolean, body: unknown = {}): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? 'OK' : 'Not Found',
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function params(fetchWithTimeout: jest.Mock, onPasskeyCreated?: () => void) {
  const abortController = new AbortController();
  return {
    origin: 'https://agent.example',
    requestId: 'request-123',
    foundKey: { id: 'wallet-key', publicKey: new Uint8Array([1, 2, 3]) } as any,
    walletAddress: 'WALLET_ADDRESS',
    currentKeys: [],
    initialSessionData: null,
    initialSessionAddress: null,
    allowPasskeyCreation: true,
    key: { store: { sign: jest.fn().mockResolvedValue(new Uint8Array([4, 5, 6])) } } as any,
    passkey: { store: { getPasskeys: jest.fn().mockResolvedValue([]) } } as any,
    setAddress: jest.fn(),
    addressRef: { current: null },
    fetchWithTimeout,
    signal: abortController.signal,
    isActive: () => true,
    onPasskeyCreated,
  };
}

describe('bytesFromBufferSource', () => {
  it('accepts ArrayBuffer and preserves typed-array/DataView offsets', () => {
    expect([...bytesFromBufferSource(new Uint8Array([1, 2, 3]).buffer)]).toEqual([1, 2, 3]);

    const backing = new Uint8Array([9, 4, 5, 8]);
    expect([...bytesFromBufferSource(backing.subarray(1, 3))]).toEqual([4, 5]);
    expect([...bytesFromBufferSource(new DataView(backing.buffer, 1, 2))]).toEqual([4, 5]);
  });
});

describe('authenticateLiquidAuth', () => {
  const credential = {
    id: 'new-passkey',
    rawId: new Uint8Array([1]).buffer,
    type: 'public-key',
    response: {
      clientDataJSON: new Uint8Array([2]).buffer,
      attestationObject: new Uint8Array([3]).buffer,
      clientExtensionResults: {},
    },
    getClientExtensionResults: () => ({}),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        credentials: {
          create: jest.fn().mockResolvedValue(credential),
          get: jest.fn(),
        },
      },
    });
  });

  it('consumes creation permission immediately after native credential creation', async () => {
    const fetchWithTimeout = jest
      .fn()
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(
        response(true, {
          challenge: 'challenge',
          user: {},
          excludeCredentials: [],
        }),
      )
      .mockRejectedValueOnce(new Error('network unavailable'));
    const onPasskeyCreated = jest.fn();

    await expect(
      authenticateLiquidAuth(params(fetchWithTimeout, onPasskeyCreated)),
    ).rejects.toThrow('network unavailable');

    expect(onPasskeyCreated).toHaveBeenCalledTimes(1);
    expect(navigator.credentials.create).toHaveBeenCalledTimes(1);
  });

  it('binds requestId to assertion and does not request a second wallet signature', async () => {
    const assertionCredential = {
      id: 'existing-passkey',
      response: { userHandle: null },
    };
    (navigator.credentials.get as jest.Mock).mockResolvedValue(assertionCredential);
    const fetchWithTimeout = jest
      .fn()
      .mockResolvedValueOnce(response(true, { challenge: 'challenge' }))
      .mockResolvedValueOnce(response(true, {}));
    const authenticationParams = params(fetchWithTimeout);
    authenticationParams.allowPasskeyCreation = false;

    await authenticateLiquidAuth(authenticationParams);

    const assertionRequest = fetchWithTimeout.mock.calls[0];
    expect(JSON.parse(assertionRequest[1].body)).toEqual({
      userVerification: 'required',
      requestId: 'request-123',
    });
    expect(authenticationParams.key.store.sign).not.toHaveBeenCalled();

    const assertionResponse = fetchWithTimeout.mock.calls[1];
    const encodedBody = JSON.parse(assertionResponse[1].body);
    expect(encodedBody.clientExtensionResults.liquid).toEqual(
      expect.objectContaining({ requestId: 'request-123' }),
    );
    expect(encodedBody.clientExtensionResults.liquid).not.toHaveProperty('signature');
  });

  it('cancels a pending foreground assertion with the setup AbortSignal', async () => {
    let resolveCredential: ((credential: unknown) => void) | undefined;
    (navigator.credentials.get as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveCredential = resolve;
      }),
    );
    const fetchWithTimeout = jest
      .fn()
      .mockResolvedValue(response(true, { challenge: 'challenge' }));
    const authenticationParams = params(fetchWithTimeout);
    authenticationParams.allowPasskeyCreation = false;
    const abortController = new AbortController();
    authenticationParams.signal = abortController.signal;

    const authentication = authenticateLiquidAuth(authenticationParams);
    for (
      let turn = 0;
      turn < 10 && !(navigator.credentials.get as jest.Mock).mock.calls.length;
      turn += 1
    ) {
      await Promise.resolve();
    }
    expect(navigator.credentials.get).toHaveBeenCalled();
    abortController.abort();

    await expect(authentication).rejects.toMatchObject({ name: 'AbortError' });
    resolveCredential?.(null);
  });
});
