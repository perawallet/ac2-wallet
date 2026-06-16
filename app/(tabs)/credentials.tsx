import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useStore } from '@tanstack/react-store';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { passkeysStore } from '@/stores/passkeys';
import { THEME } from '@/lib/theme';
import type { Passkey } from '@/extensions/passkeys/types';

function formatDate(ts?: number): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <Text className="text-sm font-medium text-card-foreground">{value}</Text>
    </View>
  );
}

function PasskeyCard({ passkey, iconColor }: { passkey: Passkey; iconColor: string }) {
  const created = formatDate(passkey.createdAt);
  return (
    <View className="mb-3 rounded-2xl bg-card p-5 gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <MaterialIcons name="fingerprint" size={22} color={iconColor} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold text-card-foreground">
            {passkey.name || 'Credential'}
          </Text>
          {passkey.origin ? (
            <Text className="text-sm text-muted-foreground">{passkey.origin}</Text>
          ) : null}
        </View>
      </View>
      <View className="gap-1">
        {created ? <DetailRow label="Created" value={created} /> : null}
        {passkey.algorithm ? <DetailRow label="Algorithm" value={passkey.algorithm} /> : null}
      </View>
    </View>
  );
}

export default function PermissionsTab() {
  const passkeys = useStore(passkeysStore, (s) => s.passkeys);
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;

  if (passkeys.length === 0) {
    return (
      <Screen className="items-center justify-center gap-3 p-8">
        <View className="h-16 w-16 items-center justify-center rounded-2xl bg-muted">
          <MaterialIcons name="fingerprint" size={32} color={palette.mutedForeground} />
        </View>
        <Text className="text-xl font-bold text-foreground">No credentials yet</Text>
        <Text className="text-center text-sm text-muted-foreground">
          Credentials you create or connect will appear here.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen className="px-5">
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text className="my-4 text-sm text-muted-foreground">
          {passkeys.length} credential{passkeys.length === 1 ? '' : 's'} stored on this device
        </Text>
        {passkeys.map((passkey) => (
          <PasskeyCard key={passkey.id} passkey={passkey} iconColor={palette.primary} />
        ))}
      </ScrollView>
    </Screen>
  );
}
