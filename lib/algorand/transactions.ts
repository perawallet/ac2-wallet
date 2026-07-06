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
  group?: Uint8Array;
  genesisId?: string;
  rekeyTo?: Address;
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
  closeRemainderTo?: Address;
};

export type AxferTransactionSummary = BaseSummary & {
  type: TransactionType.AssetTransfer;
  to: Address;
  amount: bigint;
  assetId: bigint;
  assetSender?: Address;
  closeRemainderTo?: Address;
};

export type GenericTransactionSummary = {
  type: TransactionType;
  from?: Address;
  note: Uint8Array | undefined;
  fee: bigint | undefined;
  group?: Uint8Array;
  genesisId?: string;
  rekeyTo?: Address;
  fields?: Record<string, string>;
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
  const base = {
    type: txn.type,
    from: txn.sender,
    note: txn.note,
    fee: txn.fee!,
    group: txn.group,
    genesisId: txn.genesisId,
    rekeyTo: txn.rekeyTo,
  };

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
      closeRemainderTo: txn.payment!.closeRemainderTo,
    };
  }
  if (txn.type === TransactionType.AssetTransfer) {
    return {
      ...base,
      type: TransactionType.AssetTransfer,
      to: txn.assetTransfer!.receiver,
      amount: txn.assetTransfer!.amount,
      assetId: txn.assetTransfer!.assetId,
      assetSender: txn.assetTransfer!.assetSender,
      closeRemainderTo: txn.assetTransfer!.closeRemainderTo,
    };
  }
  if (txn.type === TransactionType.AssetConfig) {
    const cfg = txn.assetConfig;
    return {
      ...base,
      fields: {
        action:
          cfg?.assetId === 0n
            ? 'Create asset'
            : cfg?.total
              ? 'Reconfigure asset'
              : 'Destroy or update asset',
        asset: cfg?.assetId?.toString() ?? 'new',
        unit: cfg?.unitName ?? '',
        name: cfg?.assetName ?? '',
        total: cfg?.total?.toString() ?? '',
      },
    };
  }
  if (txn.type === TransactionType.AssetFreeze) {
    const freeze = txn.assetFreeze;
    return {
      ...base,
      fields: {
        asset: freeze?.assetId?.toString() ?? '',
        target: freeze?.freezeTarget?.toString() ?? '',
        status: freeze?.frozen ? 'Freeze holdings' : 'Unfreeze holdings',
      },
    };
  }
  if (txn.type === TransactionType.KeyRegistration) {
    return {
      ...base,
      fields: {
        action: txn.keyRegistration?.nonParticipation
          ? 'Mark offline / non-participating'
          : 'Register participation keys',
      },
    };
  }

  return {
    type: txn.type,
    from: txn.sender,
    note: txn.note,
    fee: txn.fee,
    group: txn.group,
    genesisId: txn.genesisId,
    rekeyTo: txn.rekeyTo,
  };
}
