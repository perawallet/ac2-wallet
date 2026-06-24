import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';
import { MaterialIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useColorScheme } from 'nativewind';
import { Linking, Pressable, Switch, View } from 'react-native';

function SectionHeader({ label }: { label: string }) {
  return (
    <Text className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </Text>
  );
}

interface MenuRowProps {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  onPress?: () => void;
  right?: React.ReactNode;
  isLast?: boolean;
}

function MenuRow({ icon, label, onPress, right, isLast }: MenuRowProps) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : 'none'}
      className={`w-full flex-row items-center bg-card px-4 py-3 active:opacity-70 ${!isLast ? 'border-b border-border' : ''}`}
    >
      <View className="mr-3 h-8 w-8 items-center justify-center rounded-lg bg-muted">
        <MaterialIcons name={icon} size={18} color={palette.mutedForeground} />
      </View>
      <Text className="flex-1 text-base text-foreground">{label}</Text>
      {right ?? <MaterialIcons name="chevron-right" size={20} color={palette.mutedForeground} />}
    </Pressable>
  );
}

export default function MenuTab() {
  const { colorScheme, setColorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? THEME.dark : THEME.light;

  const termsUrl = Constants.expoConfig?.extra?.termsOfServiceUrl as string | undefined;
  const privacyUrl = Constants.expoConfig?.extra?.privacyPolicyUrl as string | undefined;

  async function openLink(url: string | undefined) {
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch (error) {
      console.error('Failed to open URL', { url, error });
    }
  }

  return (
    <Screen className="justify-start p-4">
      <SectionHeader label="Preferences" />
      <View className="overflow-hidden rounded-xl">
        <MenuRow
          icon="dark-mode"
          label="Dark Mode"
          isLast
          right={
            <Switch
              value={isDark}
              onValueChange={(value) => setColorScheme(value ? 'dark' : 'light')}
              trackColor={{ false: palette.border, true: palette.primary }}
              thumbColor={palette.background}
            />
          }
        />
      </View>

      <SectionHeader label="Legal" />
      <View className="overflow-hidden rounded-xl">
        {termsUrl ? (
          <MenuRow icon="description" label="Terms of Service" onPress={() => openLink(termsUrl)} />
        ) : null}
        {privacyUrl ? (
          <MenuRow
            icon="privacy-tip"
            label="Privacy Policy"
            onPress={() => openLink(privacyUrl)}
            isLast
          />
        ) : null}
      </View>
    </Screen>
  );
}
