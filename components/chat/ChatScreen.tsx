import { Modal } from '@/components/Modal';
import { ChatComposer } from '@/components/chat/ChatComposer';
import { ChatTimeline, type TimelineEntry } from '@/components/chat/ChatTimeline';
import { ConnectionStatusBar } from '@/components/chat/ConnectionStatusBar';
import { ReconnectBar } from '@/components/chat/ReconnectBar';
import { ThreadBar } from '@/components/chat/ThreadBar';
import { Text } from '@/components/ui/text';
import { useAc2Responders } from '@/hooks/useAc2Responders';
import { useConnection } from '@/hooks/useConnection';
import { DEFAULT_THID } from '@/lib/ac2';
import { THEME } from '@/lib/theme';
import {
  deriveOutcomeByThid,
  isMergedResponse,
  isResponseEnvelope,
} from '@/lib/ac2/messageDisplay';
import {
  ac2MessagesStore,
  clearAc2Messages,
  clearAc2MessagesByConnection,
} from '@/stores/ac2Messages';
import { clearAgentIdentitiesByConnection } from '@/stores/agentIdentities';
import { clearMessages, clearMessagesByConnection, messagesStore } from '@/stores/messages';
import { removeSession, renameSession } from '@/stores/sessions';
import { clearCurrentConnection, setActiveThid } from '@/stores/ui';
import { useHeaderHeight } from '@react-navigation/elements';
import { useStore } from '@tanstack/react-store';
import * as React from 'react';
import { useColorScheme } from 'nativewind';
import { Alert, KeyboardAvoidingView, Pressable, TextInput, View } from 'react-native';

interface ChatScreenProps {
  origin: string;
  requestId: string;
  allowPasskeyCreation?: boolean;
  onPasskeyCreationConsumed?: () => void;
}

