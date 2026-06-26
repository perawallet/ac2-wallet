import {
  Transaction,
  TransactionType,
  decodeTransaction,
} from '@algorandfoundation/algokit-utils/transact';

type Address = Transaction['sender'];

type BaseSummary = {
  type: TransactionType;
  from: Address;
  note: Uint8Array | undefined;
  fee: bigint;
};

export type ApplTransactionSummary = BaseSummary & {
  type: TransactionType.AppCall;
  appId: bigint;
  args: Uint8Array[] | undefined;
};

export type PayTransactionSummary = BaseSummary & {
  type: TransactionType.Payment;
  to: Address;
  amount: bigint;
};

export type AxferTransactionSummary = BaseSummary & {
  type: TransactionType.AssetTransfer;
  to: Address;
  amount: bigint;
  assetId: bigint;
};

export type GenericTransactionSummary = {
  type: TransactionType;
  note: Uint8Array | undefined;
  fee: bigint | undefined;
};

export type TransactionSummary =
  | ApplTransactionSummary
  | PayTransactionSummary
  | AxferTransactionSummary
  | GenericTransactionSummary;

/**
 * Decodes a base64-encoded unsigned Algorand transaction (msgpack format) into a human-readable summary.
 *
 * Returns a discriminated union typed by `type` — {@link TransactionType.AppCall}, {@link TransactionType.Payment},
 * and {@link TransactionType.AssetTransfer} carry transaction-specific fields; all other types return a {@link GenericTransactionSummary}.
 *
 * @param encoded - Base64-encoded unsigned Algorand transaction in msgpack format.
 * @returns A {@link TransactionSummary} discriminated by transaction type.
 */
export function getTransactionSummary(encoded: string): TransactionSummary {
  const txn = decodeTransaction(Buffer.from(encoded, 'base64'));
  const base = { type: txn.type, from: txn.sender, note: txn.note, fee: txn.fee! };

  if (txn.type === TransactionType.AppCall) {
    return {
      ...base,
      type: TransactionType.AppCall,
      appId: txn.appCall!.appId,
      args: txn.appCall!.args,
    };
  }
  if (txn.type === TransactionType.Payment) {
    return {
      ...base,
      type: TransactionType.Payment,
      to: txn.payment!.receiver,
      amount: txn.payment!.amount,
    };
  }
  if (txn.type === TransactionType.AssetTransfer) {
    return {
      ...base,
      type: TransactionType.AssetTransfer,
      to: txn.assetTransfer!.receiver,
      amount: txn.assetTransfer!.amount,
      assetId: txn.assetTransfer!.assetId,
    };
  }

  return { type: txn.type, note: txn.note, fee: txn.fee };
}
