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
import { biometricOptions } from '@/lib/keystore/auth-options';
import { bootstrap } from '@/lib/keystore/bootstrap';
import { isWalletAccountKey } from '@/lib/keystore/wallet-account';
import {
  credentialIdCandidates,
  credentialIdsFromSessionData,
  keyMatchesCredential,
  normalizeCredentialId,
  originMatches,
  passkeyFromKey,
  passkeyMatchesConnection,
  passkeysFromSessionUser,
  persistKeyMetadata,
} from '@/lib/liquid-auth/helpers';
import type { ReactNativeProvider } from '@/providers/ReactNativeProvider';
import { keyStore } from '@/stores/keystore';
import { updateSessionPasskeyCredentialId } from '@/stores/sessions';
import { decodeAddress } from '@/utils/algorand';
import type { Key, KeyData } from '@algorandfoundation/keystore';
import { encodeAddress } from '@algorandfoundation/keystore';
import { assertion, encoding } from '@algorandfoundation/liquid-client';
import { fetchSecret, readMasterKey } from '@algorandfoundation/react-native-keystore';
import ReactNativePasskeyAutofill from '@algorandfoundation/react-native-passkey-autofill';
import { Buffer } from 'buffer';
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
  /**
   * Internal recovery flag. Set when re-entering the exchange after a failed
   * native assertion so it skips the (now unusable) passkey and re-registers
   * via attestation, bypassing the `allowPasskeyCreation` guard.
   */
  recoverFromFailedAssertion?: boolean;
  key: ReactNativeProvider['key'];
  passkey: ReactNativeProvider['passkey'];
  setAddress: (address: string) => void;
  addressRef: MutableRefObject<string | null>;
  authFlowInProgressRef: MutableRefObject<boolean>;
  fetchWithTimeout: FetchWithTimeout;
  /** Returns false once this setup run has been superseded/unmounted. */
  isActive: () => boolean;
}

