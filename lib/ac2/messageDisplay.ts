import type { TransactionSummary } from '@/lib/algorand/transactions';
import type { Ac2Direction, Ac2MessageEntry } from '@/stores/ac2Messages';
import { TransactionType } from '@algorandfoundation/algokit-utils/transact';

type Envelope = Ac2MessageEntry['envelope'];

/** A signing request that moves Algorand value (vs. an identity/ownership proof). */
export function isFundMovingRequest(envelope: Envelope): boolean {
  return (
    envelope.type === 'ac2/SigningRequest' &&
    (envelope.body as { sig_hint?: string }).sig_hint === 'transaction-algorand'
  );
}

export type ValueSummaryData = { lead: string; amount: string; to?: string };
export type TransactionRequestContext = {
  site: string;
  purpose?: string;
  resourceName?: string;
  resourceUrl?: string;
  contentType?: string;
  network?: string;
  signingIndex?: number;
  signingTotal?: number;
  signingAddress?: string;
};

export function formatAlgo(microAlgo: bigint): string {
  const whole = microAlgo / 1_000_000n;
  const fraction = microAlgo % 1_000_000n;
  if (fraction === 0n) return `${whole.toLocaleString('en-US')} ALGO`;
  const padded = fraction.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}.${padded} ALGO`;
}

function firstMatch(description: string, regex: RegExp): string | undefined {
  return description.match(regex)?.[1]?.trim();
}

/** Pulls AC2/x402 context out of descriptions without treating it as decoded tx data. */
export function getTransactionRequestContext(
  description: string,
  site: string,
): TransactionRequestContext {
  const cleaned = description.replace(/\s+/g, ' ').trim();
  const signing = cleaned.match(/Sign transaction\s+(\d+)\s+of\s+(\d+)\s+as\s+([A-Z2-7]+)/i);
  const resource = cleaned.match(/Resource:\s*(.*?)(?:\s+https?:\/\/|\s+·\s+https?:\/\/|$)/i);
  const resourceUrl = cleaned.match(/(https?:\/\/\S+)/i)?.[1]?.replace(/[.,)]$/, '');
  const contentType = firstMatch(cleaned, /·\s*([a-z]+\/[a-z0-9.+-]+)\b/i);
  const purposeStop = cleaned.search(/\bSign transaction\b|Sender:|Resource:/i);
  const purpose = (purposeStop > 0 ? cleaned.slice(0, purposeStop) : cleaned)
    .replace(/\s*·\s*/g, ' · ')
    .trim();

  return {
    site,
    purpose: purpose || undefined,
    resourceName: resource?.[1]?.replace(/\s*·\s*$/, '').trim(),
    resourceUrl,
    contentType,
    network: firstMatch(cleaned, /\bnetwork\s+([^·]+?)(?:\s+·|\s+asset|\s+amount|\s+payTo|$)/i),
    signingIndex: signing ? Number(signing[1]) : undefined,
    signingTotal: signing ? Number(signing[2]) : undefined,
    signingAddress: signing?.[3],
  };
}

export function transactionTypeLabel(type: TransactionType): string {
  switch (type) {
    case TransactionType.Payment:
      return 'ALGO payment';
    case TransactionType.AssetTransfer:
      return 'ASA transfer';
    case TransactionType.AppCall:
      return 'Smart contract call';
    case TransactionType.AssetConfig:
      return 'Asset configuration';
    case TransactionType.AssetFreeze:
      return 'Asset freeze';
    case TransactionType.KeyRegistration:
      return 'Participation key registration';
    case TransactionType.StateProof:
      return 'State proof';
    case TransactionType.Heartbeat:
      return 'Consensus heartbeat';
    default:
      return 'Algorand transaction';
  }
}

/** Plain-language "what moves" summary for a decoded transaction, or null when
 *  there is nothing simple to show (app call / unknown type). */
export function formatValueSummary(summary: TransactionSummary): ValueSummaryData | null {
  if (summary.type === TransactionType.Payment) {
    const pay = summary as Extract<TransactionSummary, { type: TransactionType.Payment }>;
    return { lead: 'Sends', amount: formatAlgo(pay.amount), to: pay.to.toString() };
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

export function getTransactionWarnings(summary: TransactionSummary): string[] {
  const warnings: string[] = [];
  if ('rekeyTo' in summary && summary.rekeyTo) {
    warnings.push(`Rekeys this account to ${summary.rekeyTo.toString()}`);
  }
  if (
    summary.type === TransactionType.Payment &&
    'closeRemainderTo' in summary &&
    summary.closeRemainderTo
  ) {
    warnings.push(`Closes the ALGO account remainder to ${summary.closeRemainderTo.toString()}`);
  }
  if (
    summary.type === TransactionType.AssetTransfer &&
    'closeRemainderTo' in summary &&
    summary.closeRemainderTo
  ) {
    warnings.push(`Closes this asset holding to ${summary.closeRemainderTo.toString()}`);
  }
  if (
    summary.type === TransactionType.AssetTransfer &&
    'assetSender' in summary &&
    summary.assetSender
  ) {
    warnings.push(`Clawback transfer from ${summary.assetSender.toString()}`);
  }
  return warnings;
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
