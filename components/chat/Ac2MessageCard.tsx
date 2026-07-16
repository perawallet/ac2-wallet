import {
  KeyRequestExplainer,
  OutcomeRow,
  TechnicalDetails,
  TransactionGroupOverview,
} from '@/components/chat/Ac2MessageCard.parts';
import { formatTime } from '@/components/chat/format';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  getTransactionRequestContext,
  isFundMovingRequest,
  transactionTypeLabel,
  type Outcome,
} from '@/lib/ac2/messageDisplay';
import { getTransactionSummary, type TransactionSummary } from '@/lib/algorand/transactions';
import { THEME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import type {
  AC2KeyRequest as KeyRequestMessage,
  AC2SigningRequest as SigningRequestMessage,
} from '@algorandfoundation/ac2-sdk/schema';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';

function formatTimeRemaining(expiresAt: number, now: number): string {
  const remaining = Math.max(0, expiresAt * 1000 - now);
  if (remaining === 0) return 'Expired';
  const totalSecs = Math.ceil(remaining / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `Expires in ${mins}m ${secs}s` : `Expires in ${secs}s`;
}

/** Decode a fund-moving request's payload, swallowing decode errors. */
function tryGetSummary(payload: string): TransactionSummary | null {
  try {
    return getTransactionSummary(payload);
  } catch {
    return null;
  }
}

function TransactionWarning({ isAppCall = false }: { isAppCall?: boolean }) {
  return (
    <View className="flex-row items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 dark:border-amber-800 dark:bg-amber-950/30">
      <MaterialIcons name="warning-amber" size={16} color="#D97706" />
      <Text className="flex-1 text-xs font-semibold text-amber-800 dark:text-amber-300">
        {isAppCall
          ? "Smart contract call. Reject if you don't understand what you're signing."
          : 'You are about to sign a transaction. Only approve if you trust this request.'}
      </Text>
      {isAppCall && <MaterialIcons name="info-outline" size={14} color="#D97706" />}
    </View>
  );
}

interface Ac2MessageCardProps {
  entry: Ac2MessageEntry;
  /** Whether this connection's channel is open (gates the action buttons). */
  isConnected: boolean;
  /** Whether a matching response/rejection has already been sent. */
  actioned: boolean;
  /** Approve/decline result merged onto the request card, when known. */
  outcome?: Outcome;
  approveSigning: (request: SigningRequestMessage) => void;
  rejectSigning: (request: SigningRequestMessage) => void;
  approveKey: (request: KeyRequestMessage) => void;
  rejectKey: (request: KeyRequestMessage) => void;
}

// AC2 protocol message rendered as a plain-language confirmation card. Inbound
// signing / key requests surface Decline/Approve actions until they are actioned
// or expire; once actioned, the outcome replaces the buttons in place.
function Ac2MessageCard({
  entry,
  isConnected,
  actioned,
  outcome,
  approveSigning,
  rejectSigning,
  approveKey,
  rejectKey,
}: Ac2MessageCardProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const isOutbound = entry.direction === 'outbound';
  const req =
    !isOutbound && entry.envelope.type === 'ac2/SigningRequest'
      ? (entry.envelope as SigningRequestMessage)
      : null;
  const keyReq =
    !isOutbound && entry.envelope.type === 'ac2/KeyRequest'
      ? (entry.envelope as KeyRequestMessage)
      : null;
  const actionable = req ?? keyReq;

  // Live countdown; only ticks when a message has an expiry.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const expiresTime = actionable?.expires_time;
    if (!expiresTime) return;
    const expiresAtMs = expiresTime * 1000;
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= expiresAtMs && interval) clearInterval(interval);
    };
    tick();
    interval = setInterval(tick, 1000);
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [actionable?.expires_time]);

  const expired = actionable?.expires_time !== undefined && actionable.expires_time * 1000 < now;

  const fundMoving = req ? isFundMovingRequest(entry.envelope) : false;
  const txnSummary = fundMoving && req ? tryGetSummary(req.body.payload) : null;
  const isAppCall = txnSummary ? 'appId' in txnSummary : false;
  const requestContext =
    fundMoving && req ? getTransactionRequestContext(req.body.description, entry.origin) : null;
  const [appCallInfoVisible, setAppCallInfoVisible] = React.useState(false);

  const cardClass = cn(
    'my-1 self-stretch rounded-xl border border-border bg-card p-3',
    isOutbound ? 'border-r-4 border-r-primary' : 'border-l-4 border-l-primary',
  );

  // Fallback for any non-request entry (e.g. a stray protocol envelope): a
  // minimal card with only the collapsible technical detail.
  if (!req && !keyReq) {
    return (
      <View className={cardClass}>
        <TechnicalDetails envelope={entry.envelope} direction={entry.direction} />
        <Text className="mt-1 self-end text-[10px] text-muted-foreground">
          {formatTime(entry.receivedAt)}
        </Text>
      </View>
    );
  }

  const description = req ? req.body.description : keyReq!.body.for_operation;
  const displayDescription =
    fundMoving && requestContext
      ? requestContext.resourceName
        ? `Review ${
            txnSummary
              ? transactionTypeLabel(txnSummary.type).toLowerCase()
              : 'Algorand transaction'
          } for ${requestContext.resourceName}`
        : (requestContext.purpose ?? 'Review Algorand transaction')
      : description;
  const kind: 'signing' | 'key' = req ? 'signing' : 'key';
  const onApprove = req ? () => approveSigning(req) : () => approveKey(keyReq!);
  const onReject = req ? () => rejectSigning(req) : () => rejectKey(keyReq!);

  return (
    <View className={cardClass}>
      {/* ── Heading: icon + plain-language description ─────── */}
      <View className="flex-row items-start gap-2">
        <MaterialIcons
          name={fundMoving ? 'account-balance-wallet' : 'verified-user'}
          size={22}
          color={palette.primary}
        />
        <Text className="flex-1 text-sm font-medium leading-snug text-foreground">
          {displayDescription}
        </Text>
      </View>

      {/* ── Identity request explainer (key requests only) ──── */}
      {keyReq && <KeyRequestExplainer />}

      {/* ── Transaction warning (legal-approved copy; fund-moving only) ─── */}
      {fundMoving &&
        (isAppCall ? (
          <Pressable
            onPress={() => setAppCallInfoVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Smart contract call warning"
            accessibilityHint="Shows more information about smart contract signing risk"
            className="mt-2 rounded-lg"
          >
            <TransactionWarning isAppCall />
          </Pressable>
        ) : (
          <View
            accessibilityRole="text"
            accessibilityLabel="Transaction warning. You are about to sign a transaction. Only approve if you trust this request."
            className="mt-2"
          >
            <TransactionWarning />
          </View>
        ))}

      {/* ── Value summary (fund-moving) ────────────────────── */}
      {fundMoving && requestContext && txnSummary && (
        <TransactionGroupOverview context={requestContext} txn={txnSummary} />
      )}

      {/* ── Expiry countdown ───────────────────────────────── */}
      {actionable?.expires_time && !outcome && (
        <Text
          className={cn(
            'mt-2 text-[11px] font-semibold',
            expired ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {formatTimeRemaining(actionable.expires_time, now)}
        </Text>
      )}

      {/* ── Actions / outcome ──────────────────────────────── */}
      <View className="mt-2 flex-row items-center justify-end gap-2">
        {outcome ? (
          <OutcomeRow outcome={outcome} kind={kind} />
        ) : actioned ? (
          <Text className="text-xs font-semibold italic text-muted-foreground">Actioned</Text>
        ) : expired ? (
          <Text className="text-xs font-semibold italic text-destructive">Expired</Text>
        ) : (
          <>
            <Button variant="secondary" size="sm" onPress={onReject} disabled={!isConnected}>
              <Text>Decline</Text>
            </Button>
            <Button variant="default" size="sm" onPress={onApprove} disabled={!isConnected}>
              <Text>Approve</Text>
            </Button>
          </>
        )}
      </View>

      {/* ── Technical details (collapsed) ──────────────────── */}
      <TechnicalDetails
        className="mt-2"
        envelope={entry.envelope}
        direction={entry.direction}
        txnSummary={txnSummary}
      />

      <Text className="mt-1 self-end text-[10px] text-muted-foreground">
        {formatTime(entry.receivedAt)}
      </Text>

      {/* ── Smart contract info modal ─────────────────────── */}
      <Modal
        visible={appCallInfoVisible}
        onClose={() => setAppCallInfoVisible(false)}
        title="Smart Contract Call"
        titleIcon={<MaterialIcons name="warning" size={20} color="#D97706" />}
      >
        <Text className="text-sm leading-relaxed text-foreground">
          Smart contracts can do anything their code says, including draining your assets if the
          contract is malicious. Where possible the Wallet shows the action in plain language. If
          the data appears as raw JSON below, do not approve unless you understand what you are
          signing.
        </Text>
      </Modal>
    </View>
  );
}

export { Ac2MessageCard };
