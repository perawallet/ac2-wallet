/**
 * The Liquid Auth passkey assertion / attestation exchange used by
 * `useConnection` to authenticate the wallet against an origin before opening
 * the WebRTC transport.
 *
 * Extracted from the connection effect purely for readability — the logic
 * mirrors the inline version. The one adaptation is control flow: where the
 * inline version did `if (!active) return;` to bail out of a superseded run,
 * this returns `{ superseded: true }` so the caller can stop the surrounding
 * setup. Thrown errors propagate to the caller's try/catch exactly as before.
 * Network requests are routed through the caller's `fetchWithTimeout` so a
 * stalled request during reconnect is bounded rather than hanging forever.
 */
import type { Passkey } from '@/extensions/passkeys';
import {
  credentialIdsFromSessionData,
  normalizeCredentialId,
  passkeyFromKey,
  passkeyMatchesConnection,
  passkeysFromSessionUser,
} from '@/lib/liquid-auth/helpers';
import {
  parsePairingCredential,
  persistPairingCredential,
  type DurablePairingCredential,
} from '@/lib/liquid-auth/pairing-credentials';
import type { ReactNativeProvider } from '@/providers/ReactNativeProvider';
import { updateSessionPairing, updateSessionPasskeyCredentialId } from '@/stores/sessions';
import { decodeAddress } from '@/utils/algorand';
import type { Key } from '@algorandfoundation/keystore';
import { encodeAddress } from '@algorandfoundation/keystore';
import { assertion, encoding } from '@algorandfoundation/liquid-client';
import ReactNativePasskeyAutofill from '@algorandfoundation/react-native-passkey-autofill';
import type { MutableRefObject } from 'react';

