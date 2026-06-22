import { formatTime } from '@/components/chat/format';
import { Button } from '@/components/ui/button';
import { RawContentViewer } from '@/components/ui/RawContentViewer';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import type {
  AC2KeyRequest as KeyRequestMessage,
  AC2KeyResponse as KeyResponseMessage,
  AC2SigningRejected as SigningRejectedMessage,
  AC2SigningRequest as SigningRequestMessage,
  AC2SigningResponse as SigningResponseMessage,
} from '@algorandfoundation/ac2-sdk/schema';
import { MaterialIcons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';

// Compact label chip used across type-specific summary rows.
function Badge({ label }: { label: string }) {
  return (
    <View className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-700">
      <Text className="text-[10px] font-medium text-slate-600 dark:text-slate-300">{label}</Text>
    </View>
  );
}

function formatTimeRemaining(expiresAt: number, now: number): string {
  const remaining = Math.max(0, expiresAt * 1000 - now);
  if (remaining === 0) return 'Expired';
  const totalSecs = Math.ceil(remaining / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `Expires in ${mins}m ${secs}s` : `Expires in ${secs}s`;
}

interface Ac2MessageCardProps {
  entry: Ac2MessageEntry;
  /** Whether this connection's channel is open (gates the action buttons). */
  isConnected: boolean;
  /** Whether a matching response/rejection has already been sent. */
  actioned: boolean;
  approveSigning: (request: SigningRequestMessage) => void;
  rejectSigning: (request: SigningRequestMessage) => void;
  approveKey: (request: KeyRequestMessage) => void;
  rejectKey: (request: KeyRequestMessage) => void;
}

// AC2 protocol message — rendered as a distinct, monospaced card so the
// protocol surface is visually obvious in the reference UI. Inbound signing /
// key requests surface approve/reject actions until they are actioned or expire.
function Ac2MessageCard({
  entry,
  isConnected,
  actioned,
  approveSigning,
  rejectSigning,
  approveKey,
  rejectKey,
}: Ac2MessageCardProps) {
  const isOutbound = entry.direction === 'outbound';
  const isInboundSigningRequest = !isOutbound && entry.envelope.type === 'ac2/SigningRequest';
  const isInboundKeyRequest = !isOutbound && entry.envelope.type === 'ac2/KeyRequest';
  const req = isInboundSigningRequest ? (entry.envelope as SigningRequestMessage) : null;
  const keyReq = isInboundKeyRequest ? (entry.envelope as KeyRequestMessage) : null;
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

  // Outbound response/rejection casts.
  const sigResponse =
    entry.envelope.type === 'ac2/SigningResponse'
      ? (entry.envelope as SigningResponseMessage)
      : null;
  const sigRejected =
    entry.envelope.type === 'ac2/SigningRejected'
      ? (entry.envelope as SigningRejectedMessage)
      : null;
  const keyResponse =
    entry.envelope.type === 'ac2/KeyResponse' ? (entry.envelope as KeyResponseMessage) : null;

  return (
    <View
      className={cn(
        'my-1 self-stretch rounded-xl border border-border bg-white p-3 dark:bg-slate-800',
        isOutbound ? 'border-r-4 border-r-primary' : 'border-l-4 border-l-primary',
      )}
    >
      {/* ── Header ────────────────────────────────────────── */}
      <View className="flex-row items-center gap-1.5">
        <MaterialIcons name="vpn-key" size={14} color="#6366F1" />
        <Text className="flex-1 font-mono text-xs font-bold text-primary">
          {entry.envelope.type}
        </Text>
        <Text className="text-[11px] font-semibold text-primary">
          {isOutbound ? '→ peer' : 'peer →'}
        </Text>
      </View>

      {/* ── ac2/SigningRequest ─────────────────────────────── */}
      {req && (
        <View className="mt-2 gap-1.5">
          <Text className="text-sm font-medium text-foreground">{req.body.description}</Text>
          <View className="flex-row flex-wrap gap-1">
            <Badge label={`key: ${req.body.key_type ?? 'account'}`} />
            {req.body.sig_hint && <Badge label={req.body.sig_hint} />}
            {req.body.display_hint && <Badge label={`display: ${req.body.display_hint}`} />}
          </View>
          {actionable?.expires_time && (
            <Text
              className={cn(
                'text-[11px] font-semibold',
                expired ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {formatTimeRemaining(actionable.expires_time, now)}
            </Text>
          )}
        </View>
      )}

      {/* ── ac2/KeyRequest ────────────────────────────────── */}
      {keyReq && (
        <View className="mt-2 gap-1.5">
          <Text className="text-sm font-medium text-foreground">{keyReq.body.for_operation}</Text>
          <View className="flex-row flex-wrap gap-1">
            <Badge label={keyReq.body.key_type} />
            {keyReq.body.purpose.map((p) => (
              <Badge key={p} label={p} />
            ))}
            {keyReq.body.derivation_path && (
              <Badge label={`path: ${keyReq.body.derivation_path}`} />
            )}
          </View>
          {actionable?.expires_time && (
            <Text
              className={cn(
                'text-[11px] font-semibold',
                expired ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {formatTimeRemaining(actionable.expires_time, now)}
            </Text>
          )}
        </View>
      )}

      {/* ── ac2/SigningResponse ───────────────────────────── */}
      {sigResponse && (
        <View className="mt-2 gap-1.5">
          <View className="flex-row items-center gap-1.5">
            <MaterialIcons name="check-circle" size={14} color="#10B981" />
            <Text className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              Signed
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-1">
            {sigResponse.body.key_type && <Badge label={`key: ${sigResponse.body.key_type}`} />}
            <Badge label={`${sigResponse.body.public_key.slice(0, 16)}…`} />
            {sigResponse.body.address && (
              <Badge label={`${sigResponse.body.address.slice(0, 12)}…`} />
            )}
          </View>
        </View>
      )}

      {/* ── ac2/SigningRejected ───────────────────────────── */}
      {sigRejected && (
        <View className="mt-2 gap-1">
          <View className="flex-row items-center gap-1.5">
            <MaterialIcons name="cancel" size={14} color="#EF4444" />
            <Text className="text-sm font-semibold text-destructive">Rejected</Text>
          </View>
          <Text className="text-xs text-muted-foreground">{sigRejected.body.reason}</Text>
        </View>
      )}

      {/* ── ac2/KeyResponse ───────────────────────────────── */}
      {keyResponse && (
        <View className="mt-2 gap-1.5">
          <View className="flex-row items-center gap-1.5">
            {keyResponse.body.status === 'approved' ? (
              <>
                <MaterialIcons name="check-circle" size={14} color="#10B981" />
                <Text className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                  Key Granted
                </Text>
              </>
            ) : (
              <>
                <MaterialIcons name="cancel" size={14} color="#EF4444" />
                <Text className="text-sm font-semibold text-destructive">Key Rejected</Text>
              </>
            )}
          </View>
          <View className="flex-row flex-wrap gap-1">
            <Badge label={keyResponse.body.key_type} />
            {keyResponse.body.status === 'approved' && (
              <Badge label={`${keyResponse.body.public_key.slice(0, 16)}…`} />
            )}
          </View>
          {keyResponse.body.status === 'rejected' && keyResponse.body.reason && (
            <Text className="text-xs text-muted-foreground">{keyResponse.body.reason}</Text>
          )}
        </View>
      )}

      {/* ── JSON body viewer ─────────────────────────────── */}
      <RawContentViewer
        className="mt-2"
        contentType="json"
        content={JSON.stringify(entry.envelope.body, null, 2)}
      />

      {req && (
        <View className="mt-2 flex-row justify-end gap-2">
          {actioned ? (
            <Text className="text-xs font-semibold italic text-muted-foreground">Actioned</Text>
          ) : expired ? (
            <Text className="text-xs font-semibold italic text-destructive">Expired</Text>
          ) : (
            <>
              <Button
                variant="destructive"
                size="sm"
                onPress={() => rejectSigning(req)}
                disabled={!isConnected}
              >
                <MaterialIcons name="close" size={14} color="#fff" />
                <Text>Reject</Text>
              </Button>
              <Button
                variant="default"
                size="sm"
                onPress={() => approveSigning(req)}
                disabled={!isConnected}
              >
                <MaterialIcons name="check" size={14} color="#fff" />
                <Text>Approve & Sign</Text>
              </Button>
            </>
          )}
        </View>
      )}

      {keyReq && (
        <View className="mt-2 flex-row justify-end gap-2">
          {actioned ? (
            <Text className="text-xs font-semibold italic text-muted-foreground">Actioned</Text>
          ) : expired ? (
            <Text className="text-xs font-semibold italic text-destructive">Expired</Text>
          ) : (
            <>
              <Button
                variant="destructive"
                size="sm"
                onPress={() => rejectKey(keyReq)}
                disabled={!isConnected}
              >
                <MaterialIcons name="close" size={14} color="#fff" />
                <Text>Reject</Text>
              </Button>
              <Button
                variant="default"
                size="sm"
                onPress={() => approveKey(keyReq)}
                disabled={!isConnected}
              >
                <MaterialIcons name="check" size={14} color="#fff" />
                <Text>Grant Identity</Text>
              </Button>
            </>
          )}
        </View>
      )}

      <Text className="mt-1 self-end text-[10px] text-muted-foreground">
        {formatTime(entry.receivedAt)}
      </Text>
    </View>
  );
}

export { Ac2MessageCard };