function ChatScreen({
  origin,
  requestId,
  allowPasskeyCreation = false,
  onPasskeyCreationConsumed,
}: ChatScreenProps) {
  // The tab header can grow when the backup reminder is visible. Reading the
  // measured navigation header keeps the keyboard offset in sync with its
  // actual height instead of assuming only the 56pt AppHeader is present.
  const headerHeight = useHeaderHeight();
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const {
    isConnected,
    isError,
    isLoading,
    isReconnecting,
    reconnectAttempt,
    send,
    sendAc2,
    lastHeartbeat,
    reset,
    reconnect,
    session,
    address,
    activeStreamText,
    agentPresence,
    agentPresenceDetail,
    activeThid,
    openConversation,
    closeConversation,
    remoteThreads,
  } = useConnection(origin, requestId, {
    allowPasskeyCreation,
    onPasskeyCreationConsumed,
  });

  const { approveSigning, rejectSigning, approveKey, rejectKey } = useAc2Responders({
    address,
    sendAc2,
    origin,
    requestId,
  });

  // All chat messages on this connection across every conversation thread —
  // used to derive the thread switcher. Legacy messages carry no `thid` and are
  // treated as the `default` thread.
  const connectionTextMessages = useStore(messagesStore, (state) =>
    state.messages.filter(
      (m) =>
        m.origin === origin &&
        m.requestId === requestId &&
        (address ? m.address === address : true),
    ),
  );

  // Only the active conversation's messages are shown in the timeline.
  const textMessages = React.useMemo(
    () => connectionTextMessages.filter((m) => (m.thid ?? DEFAULT_THID) === activeThid),
    [connectionTextMessages, activeThid],
  );

  // The set of conversation threads on this connection (most-recent first),
  // always including the active thread and the default thread so the switcher
  // can render them even before any message has landed.
  const threads = React.useMemo(() => {
    const lastSeen = new Map<string, number>();
    for (const m of connectionTextMessages) {
      const t = m.thid ?? DEFAULT_THID;
      const prev = lastSeen.get(t) ?? 0;
      if (m.timestamp > prev) lastSeen.set(t, m.timestamp);
    }
    // Merge in threads the agent reported it already holds (a reconnecting /
    // fresh controller may have no local messages for them yet).
    for (const rt of remoteThreads) {
      if (!lastSeen.has(rt.thid)) lastSeen.set(rt.thid, rt.updatedAt ?? 0);
    }
    if (!lastSeen.has(DEFAULT_THID)) lastSeen.set(DEFAULT_THID, 0);
    if (!lastSeen.has(activeThid)) lastSeen.set(activeThid, Date.now());
    return Array.from(lastSeen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([thid]) => thid);
  }, [connectionTextMessages, activeThid, remoteThreads]);

  // All AC2 protocol envelopes on this connection across every conversation
  // thread — used to derive request/response "actioned" state, which is keyed
  // by the envelope's own `thid` (request id) and so is thread-independent.
  const ac2Messages = useStore(ac2MessagesStore, (state) =>
    state.messages.filter((m) => m.origin === origin && m.requestId === requestId),
  );

  // Only the active conversation's AC2 envelopes are shown in the timeline.
  const threadAc2Messages = React.useMemo(
    () => ac2Messages.filter((m) => (m.thid ?? DEFAULT_THID) === activeThid),
    [ac2Messages, activeThid],
  );

  // A request is "actioned" once we have a matching outbound response/rejection
  // on the same `thid` (the SDK builders thread `thid = request.id`). Derived
  // from the persisted ac2 store so it survives reloads.
  const actionedRequestIds = React.useMemo(() => {
    const set = new Set<string>();
    for (const m of ac2Messages) {
      if (m.direction !== 'outbound') continue;
      const t = m.envelope.type;
      if (isResponseEnvelope(t)) {
        if (m.envelope.thid) set.add(m.envelope.thid);
      }
    }
    return set;
  }, [ac2Messages]);

  // Approve/decline outcomes keyed by request id (response.thid === request.id).
  // Derived from the full connection history so it survives reloads.
  const outcomeByThid = React.useMemo(() => deriveOutcomeByThid(ac2Messages), [ac2Messages]);

  const timeline: TimelineEntry[] = React.useMemo(() => {
    const entries: TimelineEntry[] = [
      ...textMessages.map(
        (m): TimelineEntry => ({ kind: 'text', id: `t-${m.id}`, timestamp: m.timestamp, data: m }),
      ),
      ...threadAc2Messages
        .filter((m) => !isMergedResponse(m))
        .map(
          (m): TimelineEntry => ({
            kind: 'ac2',
            id: `a-${m.id}`,
            timestamp: m.receivedAt,
            data: m,
          }),
        ),
    ].sort((a, b) => a.timestamp - b.timestamp);

    // While the agent is working, render an ephemeral indicator instead of a
    // final bubble. Driven by presence frames, falling back to `typing`
    // whenever partial stream text exists.
    const presence = activeStreamText ? 'typing' : agentPresence;
    if (presence) {
      entries.push({
        kind: 'typing',
        id: 'active-stream',
        timestamp: Date.now(),
        text: activeStreamText,
        presence,
        detail: agentPresenceDetail,
      });
    }
    return entries;
  }, [textMessages, threadAc2Messages, activeStreamText, agentPresence, agentPresenceDetail]);

  const [heartbeatVisible, setHeartbeatVisible] = React.useState(false);
  React.useEffect(() => {
    if (isConnected) {
      setHeartbeatVisible(true);
      const timer = setTimeout(() => setHeartbeatVisible(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [lastHeartbeat, isConnected]);

  // Keep the History modal in sync with the active thread.
  React.useEffect(() => {
    setActiveThid(activeThid);
    return () => setActiveThid(null);
  }, [activeThid]);

  const [renameVisible, setRenameVisible] = React.useState(false);
  const [renameText, setRenameText] = React.useState('');

  const handleRename = React.useCallback(() => {
    setRenameText(session?.name ?? '');
    setRenameVisible(true);
  }, [session?.name]);

  const commitRename = () => {
    if (renameText.trim()) renameSession(requestId, origin, renameText.trim());
    setRenameVisible(false);
  };

  const handleDisconnect = React.useCallback(() => {
    Alert.alert('Disconnect?', 'Close the connection to this agent? You can reconnect later.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: reset },
    ]);
  }, [reset]);

  const handleClear = React.useCallback(() => {
    Alert.alert('Clear conversation?', 'This will remove all messages from this connection.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          if (address) {
            clearMessages(address, origin, requestId);
            clearAc2Messages(address, origin, requestId);
          } else {
            clearMessagesByConnection(origin, requestId);
            clearAc2MessagesByConnection(origin, requestId);
          }
        },
      },
    ]);
  }, [origin, requestId, address]);

  const handleForget = React.useCallback(() => {
    Alert.alert(
      'Forget connection?',
      'This permanently removes all messages, agent identities, and session data for this connection.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: () => {
            clearMessagesByConnection(origin, requestId);
            clearAc2MessagesByConnection(origin, requestId);
            clearAgentIdentitiesByConnection(origin, requestId);
            removeSession(requestId, origin);
            clearCurrentConnection();
            reset();
          },
        },
      ],
    );
  }, [origin, requestId, reset]);

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <ConnectionStatusBar
        isConnected={isConnected}
        isError={isError}
        heartbeatVisible={heartbeatVisible}
        onRename={handleRename}
        onClear={handleClear}
        onDisconnect={handleDisconnect}
        onForget={handleForget}
      >
        <ThreadBar
          threads={threads}
          activeThid={activeThid}
          remoteThreads={remoteThreads}
          isConnected={isConnected}
          onOpen={(thid) => openConversation(thid)}
          onClose={closeConversation}
        />
      </ConnectionStatusBar>
      <View className="flex-1">
        <ChatTimeline
          timeline={timeline}
          isConnected={isConnected}
          actionedRequestIds={actionedRequestIds}
          outcomeByThid={outcomeByThid}
          approveSigning={approveSigning}
          rejectSigning={rejectSigning}
          approveKey={approveKey}
          rejectKey={rejectKey}
        />
      </View>
      {isConnected ? (
        <ChatComposer onSend={send} enabled placeholder="Message" />
      ) : isReconnecting ? (
        <ChatComposer
          onSend={send}
          enabled={false}
          placeholder={
            reconnectAttempt > 0 ? `Reconnecting (attempt ${reconnectAttempt})…` : 'Reconnecting…'
          }
        />
      ) : isLoading ? (
        <ChatComposer onSend={send} enabled={false} placeholder="Connecting…" />
      ) : (
        <ReconnectBar onReconnect={reconnect} isError={isError} />
      )}
      <Modal
        visible={renameVisible}
        onClose={() => setRenameVisible(false)}
        title="Rename connection"
      >
        <TextInput
          className="rounded-lg border border-border bg-background px-3 py-2 text-foreground"
          value={renameText}
          onChangeText={setRenameText}
          placeholder="Display name"
          placeholderTextColor={palette.mutedForeground}
          returnKeyType="done"
          onSubmitEditing={commitRename}
        />
        <View className="mt-4 flex-row justify-end gap-3">
          <Pressable onPress={() => setRenameVisible(false)} className="px-4 py-2">
            <Text className="text-muted-foreground">Cancel</Text>
          </Pressable>
          <Pressable onPress={commitRename} className="rounded-lg bg-primary px-4 py-2">
            <Text className="font-medium text-primary-foreground">Save</Text>
          </Pressable>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

export { ChatScreen };
