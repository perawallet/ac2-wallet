import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';

interface ReconnectBarProps {
  onReconnect: () => void;
  /** When true the previous attempt failed; copy reflects an error vs. a drop. */
  isError?: boolean;
  /**
   * When true the peer isn't present in the requestId room, so we couldn't
   * connect. Shows a clean, actionable notice asking the user to check their
   * remote device instead of a generic "connection failed".
   */
  peerOffline?: boolean;
  /**
   * When true the signaling socket itself is disconnected from the Liquid Auth
   * service, so nothing (presence checks, messaging, negotiation) can happen
   * until it's back. Shows "Service unavailable" — takes priority over the
   * peer/error/disconnected copy.
   */
  serviceUnavailable?: boolean;
}

// Footer shown in place of the composer when the transport has dropped. Mirrors
// the composer's bar styling so the chat surface keeps a consistent footprint,
// and gives the user an explicit affordance to re-establish the connection.
function ReconnectBar({ onReconnect, isError, peerOffline, serviceUnavailable }: ReconnectBarProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const message = serviceUnavailable
    ? 'Service unavailable. Not connected to the signaling service — retrying…'
    : peerOffline
      ? "Can't reach the chat. Check your remote device is online, then tap Reconnect."
      : isError
        ? 'Connection failed.'
        : 'Disconnected.';
  return (
    <View
      className="flex-row items-center gap-3 border-t border-border bg-card p-3"
      style={{ paddingBottom: 12 }}
    >
      <MaterialIcons name="cloud-off" size={20} color={palette.mutedForeground} />
      <Text className="flex-1 text-sm text-muted-foreground">{message}</Text>
      <Pressable
        onPress={onReconnect}
        accessibilityRole="button"
        accessibilityLabel="Reconnect"
        className="flex-row items-center gap-1.5 rounded-md bg-primary px-4 py-2 active:opacity-90"
      >
        <MaterialIcons name="refresh" size={16} color={THEME.dark.foreground} />
        <Text className="text-sm font-semibold text-primary-foreground">Reconnect</Text>
      </Pressable>
    </View>
  );
}

export { ReconnectBar };
