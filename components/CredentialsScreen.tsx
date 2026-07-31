import {
  AgentIdentityDetailRows,
  DetailRow,
  getAgentMaterialHeld,
  truncateMiddle,
  type AgentIdentitySummary,
} from '@/components/AgentIdentityDetails';
import { CopiedToast } from '@/components/ui/CopiedToast';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/text';
import type { Passkey } from '@/extensions/passkeys/types';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { useProvider } from '@/hooks/useProvider';
import { THEME } from '@/lib/theme';
import { ac2MessagesStore } from '@/stores/ac2Messages';
import { agentIdentitiesStore, type AgentIdentity } from '@/stores/agentIdentities';
import { sessionsStore, type Session } from '@/stores/sessions';
import { setCurrentConnection } from '@/stores/ui';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@tanstack/react-store';
import { useRouter } from 'expo-router';
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

/** Display name for a chat/session — mirrors the chat drawer's row title. */
function chatDisplayName(session: Session): string {
  return session.name?.trim() || session.origin;
}

function AgentIdentityCard({
  identity,
  iconColor,
  mutedColor,
  materialHeld,
  session,
  onOpenChat,
  onCopy,
  copiedField,
}: {
  identity: AgentIdentity;
  iconColor: string;
  mutedColor: string;
  materialHeld: boolean | undefined;
  session: Session | undefined;
  onOpenChat?: () => void;
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
  const chatName = session ? chatDisplayName(session) : null;
  const canOpenChat = Boolean(session && onOpenChat);
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      <View className="p-5 gap-3">
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
        </View>
        <AgentIdentityDetailRows
          identity={summary}
          keyPrefix={`agent-${identity.id}`}
          onCopy={onCopy}
          copiedField={copiedField}
        />
      </View>
      <View className="border-t border-border">
        <Pressable
          onPress={onOpenChat}
          disabled={!canOpenChat}
          accessibilityRole={canOpenChat ? 'button' : undefined}
          accessibilityLabel={canOpenChat ? `Open chat ${chatName}` : undefined}
          accessibilityHint={
            canOpenChat ? 'Opens the chat this agent identity was granted to' : undefined
          }
          className={`flex-row items-center gap-3 px-5 py-3 ${canOpenChat ? 'active:opacity-70' : ''}`}
        >
          <MaterialIcons
            name="chat-bubble-outline"
            size={18}
            color={canOpenChat ? iconColor : mutedColor}
          />
          <View className="min-w-0 flex-1">
            <Text className="text-sm text-muted-foreground">Chat</Text>
            <Text
              className={`text-sm font-medium ${canOpenChat ? 'text-card-foreground' : 'text-muted-foreground'}`}
              numberOfLines={1}
            >
              {chatName ?? 'No active chat'}
            </Text>
          </View>
          {canOpenChat ? <MaterialIcons name="chevron-right" size={20} color={iconColor} /> : null}
        </Pressable>
      </View>
    </View>
  );
}

export function CredentialsScreen() {
  const { passkeys, passkey } = useProvider();
  const agentIdentities = useStore(agentIdentitiesStore, (s) => s.identities);
  const ac2Messages = useStore(ac2MessagesStore, (s) => s.messages);
  const sessions = useStore(sessionsStore, (s) => s.sessions);
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const { copiedField, copy: handleCopy, showCopiedToast } = useCopyFeedback();

  const handleOpenChat = React.useCallback(
    (session: Session) => {
      setCurrentConnection(session.origin, session.id);
      router.push('/chat');
    },
    [router],
  );

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
    agentIdentities: true,
  });

  const toggle = (section: keyof typeof expanded) =>
    setExpanded((prev) => ({ ...prev, [section]: !prev[section] }));

  const isEmpty = passkeys.length === 0 && agentIdentities.length === 0;

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
                {agentIdentities.map((ident) => {
                  const session = sessions.find(
                    (s) => s.origin === ident.origin && s.id === ident.requestId,
                  );
                  return (
                    <AgentIdentityCard
                      key={ident.id}
                      identity={ident}
                      iconColor={palette.primary}
                      mutedColor={palette.mutedForeground}
                      materialHeld={getAgentMaterialHeld(ac2Messages, {
                        origin: ident.origin,
                        requestId: ident.requestId,
                        publicKey: ident.publicKey,
                      })}
                      session={session}
                      onOpenChat={session ? () => handleOpenChat(session) : undefined}
                      onCopy={handleCopy}
                      copiedField={copiedField}
                    />
                  );
                })}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <CopiedToast visible={showCopiedToast} />
    </Screen>
  );
}
