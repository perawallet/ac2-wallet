import { ChatComposer } from '@/components/chat/ChatComposer';
import { ChatTimeline, type TimelineEntry } from '@/components/chat/ChatTimeline';
import { ConnectionStatusBar } from '@/components/chat/ConnectionStatusBar';
import { ThreadBar } from '@/components/chat/ThreadBar';
import { useAc2Responders } from '@/hooks/useAc2Responders';
import { useConnection } from '@/hooks/useConnection';
import { DEFAULT_THID } from '@/lib/ac2';
import { ac2MessagesStore, clearAc2Messages } from '@/stores/ac2Messages';
import { clearMessages, messagesStore } from '@/stores/messages';
import { setActiveThid } from '@/stores/ui';
import { useStore } from '@tanstack/react-store';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { KeyboardAvoidingView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Height of the header sitting above the chat content in both consumers: the
// tab's `AppHeader` and the `/session` route's custom header are each an `h-14`
// (56px) row. Combined with the top safe-area inset it gives the offset the
// keyboard-avoiding view needs to position the composer correctly.
const HEADER_HEIGHT = 56;

interface ChatScreenProps {
  origin: string;
  requestId: string;
}

function ChatScreen({ origin, requestId }: ChatScreenProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    isConnected,
    isError,
    send,
    sendAc2,
    lastHeartbeat,
    reset,
    address,
    activeStreamText,
    agentPresence,
    agentPresenceDetail,
    activeThid,
    openConversation,
    closeConversation,
    remoteThreads,
  } = useConnection(origin, requestId);

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
      if (t === 'ac2/SigningResponse' || t === 'ac2/SigningRejected' || t === 'ac2/KeyResponse') {
        if (m.envelope.thid) set.add(m.envelope.thid);
      }
    }
    return set;
  }, [ac2Messages]);

  const timeline: TimelineEntry[] = React.useMemo(() => {
    const entries: TimelineEntry[] = [
      ...textMessages.map(
        (m): TimelineEntry => ({ kind: 'text', id: `t-${m.id}`, timestamp: m.timestamp, data: m }),
      ),
      ...threadAc2Messages.map(
        (m): TimelineEntry => ({ kind: 'ac2', id: `a-${m.id}`, timestamp: m.receivedAt, data: m }),
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

  const handleDisconnect = () => {
    reset();
    router.back();
  };

  const handleClear = () => {
    if (address) clearMessages(address, origin, requestId);
    clearAc2Messages(address || '', origin, requestId);
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior="padding"
      keyboardVerticalOffset={insets.top + HEADER_HEIGHT}
    >
      <ConnectionStatusBar
        isConnected={isConnected}
        isError={isError}
        heartbeatVisible={heartbeatVisible}
        onClear={handleClear}
        onDisconnect={handleDisconnect}
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
          approveSigning={approveSigning}
          rejectSigning={rejectSigning}
          approveKey={approveKey}
          rejectKey={rejectKey}
        />
      </View>
      <ChatComposer
        onSend={send}
        enabled={isConnected}
        placeholder={isConnected ? 'Message' : 'Connecting…'}
      />
    </KeyboardAvoidingView>
  );
}

export { ChatScreen };
