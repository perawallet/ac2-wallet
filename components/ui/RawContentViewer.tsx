import { Text } from '@/components/ui/text';
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
  const iconColor = colorScheme === 'dark' ? '#E2E8F0' : '#334155';
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
    <View className={cn('overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-900', className)}>
      <View className="flex-row items-center border-b border-slate-300 bg-slate-200 px-2 py-1 dark:border-slate-700 dark:bg-slate-950">
        <Text className="flex-1 font-mono text-[11px] font-semibold text-slate-700 dark:text-slate-200">
          {contentType}
        </Text>
        <Pressable
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel={`Copy ${contentType}`}
          className="p-1"
        >
          <MaterialIcons name="content-copy" size={14} color={iconColor} />
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
              color={iconColor}
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
