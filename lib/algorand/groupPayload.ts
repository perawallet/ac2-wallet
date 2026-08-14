/**
 * x402 atomic-group signing payloads.
 *
 * Agents may ask for a whole Algorand transaction group in ONE AC2
 * `SigningRequest` (schema `x402/exact/algorand/v2/transaction-group`).
 * The payload is a sequence of length-prefixed frames — a 4-byte big-endian
 * byte length followed by the unsigned transaction msgpack — and the approval
 * response carries the concatenated 64-byte Ed25519 signatures in the same
 * order, each over that transaction's canonical signing bytes.
 *
 * The AC2 envelope is untouched (payload/signature stay opaque base64), so
 * agents fall back to one request per transaction when the wallet answers
 * with a single signature instead.
 */

import {
  bytesForSigning,
  decodeTransaction,
  Transaction,
} from '@algorandfoundation/algokit-utils/transact';

export const X402_ALGORAND_GROUP_SIGNING_SCHEMA = 'x402/exact/algorand/v2/transaction-group';

/** Whether a signing request carries a whole transaction group payload. */
export function isGroupSigningSchema(schema: string | undefined): boolean {
  return schema === X402_ALGORAND_GROUP_SIGNING_SCHEMA;
}

/** Split a group payload into its unsigned transactions. Throws on malformed input. */
export function decodeTransactionGroupPayload(payload: Uint8Array): Transaction[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const txns: Transaction[] = [];
  let offset = 0;
  while (offset < payload.length) {
    if (offset + 4 > payload.length) {
      throw new Error('Malformed transaction group payload: truncated length prefix.');
    }
    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > payload.length) {
      throw new Error('Malformed transaction group payload: truncated transaction frame.');
    }
    txns.push(decodeTransaction(payload.subarray(offset, offset + length)));
    offset += length;
  }
  if (txns.length === 0) {
    throw new Error('Malformed transaction group payload: no transactions.');
  }
  return txns;
}

/** Canonical per-transaction signing bytes for a decoded group member. */
export function transactionSigningBytes(txn: Transaction): Uint8Array {
  return bytesForSigning.transaction(txn);
}
