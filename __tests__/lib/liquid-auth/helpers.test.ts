// The presence-driven reconnect gate: these pure helpers decide whether an
// existing `/auth/session` already authenticates the wallet for a requestId so
// `useConnection` can skip a redundant passkey assertion on reconnect.
//
// `helpers.ts` imports native/keystore modules at load time, so they are mocked
// here to keep the unit under test free of the native bridge.
jest.mock('@algorandfoundation/react-native-keystore', () => ({
  encode: jest.fn(),
  encryptData: jest.fn(),
  storage: { set: jest.fn() },
}));
jest.mock('@/stores/keystore', () => ({
  keyStore: { state: { keys: [] }, setState: jest.fn() },
}));
jest.mock('@/utils/base64', () => ({
  toUrlSafe: (value: string) => value,
}));
jest.mock('@algorandfoundation/keystore', () => ({
  encodeAddress: (publicKey: Uint8Array) => `ADDR(${Array.from(publicKey).join(',')})`,
}));
jest.mock('@algorandfoundation/liquid-client', () => ({
  encoding: {
    fromBase64Url: (value: string) => new Uint8Array(Buffer.from(value, 'utf8')),
    toBase64URL: (value: Uint8Array) => Buffer.from(value).toString('base64'),
  },
}));

const MATCHING_ADDRESS = 'MATCHING_ADDRESS';
const OTHER_ADDRESS = 'OTHER_ADDRESS';
const MATCHING_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);

jest.mock('@/utils/algorand', () => ({
  decodeAddress: (address: string) => {
    if (address === 'MATCHING_ADDRESS') return { publicKey: new Uint8Array([1, 2, 3, 4]) };
    return { publicKey: new Uint8Array([9, 9, 9, 9]) };
  },
}));

import {
  sessionAlreadyAuthenticatedForRequest,
  sessionRequestIdFromData,
} from '@/lib/liquid-auth/helpers';
import type { Key } from '@algorandfoundation/keystore';

const REQUEST_ID = '019097ff-bb8c-7d5d-9822-7c9eb2c0d419';
const walletKey = { id: 'key-1', publicKey: MATCHING_PUBLIC_KEY } as unknown as Key;

describe('sessionRequestIdFromData', () => {
  it('reads the requestId nested under session', () => {
    expect(sessionRequestIdFromData({ session: { requestId: REQUEST_ID } })).toBe(REQUEST_ID);
  });

  it('falls back to a top-level requestId', () => {
    expect(sessionRequestIdFromData({ requestId: REQUEST_ID })).toBe(REQUEST_ID);
  });

  it('returns null when no requestId is present', () => {
    expect(sessionRequestIdFromData({ session: {} })).toBeNull();
    expect(sessionRequestIdFromData(null)).toBeNull();
  });
});

describe('sessionAlreadyAuthenticatedForRequest', () => {
  it('is true when the wallet key and requestId both match the session', () => {
    const sessionData = { session: { wallet: MATCHING_ADDRESS, requestId: REQUEST_ID } };
    expect(sessionAlreadyAuthenticatedForRequest(sessionData, walletKey, REQUEST_ID)).toBe(true);
  });

  it('is false when the session is bound to a different requestId', () => {
    const sessionData = { session: { wallet: MATCHING_ADDRESS, requestId: 'other-request' } };
    expect(sessionAlreadyAuthenticatedForRequest(sessionData, walletKey, REQUEST_ID)).toBe(false);
  });

  it('is false when the session wallet does not match the active key', () => {
    const sessionData = { session: { wallet: OTHER_ADDRESS, requestId: REQUEST_ID } };
    expect(sessionAlreadyAuthenticatedForRequest(sessionData, walletKey, REQUEST_ID)).toBe(false);
  });

  it('is false when the session has no wallet', () => {
    const sessionData = { session: { requestId: REQUEST_ID } };
    expect(sessionAlreadyAuthenticatedForRequest(sessionData, walletKey, REQUEST_ID)).toBe(false);
  });

  it('is false for an empty requestId', () => {
    const sessionData = { session: { wallet: MATCHING_ADDRESS, requestId: '' } };
    expect(sessionAlreadyAuthenticatedForRequest(sessionData, walletKey, '')).toBe(false);
  });
});
