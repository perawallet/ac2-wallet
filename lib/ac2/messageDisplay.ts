import { TransactionType } from '@algorandfoundation/algokit-utils/transact';
import type { TransactionSummary } from '@/lib/algorand/transactions';
import type { Ac2Direction, Ac2MessageEntry } from '@/stores/ac2Messages';

type Envelope = Ac2MessageEntry['envelope'];

/** A signing request that moves Algorand value (vs. an identity/ownership proof). */
export function isFundMovingRequest(envelope: Envelope): boolean {
  return (
    envelope.type === 'ac2/SigningRequest' &&
    (envelope.body as { sig_hint?: string }).sig_hint === 'transaction-algorand'
  );
}

export type ValueSummaryData = { lead: string; amount: string; to?: string };

/** Plain-language "what moves" summary for a decoded transaction, or null when
 *  there is nothing simple to show (app call / unknown type). */
export function formatValueSummary(summary: TransactionSummary): ValueSummaryData | null {
  if (summary.type === TransactionType.Payment) {
    const pay = summary as Extract<TransactionSummary, { type: TransactionType.Payment }>;
    const algo = (Number(pay.amount) / 1e6).toLocaleString('en-US', {
      maximumFractionDigits: 6,
    });
    return { lead: 'Sends', amount: `${algo} ALGO`, to: pay.to.toString() };
  }
  if (summary.type === TransactionType.AssetTransfer) {
    // No local asset metadata, so amount is shown in raw base units + asset id.
    const axfer = summary as Extract<TransactionSummary, { type: TransactionType.AssetTransfer }>;
    return {
      lead: 'Transfers',
      amount: `${axfer.amount.toString()} (asset ${axfer.assetId.toString()})`,
      to: axfer.to.toString(),
    };
  }
  return null;
}

/** Signature algorithm label for the technical-details table. */
export function signatureLabel(keyType?: string): string {
  return keyType === 'secp256k1' ? 'secp256k1' : 'Ed25519 (raw)';
}

/** Human label for the request's `display_hint`. */
export function displayHintLabel(hint?: string): string {
  switch (hint) {
    case 'json':
      return 'JSON';
    case 'hex':
      return 'Hex';
    default:
      return 'Plain text';
  }
}

/** Wallet-relative direction label for the technical-details table. */
export function directionLabel(direction: Ac2Direction): string {
  return direction === 'outbound' ? 'This wallet → peer' : 'peer → this wallet';
}

export type Outcome = 'approved' | 'rejected';

export function isResponseEnvelope(type: string): boolean {
  return (
    type === 'ac2/SigningResponse' || type === 'ac2/SigningRejected' || type === 'ac2/KeyResponse'
  );
}

/** An outbound response/rejection whose outcome is merged onto the request card,
 *  so it should be filtered out of the timeline as a standalone entry. */
export function isMergedResponse(entry: Ac2MessageEntry): boolean {
  return entry.direction === 'outbound' && isResponseEnvelope(entry.envelope.type);
}

/** Map each request's id (`response.thid`) to its approve/decline outcome. */
export function deriveOutcomeByThid(messages: Ac2MessageEntry[]): Map<string, Outcome> {
  const map = new Map<string, Outcome>();
  for (const m of messages) {
    if (m.direction !== 'outbound') continue;
    const { type, thid } = m.envelope;
    if (!thid) continue;
    if (type === 'ac2/SigningResponse') map.set(thid, 'approved');
    else if (type === 'ac2/SigningRejected') map.set(thid, 'rejected');
    else if (type === 'ac2/KeyResponse') {
      const status = (m.envelope.body as { status?: string }).status;
      map.set(thid, status === 'approved' ? 'approved' : 'rejected');
    }
  }
  return map;
}
