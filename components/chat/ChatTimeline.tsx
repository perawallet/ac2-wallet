import { Ac2MessageCard } from '@/components/chat/Ac2MessageCard';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { ToolActivityCard } from '@/components/chat/ToolActivityCard';
import { TypingIndicator, type AgentPresence } from '@/components/chat/TypingIndicator';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import type { Message } from '@/stores/messages';
import type {
  AC2KeyRequest as KeyRequestMessage,
  AC2SigningRequest as SigningRequestMessage,
} from '@algorandfoundation/ac2-sdk/schema';
import * as React from 'react';
import { FlatList } from 'react-native';

// Unified timeline entry — keeps free-text chat and AC2 protocol messages in
// the same scroll view while preserving their distinct typing/rendering.
export type TimelineEntry =
  | { kind: 'text'; id: string; timestamp: number; data: Message }
  | { kind: 'ac2'; id: string; timestamp: number; data: Ac2MessageEntry }
  | {
      kind: 'typing';
      id: string;
      timestamp: number;
      text: string;
      presence: AgentPresence;
      detail?: string | null;
    };

interface ChatTimelineProps {
  timeline: TimelineEntry[];
  isConnected: boolean;
  actionedRequestIds: Set<string>;
  approveSigning: (request: SigningRequestMessage) => void;
  rejectSigning: (request: SigningRequestMessage) => void;
  approveKey: (request: KeyRequestMessage) => void;
  rejectKey: (request: KeyRequestMessage) => void;
}

function ChatTimeline({
  timeline,
  isConnected,
  actionedRequestIds,
  approveSigning,
  rejectSigning,
  approveKey,
  rejectKey,
}: ChatTimelineProps) {
  const flatListRef = React.useRef<FlatList<TimelineEntry>>(null);
  // Whether the list is currently scrolled to (near) the bottom. We only
  // auto-scroll on new content when the user is already at the bottom, so
  // scrolling up to read earlier messages / expand a tool card is never yanked
  // back down by a streaming reply or an incoming message.
  const isAtBottomRef = React.useRef(true);
  // Whether the latest scrolling is driven by the user (a drag / fling) rather
  // than by our own programmatic `scrollToEnd`. Programmatic scrolls fire
  // `onScroll` with transient `contentSize` values while the list is still
  // growing during streaming, which could wrongly flip `isAtBottomRef` to
  // false. We only trust scroll offsets while the user is actually scrolling.
  const userScrollingRef = React.useRef(false);

  const handleScroll = (e: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => {
    if (!userScrollingRef.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    isAtBottomRef.current = distanceFromBottom < 80;
  };

  const handleScrollBeginDrag = () => {
    userScrollingRef.current = true;
  };

  const handleMomentumScrollEnd = () => {
    userScrollingRef.current = false;
  };

  // Scroll to the bottom without animation (animated scrolls fight rapid
  // streaming updates and feel janky), but only when already pinned there.
  const maybeScrollToEnd = () => {
    if (isAtBottomRef.current) {
      flatListRef.current?.scrollToEnd({ animated: false });
    }
  };

  const renderItem = ({ item }: { item: TimelineEntry }) => {
    if (item.kind === 'text') {
      const m = item.data;
      if (m.kind === 'tool') {
        return <ToolActivityCard message={m} />;
      }
      return <MessageBubble text={m.text} mine={m.sender === 'me'} timestamp={m.timestamp} />;
    }

    if (item.kind === 'typing') {
      return <TypingIndicator presence={item.presence} text={item.text} detail={item.detail} />;
    }

    return (
      <Ac2MessageCard
        entry={item.data}
        isConnected={isConnected}
        actioned={
          item.data.direction !== 'outbound' &&
          (item.data.envelope.type === 'ac2/SigningRequest' ||
            item.data.envelope.type === 'ac2/KeyRequest')
            ? actionedRequestIds.has((item.data.envelope as SigningRequestMessage).id)
            : false
        }
        approveSigning={approveSigning}
        rejectSigning={rejectSigning}
        approveKey={approveKey}
        rejectKey={rejectKey}
      />
    );
  };

  return (
    <FlatList
      ref={flatListRef}
      data={timeline}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: 16, paddingBottom: 48, flexGrow: 1 }}
      onScroll={handleScroll}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleMomentumScrollEnd}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      scrollEventThrottle={16}
      onContentSizeChange={maybeScrollToEnd}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
    />
  );
}

export { ChatTimeline };
