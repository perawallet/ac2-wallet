import * as React from 'react';
import { View } from 'react-native';
import { cn } from '@/lib/utils';
import { Text } from '@/components/ui/text';

interface MessageBubbleProps {
  text: string;
  mine: boolean;
}

function MessageBubble({ text, mine }: MessageBubbleProps) {
  return (
    <View
      className={cn(
        'my-1 max-w-[80%] rounded-2xl px-4 py-2',
        mine ? 'self-end bg-primary' : 'self-start bg-muted',
      )}
    >
      <Text className={mine ? 'text-primary-foreground' : 'text-foreground'}>{text}</Text>
    </View>
  );
}

export { MessageBubble };
