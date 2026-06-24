import { formatTime } from '@/components/chat/format';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import * as React from 'react';
import { View } from 'react-native';

interface MessageBubbleProps {
  text: string;
  mine: boolean;
  /** Optional epoch-ms timestamp; renders a compact time label when provided. */
  timestamp?: number;
}

function MessageBubble({ text, mine, timestamp }: MessageBubbleProps) {
  return (
    <View
      className={cn(
        'my-1 max-w-[80%] px-4 py-2',
        mine ? 'self-end bg-primary' : 'self-start border border-border bg-card',
      )}
      style={{
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        borderBottomLeftRadius: mine ? 16 : 4,
        borderBottomRightRadius: mine ? 4 : 16,
      }}
    >
      <Text className={mine ? 'text-primary-foreground' : 'text-card-foreground'}>{text}</Text>
      {timestamp !== undefined && (
        <Text
          className={cn(
            'mt-1 self-end text-[10px]',
            mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          {formatTime(timestamp)}
        </Text>
      )}
    </View>
  );
}

export { MessageBubble };
