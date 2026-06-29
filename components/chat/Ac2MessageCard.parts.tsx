import { RawContentViewer } from '@/components/ui/RawContentViewer';
import { Text } from '@/components/ui/text';
import {
  directionLabel,
  displayHintLabel,
  signatureLabel,
  type Outcome,
  type ValueSummaryData,
} from '@/lib/ac2/messageDisplay';
import type { TransactionSummary } from '@/lib/algorand/transactions';
import { cn } from '@/lib/utils';
import type { Ac2Direction, Ac2MessageEntry } from '@/stores/ac2Messages';
import { truncateAddress } from '@/utils/format';
import { MaterialIcons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, View } from 'react-native';

/** Decoded transaction field rows (From / To / Amount / Asset / App). */
export function TxnDetails({ txn }: { txn: TransactionSummary }) {
  const from = 'from' in txn ? txn.from.toString() : undefined;
  const to = 'to' in txn ? txn.to.toString() : undefined;
  const amount = 'amount' in txn ? txn.amount : undefined;
  const assetId = 'assetId' in txn ? txn.assetId : undefined;
  const appId = 'appId' in txn ? txn.appId : undefined;
  return (
    <View className="gap-1">
      {from && <Row label="From:" value={truncateAddress(from, 8, 8)} mono />}
      {to && <Row label="To:" value={truncateAddress(to, 8, 8)} mono />}
      {amount !== undefined && <Row label="Amount:" value={amount.toLocaleString()} mono />}
      {assetId !== undefined && <Row label="Asset:" value={assetId.toString()} mono />}
      {appId !== undefined && <Row label="App:" value={appId.toString()} mono />}
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View className="flex-row items-start gap-2">
      <Text className="w-12 text-xs font-medium text-slate-500 dark:text-slate-400">{label}</Text>
      <Text className={cn('flex-1 text-xs text-foreground', mono && 'font-mono')}>{value}</Text>
    </View>
  );
}

/** Plain-language "what moves" block for fund-moving transactions. */
export function ValueSummary({ summary }: { summary: ValueSummaryData }) {
  return (
    <View className="gap-1 rounded-lg border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-700 dark:bg-slate-900/30">
      <View className="flex-row items-center gap-2">
        <Text className="w-14 text-xs font-medium text-slate-500 dark:text-slate-400">
          {summary.lead}
        </Text>
        <Text className="flex-1 text-sm font-semibold text-foreground">{summary.amount}</Text>
      </View>
      {summary.to && (
        <View className="flex-row items-center gap-2">
          <Text className="w-14 text-xs font-medium text-slate-500 dark:text-slate-400">To</Text>
          <Text className="flex-1 font-mono text-xs text-foreground">
            {truncateAddress(summary.to, 6, 6)}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Post-action result row that replaces the Approve/Decline buttons. */
export function OutcomeRow({ outcome, kind }: { outcome: Outcome; kind: 'signing' | 'key' }) {
  if (outcome === 'approved') {
    return (
      <View className="flex-row items-center gap-1.5">
        <MaterialIcons name="check-circle" size={16} color="#10B981" />
        <Text className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
          {kind === 'key' ? 'Identity granted' : 'Signed'}
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-row items-center gap-1.5">
      <MaterialIcons name="cancel" size={16} color="#94A3B8" />
      <Text className="text-sm font-semibold text-muted-foreground">Declined</Text>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-start justify-between gap-3 px-3 py-2">
      <Text className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</Text>
      <Text className="flex-1 text-right font-mono text-xs text-foreground">{value}</Text>
    </View>
  );
}

interface TechnicalDetailsProps {
  envelope: Ac2MessageEntry['envelope'];
  direction: Ac2Direction;
  txnSummary?: TransactionSummary | null;
  className?: string;
}

/** Collapsible protocol/technical detail: a key/value table + raw JSON. */
export function TechnicalDetails({
  envelope,
  direction,
  txnSummary,
  className,
}: TechnicalDetailsProps) {
  const [open, setOpen] = React.useState(false);
  const body = (envelope.body ?? {}) as { key_type?: string; display_hint?: string };
  return (
    <View className={className}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        className="flex-row items-center gap-1.5 py-1"
      >
        <MaterialIcons name="info-outline" size={14} color="#94A3B8" />
        <Text className="flex-1 text-xs font-medium text-muted-foreground">
          {open ? 'Hide technical details' : 'View technical details'}
        </Text>
        <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={16} color="#94A3B8" />
      </Pressable>
      {open && (
        <View className="mt-1 gap-2">
          <View className="divide-y divide-border rounded-lg border border-border">
            <DetailRow label="Request type" value={envelope.type} />
            {body.key_type && <DetailRow label="Signing key" value={body.key_type} />}
            <DetailRow label="Signature" value={signatureLabel(body.key_type)} />
            {body.display_hint && (
              <DetailRow label="Shown as" value={displayHintLabel(body.display_hint)} />
            )}
            <DetailRow label="Direction" value={directionLabel(direction)} />
          </View>
          {txnSummary && (
            <View className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-700 dark:bg-slate-900/30">
              <Text className="mb-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">
                Transaction details
              </Text>
              <TxnDetails txn={txnSummary} />
            </View>
          )}
          <RawContentViewer
            contentType="json"
            content={JSON.stringify(envelope.body, null, 2)}
          />
        </View>
      )}
    </View>
  );
}
