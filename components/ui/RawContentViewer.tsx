import { Text } from '@/components/ui/text';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { THEME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

// This viewer is embedded in lists and cards, so it confirms a copy in place on
// its own button rather than with a screen-level toast.
const COPY_FIELD = 'raw-content';

interface RawContentViewerProps {
  content: string;
  contentType: string;
  initiallyExpanded?: boolean;
  collapsedLines?: number;
  className?: string;
}

function RawContentViewer({
  content,
  contentType,
  initiallyExpanded = false,
  collapsedLines = 6,
  className,
}: RawContentViewerProps) {
  const { colorScheme } = useColorScheme();
  const [expanded, setExpanded] = React.useState(initiallyExpanded);
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const lineCount = content.split('\n').length;
  const canExpand = lineCount > collapsedLines;

  const { copiedField, copy } = useCopyFeedback();
  const copied = copiedField === COPY_FIELD;

  const handleCopy = React.useCallback(() => {
    void copy(COPY_FIELD, content);
  }, [content, copy]);

  return (
    <View className={cn('overflow-hidden rounded-lg bg-muted', className)}>
      <View className="flex-row items-center border-b border-border bg-secondary px-2 py-1">
        <Text className="flex-1 font-mono text-[11px] font-semibold text-foreground">
          {contentType}
        </Text>
        <Pressable
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel={copied ? `${contentType} copied` : `Copy ${contentType}`}
          className="p-1"
        >
          <MaterialIcons
            name={copied ? 'check' : 'content-copy'}
            size={14}
            color={copied ? palette.primary : palette.foreground}
          />
        </Pressable>
        {canExpand && (
          <Pressable
            onPress={() => setExpanded((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Collapse content' : 'Expand content'}
            className="p-1"
          >
            <MaterialIcons
              name={expanded ? 'expand-less' : 'expand-more'}
              size={16}
              color={palette.foreground}
            />
          </Pressable>
        )}
      </View>

      <View className="p-2">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            className="font-mono text-[11px] leading-4 text-emerald-700 dark:text-emerald-400"
            numberOfLines={expanded ? undefined : collapsedLines}
          >
            {content}
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}

export { RawContentViewer };
