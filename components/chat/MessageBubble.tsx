import { formatTime, splitMessageText, stripHiddenUriSchemes } from '@/components/chat/format';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import * as React from 'react';
import { Alert, Linking, Platform, TextInput, View } from 'react-native';

interface MessageBubbleProps {
  text: string;
  mine: boolean;
  /** Optional epoch-ms timestamp; renders a compact time label when provided. */
  timestamp?: number;
}

async function openLink(uri: string) {
  try {
    await Linking.openURL(uri);
  } catch {
    Alert.alert('Could not open link', uri);
  }
}

function MessageBubble({ text, mine, timestamp }: MessageBubbleProps) {
  const textColorClass = mine ? 'text-primary-foreground' : 'text-card-foreground';
  const linkColorClass = mine ? 'text-primary-foreground' : 'text-primary';
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
        // `selectable`. `dataDetectorTypes` is only honored by UITextView
        // when `multiline` + `!editable` (already true here), and — unlike
        // `isSelectable` — it doesn't disturb text selection, so it's the
        // only way to get tappable links without losing drag-handle
        // selection on iOS.
        <TextInput
          editable={false}
          multiline
          scrollEnabled={false}
          value={stripHiddenUriSchemes(text)}
          dataDetectorTypes={['link', 'phoneNumber']}
          className={cn('text-base', textColorClass)}
          style={{ padding: 0 }}
        />
      ) : (
        <Text selectable className={textColorClass}>
          {splitMessageText(text).map((segment, index) =>
            segment.uri ? (
              <Text
                key={index}
                accessibilityRole="link"
                onPress={() => openLink(segment.uri!)}
                className={cn('underline', linkColorClass)}
              >
                {segment.text}
              </Text>
            ) : (
              segment.text
            ),
          )}
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
