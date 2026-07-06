/**
 * The Liquid Auth passkey assertion / attestation exchange used by
 * `useConnection` to authenticate the wallet against an origin before opening
 * the WebRTC transport.
 *
 * Extracted from the connection effect purely for readability — the logic is
 * unchanged. The one adaptation is control flow: where the inline version did
 * `if (!active) return;` to bail out of a superseded run, this returns
 * `{ superseded: true }` so the caller can stop the surrounding setup. Thrown
 * errors propagate to the caller's try/catch exactly as before.
 */
import type { Passkey } from '@/extensions/passkeys';
import {
  passkeyFromKey,
  passkeyMatchesConnection,
  passkeysFromSessionUser,
  persistKeyMetadata,
} from '@/hooks/liquidAuthHelpers';
import { biometricOptions } from '@/lib/keystore/auth-options';
import type { ReactNativeProvider } from '@/providers/ReactNativeProvider';
import { keyStore } from '@/stores/keystore';
import { decodeAddress } from '@/utils/algorand';
import { toUrlSafe } from '@/utils/base64';
import type { Key, KeyData } from '@algorandfoundation/keystore';
import { encodeAddress } from '@algorandfoundation/keystore';
import { assertion, encoding } from '@algorandfoundation/liquid-client';
import { fetchSecret, getMasterKey } from '@algorandfoundation/react-native-keystore';
import { Buffer } from 'buffer';
import type { MutableRefObject } from 'react';

export interface AuthenticateLiquidAuthParams {
  origin: string;
  requestId: string;
  /** Fallback key used to sign the Liquid challenge (already validated). */
  foundKey: Key;
  /** Snapshot of the keystore keys taken at the start of the setup run. */
  currentKeys: Key[];
  /** Parsed `/auth/session` payload from before the exchange, if any. */
  initialSessionData: any;
  initialSessionAddress: string | null;
  key: ReactNativeProvider['key'];
  passkey: ReactNativeProvider['passkey'];
  setAddress: (address: string) => void;
  addressRef: MutableRefObject<string | null>;
  authFlowInProgressRef: MutableRefObject<boolean>;
  fetchWithTimeout: (input: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
  /** Returns false once this setup run has been superseded/unmounted. */
  isActive: () => boolean;
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
    currentKeys,
    initialSessionData,
    initialSessionAddress,
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
    storedPasskeys.map((currentPasskey) => [currentPasskey.id, currentPasskey]),
  );

  passkeysFromSessionUser(initialSessionData, origin).forEach((sessionPasskey) => {
    if (!passkeysById.has(sessionPasskey.id)) {
      passkeysById.set(sessionPasskey.id, sessionPasskey);
    }
  });

  currentKeys.forEach((currentKey) => {
    const keyBackedPasskey = passkeyFromKey(currentKey);
    if (keyBackedPasskey && !passkeysById.has(keyBackedPasskey.id)) {
      passkeysById.set(keyBackedPasskey.id, keyBackedPasskey);
    }
  });

  const currentPasskeys = [...passkeysById.values()];
  const relevantPasskeys = currentPasskeys.filter((p) =>
    passkeyMatchesConnection(p, origin, initialSessionAddress),
  );

  if (relevantPasskeys.length > 0) {
    const firstPasskey = relevantPasskeys[0];
    console.log(
      'Found existing passkeys for origin, using first one for options request:',
      firstPasskey.id,
    );
    // TODO: move options upstream
    const optionsResponse = await fetchWithTimeout(
      `${origin}/assertion/request/${firstPasskey.id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userVerification: 'required',
        }),
      },
    );

    if (!isActive()) return { superseded: true };

    if (!optionsResponse.ok) {
      throw new Error(
        `Failed to get assertion request: ${optionsResponse.status} ${optionsResponse.statusText}`,
      );
    }

    const options = await optionsResponse.json();
    if (!isActive()) return { superseded: true };
    const decodedOptions = assertion.encoder.decodeOptions(options);

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

    const challenge = encoding.fromBase64Url(options.challenge);

    const liquidOptions = {
      requestId,
      origin,
      type: 'algorand',
      address: encodeAddress(foundKey.publicKey!),
      signature: encoding.toBase64URL(await key.store.sign(foundKey.id, challenge)),
      device: 'Demo Web Wallet',
    };

    const credential = (await navigator.credentials.get({
      publicKey: decodedOptions,
    })) as any;
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

    const matchedPasskey = currentPasskeys.find((p) => p.id === credential.id);
    const matchedKey =
      keyStore.state.keys.find((k) => k.id === matchedPasskey?.metadata?.keyId) ||
      keyStore.state.keys.find((k) => toUrlSafe(k.id) === credential.id);

    if (matchedKey) {
      try {
        // Pass a defensive copy via `options.masterKey` so `fetchSecret`
        // can zero its own buffer in `finally` without wiping ours.
        const masterKey = await getMasterKey(biometricOptions);
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
      address: encodeAddress(foundKey.publicKey!),
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

    const currentPasskeys = await passkey.store.getPasskeys();
    const matchedPasskey = currentPasskeys.find((p) => p.id === credential.id);
    const matchedKey =
      keyStore.state.keys.find((k) => k.id === matchedPasskey?.metadata?.keyId) ||
      keyStore.state.keys.find((k) => toUrlSafe(k.id) === credential.id);

    if (matchedKey) {
      try {
        // Pass a defensive copy via `options.masterKey` so `fetchSecret`
        // can zero its own buffer in `finally` without wiping ours.
        const masterKey = await getMasterKey(biometricOptions);
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
