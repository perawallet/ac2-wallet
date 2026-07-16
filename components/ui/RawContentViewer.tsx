import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

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

  const handleCopy = React.useCallback(async () => {
    try {
      await Clipboard.setStringAsync(content);
      Alert.alert('Copied', `${contentType} copied to clipboard.`);
    } catch {
      Alert.alert('Copy failed', 'Could not copy to the clipboard.');
    }
  }, [content, contentType]);

  return (
    <View className={cn('overflow-hidden rounded-lg bg-muted', className)}>
      <View className="flex-row items-center border-b border-border bg-secondary px-2 py-1">
        <Text className="flex-1 font-mono text-[11px] font-semibold text-foreground">
          {contentType}
        </Text>
        <Pressable
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel={`Copy ${contentType}`}
          className="p-1"
        >
          <MaterialIcons name="content-copy" size={14} color={palette.foreground} />
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
