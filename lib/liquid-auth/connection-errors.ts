export type PairingAuthorizationFailure = 'revoked' | 'unauthorized';

export type ConnectionFailureKind =
  | 'pairing-revoked'
  | 'pairing-unauthorized'
  | 'credential-interaction'
  | 'transient';

const REVOKED_PAIRING_CODES = new Set(['PAIRING_REVOKED', 'PAIRING_REMOVED']);
const UNAUTHORIZED_PAIRING_CODES = new Set(['PAIRING_UNAUTHORIZED', 'INVALID_PAIRING']);

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<object>();
  let current = error;

  // Liquid Client surfaces stable codes directly on SignalError, while raw
  // Socket.IO handshake errors put the code in `data`. Follow a short cause
  // chain as well so wrapping an error does not erase its retry semantics.
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as { code?: unknown; data?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') codes.push(candidate.code.toUpperCase());
    if (candidate.data && typeof candidate.data === 'object') {
      const dataCode = (candidate.data as { code?: unknown }).code;
      if (typeof dataCode === 'string') codes.push(dataCode.toUpperCase());
    }
    current = candidate.cause;
  }

  return codes;
}

/**
 * Return only explicitly coded pairing authorization failures. HTTP status,
 * proxy messages, and transport text are deliberately ignored: those can be
 * transient and must not delete a valid controller credential.
 */
export function getPairingAuthorizationFailure(error: unknown): PairingAuthorizationFailure | null {
  const codes = errorCodes(error);
  if (codes.some((code) => REVOKED_PAIRING_CODES.has(code))) return 'revoked';
  if (codes.some((code) => UNAUTHORIZED_PAIRING_CODES.has(code))) return 'unauthorized';
  return null;
}

export function isCredentialInteractionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name.toLowerCase() : '';
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '';
  const description = `${name} ${message} ${code}`;

  return (
    name === 'notallowederror' ||
    description.includes('cancel') ||
    description.includes('user denied') ||
    description.includes('not allowed') ||
    description.includes('authorizationerror error 1001') ||
    description.includes('no existing passkey was found')
  );
}

/** Classify setup recovery without conflating a stale secret with revocation. */
export function classifyConnectionFailure(
  error: unknown,
  attemptedDurablePairing: boolean,
): ConnectionFailureKind {
  if (attemptedDurablePairing) {
    const pairingFailure = getPairingAuthorizationFailure(error);
    if (pairingFailure === 'revoked') return 'pairing-revoked';
    if (pairingFailure === 'unauthorized') return 'pairing-unauthorized';
  }
  if (isCredentialInteractionError(error)) return 'credential-interaction';
  return 'transient';
}
