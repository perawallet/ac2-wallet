import { formatTime } from '@/components/chat/format';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';

interface MessageBubbleProps {
  text: string;
  mine: boolean;
  /** Optional epoch-ms timestamp; renders a compact time label when provided. */
  timestamp?: number;
}

function MessageBubble({ text, mine, timestamp }: MessageBubbleProps) {
  const textColorClass = mine ? 'text-primary-foreground' : 'text-card-foreground';
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
      {Platform.OS === 'ios' ? (
        // RN's Text `selectable` only exposes a "Copy" menu for the whole
        // string on iOS — no drag handles for a partial selection. A
        // non-editable multiline TextInput keeps UITextView's native
        // `isSelectable` (independent of `editable`), which gives real
        // per-character selection handles like Android already gets from
        // `selectable`.
        <TextInput
          editable={false}
          multiline
          scrollEnabled={false}
          value={text}
          className={cn('text-base', textColorClass)}
          style={{ padding: 0 }}
        />
      ) : (
        <Text selectable className={textColorClass}>
          {text}
        </Text>
      )}
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
