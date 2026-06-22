import { encodeAddress } from '@algorandfoundation/algokit-utils';

export function formatMicroAmount(value: bigint, decimals: number, minDecimals = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  // Strip insignificant trailing zeros, but keep at least `minDecimals` places
  // so balances read like "12.50" rather than "12.5" / "12".
  const trimmed = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const fracStr = trimmed.padEnd(Math.min(minDecimals, decimals), '0');
  const result = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${result}` : result;
}

export function truncateAddress(address: string, lead = 6, trail = 4): string {
  if (address.length <= lead + trail) return address;
  return `${address.slice(0, lead)}…${address.slice(-trail)}`;
}

// Canonical Algorand addresses are 58 base32 chars (A-Z, 2-7) with a checksum.
const CANONICAL_ALGORAND_ADDRESS = /^[A-Z2-7]{58}$/;

/**
 * Normalizes an account address into the canonical Algorand format. The keystore
 * auto-populates `account.address` with the raw 32-byte public key encoded as
 * base64 (e.g. "EXSgA3yQ…="), which `getInformation`/QR/copy all reject. Convert
 * it once at the source so every consumer gets the real address.
 */
export function normalizeAlgorandAddress(raw?: string): string | undefined {
  if (!raw) return undefined;
  if (CANONICAL_ALGORAND_ADDRESS.test(raw)) return raw;
  try {
    const bytes = Uint8Array.from(Buffer.from(raw, 'base64'));
    if (bytes.length === 32) return encodeAddress(bytes);
  } catch {
    // Not base64 / not a 32-byte key — fall through and return as-is so the
    // caller can decide how to handle an unexpected value.
  }
  return raw;
}
