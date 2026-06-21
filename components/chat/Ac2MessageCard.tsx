import { formatTime } from '@/components/chat/format';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import type {
  AC2KeyRequest as KeyRequestMessage,
  AC2SigningRequest as SigningRequestMessage,
} from '@algorandfoundation/ac2-sdk/schema';
import { MaterialIcons } from '@expo/vector-icons';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

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
  const expired =
    actionable?.expires_time !== undefined && actionable.expires_time * 1000 < Date.now();

  return (
    <View
      className={cn(
        'my-1 self-stretch rounded-xl border border-border bg-white p-3 dark:bg-slate-800',
        isOutbound ? 'border-r-4 border-r-primary' : 'border-l-4 border-l-primary',
      )}
    >
      <View className="flex-row items-center gap-1.5">
        <MaterialIcons name="vpn-key" size={14} color="#6366F1" />
        <Text className="flex-1 font-mono text-xs font-bold text-primary">
          {entry.envelope.type}
        </Text>
        <Text className="text-[11px] font-semibold text-primary">
          {isOutbound ? '→ peer' : 'peer →'}
        </Text>
      </View>

      {req && (
        <Text className="mb-1.5 mt-1.5 text-sm font-medium text-foreground">
          {req.body.description}
        </Text>
      )}
      {keyReq && (
        <Text className="mb-1.5 mt-1.5 text-sm font-medium text-foreground">
          The agent is requesting an identity key ({keyReq.body.key_type}) for{' '}
          {keyReq.body.for_operation}.
        </Text>
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="mt-1 rounded-lg bg-slate-800 p-2 dark:bg-slate-950"
      >
        <Text className="font-mono text-[11px] leading-4 text-emerald-400">
          {JSON.stringify(entry.envelope.body, null, 2)}
        </Text>
      </ScrollView>

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
