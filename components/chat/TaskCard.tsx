import { formatTime } from '@/components/chat/format';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import type { Message } from '@/stores/messages';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

interface TaskCardProps {
  message: Message;
}

function TaskCard({ message }: TaskCardProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [expanded, setExpanded] = React.useState(false);

  const status = message.taskStatus || 'running';
  const title = message.taskTitle || 'Background task';
  const result = message.taskResult;
  const prompt = message.taskPrompt;
  const hasPrompt = !!prompt && prompt.trim().length > 0;

  let statusIcon: React.ReactNode;
  let statusColor: string;
  let statusLabel: string;

  switch (status) {
    case 'completed':
      statusIcon = <MaterialIcons name="check-circle" size={16} color="#22c55e" />;
      statusColor = colorScheme === 'dark' ? 'text-green-400' : 'text-green-600';
      statusLabel = 'Done';
      break;
    case 'failed':
      statusIcon = <MaterialIcons name="error" size={16} color="#ef4444" />;
      statusColor = colorScheme === 'dark' ? 'text-red-400' : 'text-red-600';
      statusLabel = 'Failed';
      break;
    case 'stopped':
      statusIcon = <MaterialIcons name="stop-circle" size={16} color="#71717a" />;
      statusColor = 'text-muted-foreground';
      statusLabel = 'Stopped';
      break;
    case 'running':
    default:
      statusIcon = (
        <ActivityIndicator
          size="small"
          color={palette.primary}
          style={{ width: 16, height: 16 }}
        />
      );
      statusColor = 'text-primary';
      statusLabel = 'Running';
      break;
  }

  return (
    <View className="my-1 self-stretch rounded-xl border border-border border-l-4 border-l-primary bg-muted p-3">
      <Pressable
        className="flex-row items-center gap-1.5"
        onPress={() => setExpanded((v) => !v)}
        disabled={!hasPrompt}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse task details' : 'Expand task details'}
      >
        <View className="w-4 items-center justify-center">{statusIcon}</View>
        <Text className="flex-1 text-xs font-bold text-primary" numberOfLines={1}>
          {title}
        </Text>
        <Text className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</Text>
        <Text className="ml-1 text-[10px] text-muted-foreground">
          {formatTime(message.timestamp)}
        </Text>
        {hasPrompt && (
          <MaterialIcons
            name={expanded ? 'expand-less' : 'expand-more'}
            size={18}
            color={palette.primary}
          />
        )}
      </Pressable>

      {expanded && hasPrompt && (
        <View className="mt-2 rounded bg-card/50 p-2">
          <Text className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
            Prompt
          </Text>
          <Text className="mt-0.5 text-xs text-foreground">{prompt}</Text>
        </View>
      )}

      <View className="mt-2">
        {result ? (
          <Text className="text-sm text-foreground" selectable={true}>
            {result}
          </Text>
        ) : (
          <Text className="text-sm italic text-muted-foreground">
            Working in the background…
          </Text>
        )}
      </View>
    </View>
  );
}

export { TaskCard };
