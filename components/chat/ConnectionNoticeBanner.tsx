import { Text } from '@/components/ui/text';
import type { ConnectionNotice, NoticeLevel } from '@/lib/ac2';
import { THEME } from '@/lib/theme';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';

interface ConnectionNoticeBannerProps {
  notice: ConnectionNotice;
  onDismiss: () => void;
}

const ICON_BY_LEVEL: Record<NoticeLevel, keyof typeof MaterialIcons.glyphMap> = {
  info: 'info',
  warning: 'warning',
  error: 'error',
};

// Severity accents. The theme only exposes `primary`, so `warning`/`error` use
// dedicated amber/red hexes (kept local since there is no matching theme token).
const WARNING_ACCENT = '#D97706';
const ERROR_ACCENT = '#DC2626';

// Accent (border + icon) colour per severity.
function accentColor(level: NoticeLevel, palette: { primary: string }): string {
  switch (level) {
    case 'error':
      return ERROR_ACCENT;
    case 'info':
      return palette.primary;
    case 'warning':
    default:
      return WARNING_ACCENT;
  }
}

/**
 * Prominent, dismissible banner for an out-of-band agent advisory (a `notice`
 * control frame) — e.g. the warning that a *different* wallet is connecting to
 * an already-registered agent and cannot take it over. Rendered at the top of
 * the chat surface, above the timeline, so it is seen immediately and is never
 * mistaken for a chat message.
 */
function ConnectionNoticeBanner({ notice, onDismiss }: ConnectionNoticeBannerProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const accent = accentColor(notice.level, palette);
  return (
    <View
      accessibilityRole="alert"
      className="flex-row items-start gap-3 border-b border-border bg-card px-4 py-3"
      style={{ borderLeftWidth: 4, borderLeftColor: accent }}
    >
      <MaterialIcons
        name={ICON_BY_LEVEL[notice.level]}
        size={20}
        color={accent}
        style={{ marginTop: 1 }}
      />
      <View className="flex-1">
        {notice.title ? (
          <Text className="text-sm font-semibold text-foreground">{notice.title}</Text>
        ) : null}
        <Text className="text-sm text-muted-foreground">{notice.text}</Text>
      </View>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss notice"
        hitSlop={8}
        className="active:opacity-70"
      >
        <MaterialIcons name="close" size={18} color={palette.mutedForeground} />
      </Pressable>
    </View>
  );
}

export { ConnectionNoticeBanner };
