import { TransactionType } from '@algorandfoundation/algokit-utils/transact';
import type { TransactionSummary } from '@/lib/algorand/transactions';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import {
  deriveOutcomeByThid,
  directionLabel,
  displayHintLabel,
  formatValueSummary,
  isFundMovingRequest,
  isMergedResponse,
  isResponseEnvelope,
  signatureLabel,
} from '@/lib/ac2/messageDisplay';

// Minimal envelope/entry builders — we only populate the fields the helpers read.
const env = (type: string, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ type, body, ...extra }) as unknown as Ac2MessageEntry['envelope'];

const entry = (direction: 'inbound' | 'outbound', envelope: Ac2MessageEntry['envelope']) =>
  ({ direction, envelope }) as unknown as Ac2MessageEntry;

describe('isFundMovingRequest', () => {
  it('is true for an algorand transaction signing request', () => {
    expect(
      isFundMovingRequest(env('ac2/SigningRequest', { sig_hint: 'transaction-algorand' })),
    ).toBe(true);
  });

  it('is false for a non-transaction signing request', () => {
    expect(isFundMovingRequest(env('ac2/SigningRequest', { sig_hint: 'identity' }))).toBe(false);
    expect(isFundMovingRequest(env('ac2/SigningRequest', {}))).toBe(false);
  });

  it('is false for non-signing requests', () => {
    expect(isFundMovingRequest(env('ac2/KeyRequest', { sig_hint: 'transaction-algorand' }))).toBe(
      false,
    );
  });
});

describe('formatValueSummary', () => {
  it('formats a payment in ALGO from microalgos', () => {
    const summary = {
      type: TransactionType.Payment,
      to: { toString: () => 'AAAA' },
      amount: 5_000_000n,
    } as unknown as TransactionSummary;
    expect(formatValueSummary(summary)).toEqual({ lead: 'Sends', amount: '5 ALGO', to: 'AAAA' });
  });

  it('formats an asset transfer with raw base units and asset id', () => {
    const summary = {
      type: TransactionType.AssetTransfer,
      to: { toString: () => 'BBBB' },
      amount: 100n,
      assetId: 31566704n,
    } as unknown as TransactionSummary;
    expect(formatValueSummary(summary)).toEqual({
      lead: 'Transfers',
      amount: '100 (asset 31566704)',
      to: 'BBBB',
    });
  });

  it('returns null for app calls and generic txns', () => {
    expect(
      formatValueSummary({ type: TransactionType.AppCall } as unknown as TransactionSummary),
    ).toBeNull();
  });
});

describe('label helpers', () => {
  it('maps key type to a signature algorithm label', () => {
    expect(signatureLabel('identity')).toBe('Ed25519 (raw)');
    expect(signatureLabel('account')).toBe('Ed25519 (raw)');
    expect(signatureLabel('ed25519')).toBe('Ed25519 (raw)');
    expect(signatureLabel('secp256k1')).toBe('secp256k1');
    expect(signatureLabel(undefined)).toBe('Ed25519 (raw)');
  });

  it('maps display hint to human text', () => {
    expect(displayHintLabel('json')).toBe('JSON');
    expect(displayHintLabel('hex')).toBe('Hex');
    expect(displayHintLabel('text')).toBe('Plain text');
    expect(displayHintLabel(undefined)).toBe('Plain text');
  });

  it('maps direction to wallet-relative text', () => {
    expect(directionLabel('outbound')).toBe('This wallet → peer');
    expect(directionLabel('inbound')).toBe('peer → this wallet');
  });
});

describe('response classification', () => {
  it('detects response envelope types', () => {
    expect(isResponseEnvelope('ac2/SigningResponse')).toBe(true);
    expect(isResponseEnvelope('ac2/SigningRejected')).toBe(true);
    expect(isResponseEnvelope('ac2/KeyResponse')).toBe(true);
    expect(isResponseEnvelope('ac2/SigningRequest')).toBe(false);
  });

  it('treats outbound responses as merged (suppressed) entries', () => {
    expect(isMergedResponse(entry('outbound', env('ac2/SigningResponse')))).toBe(true);
    expect(isMergedResponse(entry('inbound', env('ac2/SigningResponse')))).toBe(false);
    expect(isMergedResponse(entry('outbound', env('ac2/SigningRequest')))).toBe(false);
  });
});

describe('deriveOutcomeByThid', () => {
  it('maps request thid to approved/rejected from outbound responses', () => {
    const messages = [
      entry('outbound', env('ac2/SigningResponse', {}, { thid: 'req-1' })),
      entry('outbound', env('ac2/SigningRejected', {}, { thid: 'req-2' })),
      entry('outbound', env('ac2/KeyResponse', { status: 'approved' }, { thid: 'req-3' })),
      entry('outbound', env('ac2/KeyResponse', { status: 'rejected' }, { thid: 'req-4' })),
      entry('inbound', env('ac2/SigningRequest', {}, { id: 'req-1' })), // ignored
    ];
    const map = deriveOutcomeByThid(messages);
    expect(map.get('req-1')).toBe('approved');
    expect(map.get('req-2')).toBe('rejected');
    expect(map.get('req-3')).toBe('approved');
    expect(map.get('req-4')).toBe('rejected');
    expect(map.size).toBe(4);
  });
});