async function fetchAssertionOptions(
  fetchWithTimeout: FetchWithTimeout,
  origin: string,
  credentialId: string,
): Promise<{ credentialId: string; options: any } | null> {
  const response = await fetchWithTimeout(
    `${origin}/assertion/request/${encodeURIComponent(credentialId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userVerification: 'required',
      }),
    },
  );

  if (!response.ok) return null;
  return { credentialId, options: await response.json() };
}

async function findPasskeyKeyForCredential({
  credential,
  passkeys,
  origin,
  walletAddress,
}: {
  credential: any;
  passkeys: Passkey[];
  origin: string;
  walletAddress: string;
}): Promise<Key | undefined> {
  const credentialIds = credentialIdCandidates(credential);
  const findMatch = () => {
    const matchedPasskey = passkeys.find((p) => credentialIds.has(normalizeCredentialId(p.id)));
    return (
      keyStore.state.keys.find((k) => k.id === matchedPasskey?.metadata?.keyId) ||
      keyStore.state.keys.find((k) => keyMatchesCredential(k, credentialIds)) ||
      keyStore.state.keys.find(
        (k) =>
          (k.type === 'hd-derived-p256' || k.type === 'xhd-derived-p256') &&
          originMatches(k.metadata?.origin, origin) &&
          k.metadata?.userHandle === walletAddress,
      )
    );
  };

  let matchedKey = findMatch();
  for (let attempt = 0; !matchedKey && attempt < 3; attempt += 1) {
    await bootstrap(biometricOptions, false);
    matchedKey = findMatch();
    if (!matchedKey) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return matchedKey;
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
 * Whether a failed native passkey assertion should trigger re-registration via
 * attestation. User-driven aborts (cancellation, timeout, interruption) are
 * intentionally excluded so we respect the user's choice instead of silently
 * re-registering; everything else (e.g. a native "The incoming request cannot
 * be validated" error after the device lost the credential) is recoverable.
 */
export function isRecoverableAssertionFailure(error: unknown): boolean {
  const code = (error as { error?: unknown } | null)?.error;
  if (
    typeof code === 'string' &&
    (code === 'UserCancelled' || code === 'TimedOut' || code === 'Interrupted')
  ) {
    return false;
  }
  return true;
}

/**
 * Run the assertion (existing passkey) or attestation (first-time) exchange.
 * Resolves `{ superseded: true }` when the run was cancelled mid-flight, or
 * `{ superseded: false }` once authentication has completed.
 */
export async function authenticateLiquidAuth(
  params: AuthenticateLiquidAuthParams,
): Promise<{ superseded: boolean }> {
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
    authFlowInProgressRef,
    fetchWithTimeout,
    isActive,
  } = params;

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
  // Skip looking up an existing passkey when recovering from a failed native
  // assertion: the device can no longer use the credential, so go straight to
  // attestation to re-register it.
  if (!params.recoverFromFailedAssertion) {
    for (const credentialId of uniqueAssertionCredentialIds) {
      assertionOptions = await fetchAssertionOptions(fetchWithTimeout, origin, credentialId);
      if (!isActive()) return { superseded: true };
      if (assertionOptions) break;
    }
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
        decodedOptions.allowCredentials.map((c: { id: ArrayBuffer }) =>
          encoding.toBase64URL(new Uint8Array(c.id as ArrayBuffer)),
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

    const challenge = encoding.fromBase64Url(assertionOptions.options.challenge);

    const liquidOptions = {
      requestId,
      origin,
      type: 'algorand',
      address: walletAddress,
      signature: encoding.toBase64URL(await key.store.sign(foundKey.id, challenge)),
      device: 'Demo Web Wallet',
    };

    let credential: any;
    try {
      credential = (await navigator.credentials.get({
        publicKey: decodedOptions,
      })) as any;
    } catch (assertionError) {
      // After an app reinstall the platform may no longer hold this passkey even
      // though the server still has the credential record (so assertion options
      // were found above). Instead of aborting the whole connection with a
      // native "The incoming request cannot be validated" error, fall back to
      // attestation to re-register the passkey. User-driven aborts
      // (cancel/timeout) are re-thrown so they surface normally.
      if (!isRecoverableAssertionFailure(assertionError)) throw assertionError;
      console.warn(
        'Passkey assertion failed; re-registering via attestation:',
        assertionError,
      );
      return authenticateLiquidAuth({
        ...params,
        recoverFromFailedAssertion: true,
      });
    }
    if (!isActive()) return { superseded: true };
    authFlowInProgressRef.current = false;

    if (!credential) {
      throw new Error('Credential creation failed');
    }

    const currentPasskeys = await passkey.store.getPasskeys();
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

      // Re-sign the challenge if the address changed to match the selected passkey
      const selectedPublicKey = decodeAddress(selectedAddress).publicKey;
      const selectedKey = keyStore.state.keys.find(
        (k) =>
          isWalletAccountKey(k) &&
          k.publicKey &&
          k.publicKey.length === selectedPublicKey.length &&
          k.publicKey.every((v, i) => v === selectedPublicKey[i]),
      );

      if (selectedKey) {
        console.log('Found key for selected address, re-signing challenge');
        liquidOptions.signature = encoding.toBase64URL(
          await key.store.sign(selectedKey.id, challenge),
        );
      } else {
        console.warn('Could not find key for selected address', selectedAddress);
      }
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

    const matchedKey = await findPasskeyKeyForCredential({
      credential,
      passkeys: [...currentPasskeys, ...relevantPasskeys],
      origin,
      walletAddress: selectedAddress ?? liquidOptions.address,
    });

    if (matchedKey) {
      try {
        // Pass a defensive copy via `options.masterKey` so `fetchSecret`
        // can zero its own buffer in `finally` without wiping ours.
        const masterKey = await readMasterKey(biometricOptions);
        const keyData = await fetchSecret<KeyData>({
          keyId: matchedKey.id,
          options: { masterKey: Buffer.from(masterKey) },
        });
        if (keyData) {
          keyData.metadata = {
            ...keyData.metadata,
            origin,
            ...(selectedAddress ? { userHandle: selectedAddress } : {}),
            registered: true,
          };
          persistKeyMetadata(keyData, masterKey);
        }
      } catch (error) {
        console.error('Failed to update key metadata after assertion:', error);
      }
    }
  } else {
    // Allow re-registration during recovery even when passkey creation is
    // otherwise disabled: we already know a credential exists server-side, the
    // device just lost the local passkey (e.g. after an app reinstall).
    if (!allowPasskeyCreation && !params.recoverFromFailedAssertion) {
      throw new Error(
        'No existing passkey was found for this connection. Scan the agent QR code again to create one.',
      );
    }

    console.log('No existing passkey for origin, using attestation');

    const optionsResponse = await fetchWithTimeout(`${origin}/attestation/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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

    const credential = (await navigator.credentials.create({
      publicKey: decodedPublicKey,
    })) as any;
    if (!isActive()) return { superseded: true };
    authFlowInProgressRef.current = false;

    if (!credential) {
      throw new Error('Credential creation failed');
    }

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

    const currentPasskeys = await passkey.store.getPasskeys();
    const matchedKey = await findPasskeyKeyForCredential({
      credential,
      passkeys: currentPasskeys,
      origin,
      walletAddress: liquidOptions.address,
    });

    if (matchedKey) {
      try {
        // Pass a defensive copy via `options.masterKey` so `fetchSecret`
        // can zero its own buffer in `finally` without wiping ours.
        const masterKey = await readMasterKey(biometricOptions);
        const keyData = await fetchSecret<KeyData>({
          keyId: matchedKey.id,
          options: { masterKey: Buffer.from(masterKey) },
        });
        if (keyData) {
          keyData.metadata = {
            ...keyData.metadata,
            origin,
            userHandle: liquidOptions.address,
            registered: true,
          };
          persistKeyMetadata(keyData, masterKey);
        }
      } catch (error) {
        console.error('Failed to update key metadata after attestation:', error);
      }
    }
  }

  return { superseded: false };
}