type FetchWithTimeout = (
  input: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

export interface AuthenticateLiquidAuthParams {
  origin: string;
  requestId: string;
  /** Fallback key used to sign the Liquid challenge (already validated). */
  foundKey: Key;
  /** Algorand address of `foundKey`, used as the Liquid Auth wallet address. */
  walletAddress: string;
  /** Snapshot of the keystore keys taken at the start of the setup run. */
  currentKeys: Key[];
  /** Parsed `/auth/session` payload from before the exchange, if any. */
  initialSessionData: any;
  initialSessionAddress: string | null;
  /** Passkey credential id remembered from a prior successful connection. */
  existingSessionPasskeyCredentialId?: string;
  /**
   * When false (default), a missing passkey throws instead of silently
   * creating a new one via attestation. Only the initial scan flow opts in.
   */
  allowPasskeyCreation: boolean;
  key: ReactNativeProvider['key'];
  passkey: ReactNativeProvider['passkey'];
  setAddress: (address: string) => void;
  addressRef: MutableRefObject<string | null>;
  fetchWithTimeout: FetchWithTimeout;
  /** Cancels HTTP, signaling, and any pending credential result for this setup run. */
  signal: AbortSignal;
  /** Returns false once this setup run has been superseded/unmounted. */
  isActive: () => boolean;
  /** Consume scanner-only creation permission as soon as native creation succeeds. */
  onPasskeyCreated?: () => void;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function credentialOperationWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
}

/** Preserve byte offsets for every DOM `BufferSource` shape Liquid Client can decode. */
export function bytesFromBufferSource(source: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

async function fetchAssertionOptions(
  fetchWithTimeout: FetchWithTimeout,
  origin: string,
  requestId: string,
  credentialId: string,
): Promise<{ credentialId: string; options: any } | null> {
  const response = await fetchWithTimeout(
    `${origin}/assertion/request/${encodeURIComponent(credentialId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userVerification: 'required',
        requestId,
      }),
    },
  );

  if (!response.ok) return null;
  return { credentialId, options: await response.json() };
}

async function nativeStoredPasskeys(): Promise<Passkey[]> {
  const credentials = await ReactNativePasskeyAutofill.getStoredCredentials().catch(() => []);
  return credentials
    .filter((credential: any) => typeof credential?.credentialId === 'string')
    .map((credential: any) => {
      const id = credential.credentialId.trim();
      const origin = credential.relyingPartyIdentifier || credential.rpId || credential.origin;
      const userHandle = credential.userHandle;
      return {
        id,
        name: `${userHandle || 'Liquid Auth'}@${origin || 'Unknown Origin'}`,
        userHandle,
        origin,
        publicKey: new Uint8Array(),
        algorithm: 'P256',
        createdAt: credential.createdAt || Date.now(),
        metadata: {
          origin,
          userHandle,
          registered: true,
          source: 'native-autofill-store',
        },
      };
    });
}

/**
 * Run the assertion (existing passkey) or attestation (first-time) exchange.
 * Resolves `{ superseded: true }` when the run was cancelled mid-flight, or
 * `{ superseded: false }` once authentication has completed.
 */
export async function authenticateLiquidAuth(
  params: AuthenticateLiquidAuthParams,
): Promise<{ superseded: boolean; pairing?: DurablePairingCredential }> {
  const {
    origin,
    requestId,
    foundKey,
    walletAddress,
    currentKeys,
    initialSessionData,
    initialSessionAddress,
    existingSessionPasskeyCredentialId,
    allowPasskeyCreation,
    key,
    passkey,
    setAddress,
    addressRef,
    fetchWithTimeout,
    signal,
    isActive,
    onPasskeyCreated,
  } = params;

  throwIfAborted(signal);

  const storedPasskeys = await passkey.store.getPasskeys();
  const passkeysById = new Map<string, Passkey>(
    storedPasskeys.map((currentPasskey) => [
      normalizeCredentialId(currentPasskey.id),
      currentPasskey,
    ]),
  );
  const addPasskeyCandidate = (candidate: Passkey) => {
    const normalizedId = normalizeCredentialId(candidate.id);
    if (!passkeysById.has(normalizedId)) {
      passkeysById.set(normalizedId, candidate);
    }
  };

  (await nativeStoredPasskeys()).forEach(addPasskeyCandidate);

  passkeysFromSessionUser(initialSessionData, origin).forEach(addPasskeyCandidate);

  currentKeys.forEach((currentKey) => {
    const keyBackedPasskey = passkeyFromKey(currentKey);
    if (keyBackedPasskey) addPasskeyCandidate(keyBackedPasskey);
  });

  const currentPasskeys = [...passkeysById.values()];
  const relevantPasskeys = currentPasskeys.filter((p) =>
    passkeyMatchesConnection(p, origin, initialSessionAddress),
  );

  const assertionCredentialIds = [
    existingSessionPasskeyCredentialId,
    ...credentialIdsFromSessionData(initialSessionData),
    ...relevantPasskeys.map((p) => p.id),
    walletAddress,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const seenAssertionCredentialIds = new Set<string>();
  const uniqueAssertionCredentialIds = assertionCredentialIds.filter((id) => {
    const normalized = normalizeCredentialId(id);
    if (seenAssertionCredentialIds.has(normalized)) return false;
    seenAssertionCredentialIds.add(normalized);
    return true;
  });

  let assertionOptions: { credentialId: string; options: any } | null = null;
  for (const credentialId of uniqueAssertionCredentialIds) {
    assertionOptions = await fetchAssertionOptions(
      fetchWithTimeout,
      origin,
      requestId,
      credentialId,
    );
    if (!isActive()) return { superseded: true };
    if (assertionOptions) break;
  }

  if (assertionOptions) {
    console.log(
      'Found existing passkey assertion options for credential:',
      assertionOptions.credentialId,
    );

    const decodedOptions = assertion.encoder.decodeOptions(assertionOptions.options);

    // Ensure all relevant passkeys are allowed in the options to allow user selection in the intent
    if (relevantPasskeys.length > 1) {
      if (!decodedOptions.allowCredentials) {
        decodedOptions.allowCredentials = [];
      }
      const existingIds = new Set(
        decodedOptions.allowCredentials.map((credential: { id: BufferSource }) =>
          encoding.toBase64URL(bytesFromBufferSource(credential.id)),
        ),
      );
      relevantPasskeys.forEach((p) => {
        if (!existingIds.has(p.id)) {
          decodedOptions.allowCredentials!.push({
            id: encoding.fromBase64Url(p.id),
            type: 'public-key',
          });
        }
      });
    }

    const liquidOptions = {
      requestId,
      origin,
      type: 'algorand',
      address: walletAddress,
      device: 'Demo Web Wallet',
    };

    throwIfAborted(signal);
    const credential = (await credentialOperationWithAbort(
      navigator.credentials.get({
        publicKey: decodedOptions,
        signal,
      }),
      signal,
    )) as any;
    if (!isActive()) return { superseded: true };
    if (!credential) {
      throw new Error('Credential creation failed');
    }

    let selectedAddress: string | null = null;
    if (credential.response?.userHandle) {
      try {
        selectedAddress = encodeAddress(new Uint8Array(credential.response.userHandle));
      } catch (e) {
        console.error('Failed to encode address from userHandle', e);
      }
    }

    if (!selectedAddress) {
      const matchedPasskey =
        relevantPasskeys.find((p) => p.id === credential.id) ||
        currentPasskeys.find((p) => p.id === credential.id);
      const userHandle = matchedPasskey?.metadata?.userHandle;
      if (userHandle) {
        try {
          // Handle different possible formats of userHandle in store (Uint8Array or serialized object)
          const handleArray =
            userHandle instanceof Uint8Array
              ? userHandle
              : typeof userHandle === 'object'
                ? new Uint8Array(Object.values(userHandle))
                : null;
          if (handleArray) {
            selectedAddress = encodeAddress(handleArray);
          }
        } catch (e) {
          console.error('Failed to encode address from stored userHandle', e);
        }
      }
    }

    if (selectedAddress) {
      console.log('Selected address from passkey:', selectedAddress);
      setAddress(selectedAddress);
      addressRef.current = selectedAddress;
      liquidOptions.address = selectedAddress;
    }

    const encodedCredential = assertion.encoder.encodeCredential(credential);
    encodedCredential.clientExtensionResults = {
      ...encodedCredential.clientExtensionResults,
      liquid: liquidOptions,
    } as any;

    const submitResponse = await fetchWithTimeout(`${origin}/assertion/response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encodedCredential),
    });

    if (!submitResponse.ok) {
      throw new Error(
        `Failed to submit assertion response: ${submitResponse.status} ${submitResponse.statusText}`,
      );
    }
    updateSessionPasskeyCredentialId(requestId, origin, credential.id);
    const responseData = await submitResponse.json().catch(() => null);
    const pairing = parsePairingCredential(responseData?.pairing);
    if (pairing) {
      const reference = await persistPairingCredential(origin, requestId, pairing);
      updateSessionPairing(requestId, origin, reference);
      return { superseded: false, pairing };
    }
  } else {
    if (!allowPasskeyCreation) {
      throw new Error(
        'No existing passkey was found for this connection. Scan the agent QR code again to create one.',
      );
    }

    console.log('No existing passkey for origin, using attestation');

    const optionsResponse = await fetchWithTimeout(`${origin}/attestation/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        attestationType: 'none',
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'required',
          requireResidentKey: true,
        },
        extensions: {
          liquid: true,
        },
      }),
    });

    if (!isActive()) return { superseded: true };

    if (!optionsResponse.ok) {
      throw new Error(
        `Failed to get attestation request: ${optionsResponse.status} ${optionsResponse.statusText}`,
      );
    }

    const encodedAttestationOptions = await optionsResponse.json();
    if (!isActive()) return { superseded: true };
    const challenge = encoding.fromBase64Url(encodedAttestationOptions.challenge);

    const liquidOptions = {
      requestId,
      origin: origin,
      type: 'algorand',
      address: walletAddress,
      signature: encoding.toBase64URL(await key.store.sign(foundKey.id, challenge)),
      device: 'Demo Web Wallet',
    };

    const decodedPublicKey = {
      ...encodedAttestationOptions,
      user: {
        ...encodedAttestationOptions.user,
        id: decodeAddress(liquidOptions.address).publicKey,
        name: liquidOptions.address,
        displayName: liquidOptions.address,
      },
      challenge: encoding.fromBase64Url(encodedAttestationOptions.challenge),
      excludeCredentials: encodedAttestationOptions.excludeCredentials?.map((cred: any) => ({
        ...cred,
        id: encoding.fromBase64Url(cred.id),
      })),
    };

    throwIfAborted(signal);
    const credential = (await credentialOperationWithAbort(
      navigator.credentials.create({
        publicKey: decodedPublicKey,
        signal,
      }),
      signal,
    )) as any;
    if (!credential) {
      throw new Error('Credential creation failed');
    }
    onPasskeyCreated?.();
    if (!isActive()) return { superseded: true };

    setAddress(liquidOptions.address);
    addressRef.current = liquidOptions.address;

    const response = credential.response;
    const encodedCredential = {
      id: credential.id,
      rawId: encoding.toBase64URL(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: encoding.toBase64URL(response.clientDataJSON),
        attestationObject: encoding.toBase64URL(response.attestationObject),
        clientExtensionResults: response.clientExtensionResults || {},
      },
      clientExtensionResults: {
        ...(credential.getClientExtensionResults
          ? credential.getClientExtensionResults()
          : credential.clientExtensionResults || {}),
        liquid: liquidOptions,
      },
    };

    const submitResponse = await fetchWithTimeout(`${origin}/attestation/response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encodedCredential),
    });

    if (!isActive()) return { superseded: true };

    if (!submitResponse.ok) {
      throw new Error(
        `Failed to submit attestation response: ${submitResponse.status} ${submitResponse.statusText}`,
      );
    }
    updateSessionPasskeyCredentialId(requestId, origin, credential.id);
    const responseData = await submitResponse.json().catch(() => null);
    const pairing = parsePairingCredential(responseData?.pairing);
    if (pairing) {
      const reference = await persistPairingCredential(origin, requestId, pairing);
      updateSessionPairing(requestId, origin, reference);
      return { superseded: false, pairing };
    }
  }

  return { superseded: false };
}
