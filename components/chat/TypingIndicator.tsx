import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { View } from 'react-native';

export type AgentPresence = 'thinking' | 'tool' | 'typing';

interface TypingIndicatorProps {
  presence: AgentPresence;
  /** Partial streamed reply text, shown above the indicator while typing. */
  text?: string;
  /** Optional detail for the current presence (e.g. tool name). */
  detail?: string | null;
}

// While the agent is working on a reply, render an ephemeral indicator instead
// of a final message bubble: "thinking…" once the model is running, "running
// <tool>…" while a tool executes, and "typing…" (with a live preview) once the
// reply starts streaming.
function TypingIndicator({ presence, text, detail }: TypingIndicatorProps) {
  const { colorScheme } = useColorScheme();
  const tint = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;
  const isThinking = presence === 'thinking';
  const isTool = presence === 'tool';
  const iconName = isThinking ? 'psychology' : isTool ? 'build' : 'more-horiz';
  const label = isThinking
    ? 'Agent is thinking…'
    : isTool
      ? detail
        ? `Agent is running ${detail}…`
        : 'Agent is working…'
      : 'Agent is typing…';

  return (
    <View className="my-1 max-w-[80%] self-start rounded-2xl border border-border bg-card px-4 py-2">
      {!!text && text.trim().length > 0 && <Text className="text-card-foreground">{text}</Text>}
      <View className="mt-1 flex-row items-center gap-1">
        <MaterialIcons name={iconName} size={18} color={tint} />
        <Text className="text-[13px] italic text-primary">{label}</Text>
      </View>
    </View>
  );
}

export { TypingIndicator };
