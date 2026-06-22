import { Text } from '@/components/ui/text';
import { DEFAULT_THID } from '@/lib/ac2';
import { THEME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Alert, Pressable, ScrollView } from 'react-native';

interface RemoteThread {
  thid: string;
  title?: string;
  updatedAt?: number;
}

interface ThreadBarProps {
  threads: string[];
  activeThid: string;
  remoteThreads: RemoteThread[];
  isConnected: boolean;
  onOpen: (thid?: string) => void;
  onClose: (thid: string) => void;
}

// Conversation switcher — one connection multiplexes several threads. Tapping a
// chip switches the active conversation (and sends ac2/ConversationOpen so the
// agent follows); the "New" chip opens a brand-new conversation. Long-pressing
// a non-default chip closes that conversation.
function ThreadBar({
  threads,
  activeThid,
  remoteThreads,
  isConnected,
  onOpen,
  onClose,
}: ThreadBarProps) {
  const { colorScheme } = useColorScheme();
  const tint = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;

  // A short, human-facing label for a thread chip: the default thread reads
  // "Main"; others use a remote title or a truncated id.
  const threadLabel = (thid: string): string => {
    if (thid === DEFAULT_THID) return 'Main';
    const remote = remoteThreads.find((r) => r.thid === thid);
    if (remote?.title) {
      return remote.title.length > 18 ? `${remote.title.slice(0, 18)}…` : remote.title;
    }
    return thid.length > 12 ? `${thid.slice(0, 12)}…` : thid;
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 8,
        paddingVertical: 8,
        gap: 8,
        alignItems: 'center',
      }}
      keyboardShouldPersistTaps="handled"
    >
      {threads.map((thid) => {
        const isActive = thid === activeThid;
        return (
          <Pressable
            key={thid}
            className={cn(
              'flex-row items-center gap-1.5 rounded-2xl border px-3 py-1.5',
              isActive ? 'border-primary bg-primary' : 'border-border bg-secondary',
            )}
            accessibilityRole="button"
            accessibilityLabel={`Conversation ${threadLabel(thid)}`}
            onPress={() => {
              if (!isActive) onOpen(thid);
            }}
            onLongPress={() => {
              if (thid !== DEFAULT_THID) {
                Alert.alert('Close conversation?', `Close "${threadLabel(thid)}"?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Close', style: 'destructive', onPress: () => onClose(thid) },
                ]);
              }
            }}
          >
            <MaterialIcons
              name={thid === DEFAULT_THID ? 'forum' : 'chat-bubble-outline'}
              size={14}
              color={isActive ? '#FFFFFF' : tint}
            />
            <Text
              className={cn(
                'text-[13px] font-semibold',
                isActive ? 'text-primary-foreground' : 'text-foreground',
              )}
            >
              {threadLabel(thid)}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        className="flex-row items-center gap-1 rounded-2xl border border-dashed border-primary bg-secondary px-3 py-1.5"
        accessibilityRole="button"
        accessibilityLabel="New conversation"
        onPress={() => onOpen()}
        disabled={!isConnected}
      >
        <MaterialIcons name="add" size={16} color={tint} />
        <Text className="text-[13px] font-bold text-primary">New</Text>
      </Pressable>
    </ScrollView>
  );
}

export { ThreadBar };
export type { RemoteThread };
