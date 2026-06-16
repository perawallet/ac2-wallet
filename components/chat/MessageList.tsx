import * as React from 'react';
import { FlatList } from 'react-native';
import { MessageBubble } from '@/components/chat/MessageBubble';
import type { Message } from '@/stores/messages';

interface MessageListProps {
  messages: Message[];
}

function MessageList({ messages }: MessageListProps) {
  return (
    <FlatList
      data={messages}
      keyExtractor={(m) => m.id}
      renderItem={({ item }) => <MessageBubble text={item.text} mine={item.sender === 'me'} />}
      contentContainerStyle={{ padding: 16, flexGrow: 1, justifyContent: 'flex-end' }}
    />
  );
}

export { MessageList };
