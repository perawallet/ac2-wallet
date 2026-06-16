import * as React from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useStore } from '@tanstack/react-store';
import { MessageList } from '@/components/chat/MessageList';
import { ChatComposer } from '@/components/chat/ChatComposer';
import { messagesStore, addMessage } from '@/stores/messages';
import type { Session } from '@/stores/sessions';

interface ChatScreenProps {
  session: Session;
}

function ChatScreen({ session }: ChatScreenProps) {
  const messages = useStore(messagesStore, (s) =>
    s.messages.filter(
      (m) => m.origin === session.origin && m.requestId === session.id && m.kind !== 'tool',
    ),
  );

  const handleSend = (text: string) => {
    // Local-only for now; live send wiring (useConnection) comes with chat content.
    addMessage({ text, sender: 'me', address: '', origin: session.origin, requestId: session.id });
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="flex-1">
        <MessageList messages={messages} />
      </View>
      <ChatComposer onSend={handleSend} />
    </KeyboardAvoidingView>
  );
}

export { ChatScreen };
