import {
  AgentIdentityDetailRows,
  DetailRow,
  getAgentMaterialHeld,
  truncateMiddle,
  type AgentIdentitySummary,
} from '@/components/AgentIdentityDetails';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import type { Passkey } from '@/extensions/passkeys/types';
import { useProvider } from '@/hooks/useProvider';
import { THEME } from '@/lib/theme';
import { ac2MessagesStore } from '@/stores/ac2Messages';
import { agentIdentitiesStore, type AgentIdentity } from '@/stores/agentIdentities';
import { formatMicroAmount, normalizeAlgorandAddress, truncateAddress } from '@/utils/format';
import type { Account } from '@algorandfoundation/accounts-store';
import type { Key } from '@algorandfoundation/keystore';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

function formatDate(ts?: number): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function SectionHeader({
  title,
  count,
  expanded,
  onToggle,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      className="flex-row items-center px-4 pb-1 pt-4 active:opacity-70"
    >
      <Text className="flex-1 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
        {'  '}
        <Text className="normal-case tracking-normal">{count}</Text>
      </Text>
      <MaterialIcons
        name={expanded ? 'expand-less' : 'expand-more'}
        size={18}
        color={palette.mutedForeground}
      />
    </Pressable>
  );
}

function PasskeyCard({
  passkey,
  iconColor,
  onDelete,
  onCopy,
  copiedField,
}: {
  passkey: Passkey;
  iconColor: string;
  onDelete: () => void;
  onCopy: (field: string, value: string) => void;
  copiedField: string | null;
}) {
  const created = formatDate(passkey.createdAt);
  return (
    <View className="rounded-2xl bg-card p-5 gap-3">
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${passkey.name || 'credential'}`}
          className="h-9 w-9 items-center justify-center rounded-full bg-muted"
          onPress={onDelete}
        >
          <MaterialIcons name="delete-outline" size={20} color="#DC2626" />
        </Pressable>
      </View>
      <View className="gap-1">
        {created ? <DetailRow label="Created" value={created} /> : null}
        {passkey.algorithm ? <DetailRow label="Algorithm" value={passkey.algorithm} /> : null}
        {passkey.origin ? (
          <DetailRow
            label="Origin"
            value={passkey.origin}
            onPress={() => onCopy(`pk-origin-${passkey.id}`, passkey.origin!)}
            copied={copiedField === `pk-origin-${passkey.id}`}
          />
        ) : null}
      </View>
    </View>
  );
}

function KeyCard({
  keyItem,
  iconColor,
  onCopy,
  copiedField,
}: {
  keyItem: Key;
  iconColor: string;
  onCopy: (field: string, value: string) => void;
  copiedField: string | null;
}) {
  const isRegistered = !!(keyItem.metadata as { registered?: boolean } | undefined)?.registered;
  const pubKey = keyItem.publicKey ? uint8ToBase64(keyItem.publicKey) : null;
  const subtitle = [keyItem.algorithm ?? 'unknown', keyItem.format].filter(Boolean).join(' · ');

  return (
    <View className="rounded-2xl bg-card p-5 gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <MaterialIcons name="vpn-key" size={22} color={iconColor} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold text-card-foreground">
            {keyItem.type ?? 'Key'}
          </Text>
          <Text className="text-sm text-muted-foreground">{subtitle}</Text>
        </View>
        {isRegistered ? <MaterialIcons name="verified" size={20} color="#10B981" /> : null}
      </View>
      <View className="gap-1">
        <DetailRow
          label="ID"
          value={keyItem.id}
          mono
          onPress={() => onCopy(`key-id-${keyItem.id}`, keyItem.id)}
          copied={copiedField === `key-id-${keyItem.id}`}
        />
        {pubKey ? (
          <DetailRow
            label="Public key"
            value={pubKey}
            mono
            onPress={() => onCopy(`key-pub-${keyItem.id}`, pubKey)}
            copied={copiedField === `key-pub-${keyItem.id}`}
          />
        ) : null}
      </View>
    </View>
  );
}

function AgentIdentityCard({
  identity,
  iconColor,
  materialHeld,
  onCopy,
  copiedField,
}: {
  identity: AgentIdentity;
  iconColor: string;
  materialHeld: boolean | undefined;
  onCopy: (field: string, value: string) => void;
  copiedField: string | null;
}) {
  const summary: AgentIdentitySummary = {
    controllerDid: identity.controllerDid,
    agentDid: identity.agentDid,
    publicKey: identity.publicKey,
    materialHeld,
    grantedAt: identity.createdAt,
    keyId: identity.keyId,
  };
  return (
    <View className="rounded-2xl bg-card p-5 gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <MaterialIcons name="smart-toy" size={22} color={iconColor} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold text-card-foreground" numberOfLines={1}>
            {truncateMiddle(identity.agentDid)}
          </Text>
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {identity.origin}
          </Text>
        </View>
        <MaterialIcons name="vpn-key" size={18} color="#10B981" />
      </View>
      <AgentIdentityDetailRows
        identity={summary}
        keyPrefix={`agent-${identity.id}`}
        onCopy={onCopy}
        copiedField={copiedField}
      />
    </View>
  );
}

function AccountCard({
  account,
  iconColor,
  onCopy,
  copiedField,
}: {
  account: Account;
  iconColor: string;
  onCopy: (field: string, value: string) => void;
  copiedField: string | null;
}) {
  const address = normalizeAlgorandAddress(account.address) ?? account.address;
  const balanceStr = `${formatMicroAmount(account.balance, 6)} ALGO`;

  return (
    <View className="rounded-2xl bg-card p-5 gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <MaterialIcons name="account-balance-wallet" size={22} color={iconColor} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold text-card-foreground" numberOfLines={1}>
            {truncateAddress(address)}
          </Text>
          <Text className="text-sm text-muted-foreground">{account.type}</Text>
        </View>
      </View>
      <View className="gap-1">
        <DetailRow
          label="Address"
          value={address}
          mono
          onPress={() => onCopy(`acct-${address}`, address)}
          copied={copiedField === `acct-${address}`}
        />
        <DetailRow label="Balance" value={balanceStr} />
        {account.assets.length > 0 ? (
          <DetailRow label="Assets" value={String(account.assets.length)} />
        ) : null}
      </View>
    </View>
  );
}

export function CredentialsScreen() {
  const { passkeys, passkey, keys, accounts } = useProvider();
  const agentIdentities = useStore(agentIdentitiesStore, (s) => s.identities);
  const ac2Messages = useStore(ac2MessagesStore, (s) => s.messages);
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [copiedField, setCopiedField] = React.useState<string | null>(null);
  const copyResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  const handleCopy = React.useCallback(async (field: string, value: string) => {
    if (!value) return;
    await Clipboard.setStringAsync(value);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopiedField(field);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedField(null), 1500);
  }, []);

  const handleDeletePasskey = React.useCallback(
    (target: Passkey) => {
      Alert.alert(
        'Delete credential?',
        `Are you sure you want to delete ${target.name || 'this credential'}? This cannot be undone.`,
        [
          { text: 'No', style: 'cancel' },
          {
            text: 'Yes',
            style: 'destructive',
            onPress: async () => {
              try {
                await passkey.store.removePasskey(target.id);
              } catch {
                Alert.alert('Delete failed', 'Unable to delete this credential right now.', [
                  { text: 'OK' },
                ]);
              }
            },
          },
        ],
      );
    },
    [passkey],
  );

  const [expanded, setExpanded] = React.useState({
    passkeys: true,
    keys: true,
    agentIdentities: true,
    accounts: true,
  });

  const toggle = (section: keyof typeof expanded) =>
    setExpanded((prev) => ({ ...prev, [section]: !prev[section] }));

  const isEmpty =
    passkeys.length === 0 &&
    keys.length === 0 &&
    agentIdentities.length === 0 &&
    accounts.length === 0;

  if (isEmpty) {
    return (
      <Screen edges={[]} className="items-center justify-center gap-3 p-8">
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
    <Screen edges={[]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {passkeys.length > 0 && (
          <View>
            <SectionHeader
              title="Passkeys"
              count={passkeys.length}
              expanded={expanded.passkeys}
              onToggle={() => toggle('passkeys')}
            />
            {expanded.passkeys && (
              <View className="px-4 pt-2 gap-3">
                {passkeys.map((p) => (
                  <PasskeyCard
                    key={p.id}
                    passkey={p}
                    iconColor={palette.primary}
                    onDelete={() => handleDeletePasskey(p)}
                    onCopy={handleCopy}
                    copiedField={copiedField}
                  />
                ))}
              </View>
            )}
          </View>
        )}

        {keys.length > 0 && (
          <View>
            <SectionHeader
              title="Keys"
              count={keys.length}
              expanded={expanded.keys}
              onToggle={() => toggle('keys')}
            />
            {expanded.keys && (
              <View className="px-4 pt-2 gap-3">
                {keys.map((k) => (
                  <KeyCard
                    key={k.id}
                    keyItem={k}
                    iconColor={palette.primary}
                    onCopy={handleCopy}
                    copiedField={copiedField}
                  />
                ))}
              </View>
            )}
          </View>
        )}

        {agentIdentities.length > 0 && (
          <View>
            <SectionHeader
              title="Agent identities"
              count={agentIdentities.length}
              expanded={expanded.agentIdentities}
              onToggle={() => toggle('agentIdentities')}
            />
            {expanded.agentIdentities && (
              <View className="px-4 pt-2 gap-3">
                {agentIdentities.map((ident) => (
                  <AgentIdentityCard
                    key={ident.id}
                    identity={ident}
                    iconColor={palette.primary}
                    materialHeld={getAgentMaterialHeld(ac2Messages, {
                      origin: ident.origin,
                      requestId: ident.requestId,
                      publicKey: ident.publicKey,
                    })}
                    onCopy={handleCopy}
                    copiedField={copiedField}
                  />
                ))}
              </View>
            )}
          </View>
        )}

        {accounts.length > 0 && (
          <View>
            <SectionHeader
              title="Accounts"
              count={accounts.length}
              expanded={expanded.accounts}
              onToggle={() => toggle('accounts')}
            />
            {expanded.accounts && (
              <View className="px-4 pt-2 gap-3">
                {(accounts as Account[]).map((acct) => (
                  <AccountCard
                    key={acct.address}
                    account={acct}
                    iconColor={palette.primary}
                    onCopy={handleCopy}
                    copiedField={copiedField}
                  />
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
