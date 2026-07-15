import * as Keychain from 'react-native-keychain';
import { Buffer } from 'buffer';

/**
 * Durable authorization returned by Liquid Auth after a successful initial
 * assertion/attestation. The opaque `credential` is deliberately kept out of
 * MMKV and logs; only the non-secret reference is stored with the session.
 */
export interface DurablePairingCredential {
  version: 2;
  pairingId: string;
  role: 'controller';
  credential: string;
}

export interface PairingCredentialReference {
  version: 2;
  pairingId: string;
  role: 'controller';
  storage: 'keychain';
}

export class PairingCredentialUnavailableError extends Error {
  readonly code = 'PAIRING_CREDENTIAL_UNAVAILABLE';

  constructor() {
    super('The saved Liquid Auth pairing credential is temporarily unavailable');
    this.name = 'PairingCredentialUnavailableError';
  }
}

const SERVICE_PREFIX = 'app.perawallet.ac2.liquid-pairing';

function serviceFor(origin: string, requestId: string): string {
  const encoded = Buffer.from(`${origin}\0${requestId}`, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${SERVICE_PREFIX}.${encoded}`;
}

export function parsePairingCredential(value: unknown): DurablePairingCredential | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 2 ||
    typeof candidate.pairingId !== 'string' ||
    candidate.pairingId.length === 0 ||
    candidate.role !== 'controller' ||
    typeof candidate.credential !== 'string' ||
    candidate.credential.trim().length === 0
  ) {
    return null;
  }
  return candidate as unknown as DurablePairingCredential;
}

export async function persistPairingCredential(
  origin: string,
  requestId: string,
  pairing: DurablePairingCredential,
): Promise<PairingCredentialReference> {
  const result = await Keychain.setGenericPassword(pairing.pairingId, JSON.stringify(pairing), {
    service: serviceFor(origin, requestId),
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (!result) throw new Error('Unable to securely save the Liquid Auth pairing');
  return {
    version: pairing.version,
    pairingId: pairing.pairingId,
    role: pairing.role,
    storage: 'keychain',
  };
}

export async function loadPairingCredential(
  origin: string,
  requestId: string,
  reference?: PairingCredentialReference,
): Promise<DurablePairingCredential | null> {
  if (!reference || reference.storage !== 'keychain') return null;

  let result: Awaited<ReturnType<typeof Keychain.getGenericPassword>>;
  try {
    result = await Keychain.getGenericPassword({ service: serviceFor(origin, requestId) });
  } catch {
    throw new PairingCredentialUnavailableError();
  }
  if (!result) return null;

  let pairing: DurablePairingCredential | null;
  try {
    pairing = parsePairingCredential(JSON.parse(result.password));
  } catch {
    throw new PairingCredentialUnavailableError();
  }
  if (!pairing || pairing.pairingId !== reference.pairingId) {
    throw new PairingCredentialUnavailableError();
  }
  return pairing;
}

export async function removePairingCredential(origin: string, requestId: string): Promise<void> {
  await Keychain.resetGenericPassword({ service: serviceFor(origin, requestId) });
}
