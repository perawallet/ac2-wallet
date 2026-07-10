import { formatTime } from '@/components/chat/format';
import { Text } from '@/components/ui/text';
import type { Message } from '@/stores/messages';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';

interface ToolActivityCardProps {
  message: Message;
}

// A durable "tool card": one tool/exec step the agent ran during a turn,
// rendered distinctly from chat bubbles. Collapsed by default — only the tool
// name (and a one-line command preview) shows, keeping a busy turn's exec
// activity from flooding the conversation. Tapping the header expands the card
// to reveal the full command and (potentially long) output.
function ToolActivityCard({ message }: ToolActivityCardProps) {
  const { colorScheme } = useColorScheme();
  const [expanded, setExpanded] = React.useState(false);
  const toolName = message.tool || 'tool';
  const hasOutput = !!message.output && message.output.trim().length > 0;
  const hasCommand = !!message.command && message.command.trim().length > 0;
  const hasBody = hasOutput || hasCommand;
  // Chevron tint must follow the theme; indigo-300 reads on dark but vanishes on light.
  const chevronColor = colorScheme === 'dark' ? '#9595F5' : '#5858F0';

  return (
    <View className="my-1 self-stretch rounded-xl border border-slate-200 border-l-4 border-l-primary bg-slate-100 p-3 dark:border-slate-700 dark:bg-slate-900">
      <Pressable
        className="flex-row items-center gap-1.5"
        onPress={() => setExpanded((v) => !v)}
        disabled={!hasBody}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse tool activity' : 'Expand tool activity'}
      >
        <MaterialIcons name="terminal" size={16} color="#5858F0" />
        <Text className="text-xs font-bold text-indigo-600 dark:text-indigo-300">{toolName}</Text>
        {/* When collapsed, surface a compact one-line command preview so the
            user can tell what ran without expanding the whole card. */}
        {!expanded && hasCommand && (
          <Text className="flex-1 font-mono text-[11px] text-muted-foreground" numberOfLines={1}>
            {message.command}
          </Text>
        )}
        <Text className="ml-auto text-[10px] text-muted-foreground">
          {formatTime(message.timestamp)}
        </Text>
        {hasBody && (
          <MaterialIcons
            name={expanded ? 'expand-less' : 'expand-more'}
            size={18}
            color={chevronColor}
          />
        )}
      </Pressable>
      {expanded && hasCommand && (
        <Text className="mt-1 font-mono text-xs text-sky-700 dark:text-sky-300">{`$ ${message.command}`}</Text>
      )}
      {expanded && hasOutput && (
        <Text className="mt-1 font-mono text-xs text-slate-700 dark:text-slate-300">
          {message.output}
        </Text>
      )}
    </View>
  );
}

export { ToolActivityCard };
