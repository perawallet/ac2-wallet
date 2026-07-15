import { Store } from '@tanstack/react-store';
import { createMMKV } from 'react-native-mmkv';
import {
  removePairingCredential,
  type PairingCredentialReference,
} from '@/lib/liquid-auth/pairing-credentials';

export interface Session {
  id: string; // Typically the requestId
  origin: string;
  /** Optional user-defined display name for this connection. */
  name?: string;
  /** WebAuthn credential id registered for this connection, when known. */
  passkeyCredentialId?: string;
  /** Non-secret reference to the durable Liquid Auth credential in Keychain. */
  pairing?: PairingCredentialReference;
  /** Pairing authorization is durable; this is independent of live transport. */
  pairingStatus?: 'pending' | 'legacy' | 'paired' | 'revoked';
  timestamp: number;
  status: 'active' | 'closed' | 'failed';
  lastActivity: number;
  /** @deprecated Pairings are durable until explicitly forgotten or revoked. */
  ttl?: number;
}

export interface SessionsState {
  sessions: Session[];
}

const sessionsLocalStorage = createMMKV({
  id: 'sessions',
});

// Load initial state from storage
const loadInitialSessions = (): SessionsState => {
  try {
    const stored = sessionsLocalStorage.getString('sessions');
    if (stored) {
      const parsed = JSON.parse(stored);
      // Legacy builds could attach a TTL. Pairing authorization is now
      // explicitly durable, so migrate that field away instead of silently
      // forgetting an agent merely because the wallet was gone for a while.
      const validSessions = parsed.filter(Boolean).map((storedSession: Session) => {
        const { ttl: _legacyTtl, ...session } = storedSession;
        return {
          ...session,
          pairingStatus: session.pairingStatus ?? (session.pairing ? 'paired' : 'legacy'),
        };
      });
      return { sessions: validSessions };
    }
  } catch (error) {
    console.error('Failed to load sessions from storage:', error);
  }
  return { sessions: [] };
};

export const sessionsStore = new Store<SessionsState>(loadInitialSessions());

// Subscribe to store changes and save to storage
sessionsStore.subscribe(() => {
  const state = sessionsStore.state;
  try {
    if (state.sessions) {
      sessionsLocalStorage.set('sessions', JSON.stringify(state.sessions));
    }
  } catch (error) {
    console.error('Failed to save sessions to storage:', error);
  }
});

export function addSession(session: Omit<Session, 'timestamp' | 'lastActivity'>) {
  const now = Date.now();
  sessionsStore.setState((state) => {
    // Avoid duplicate sessions with the same id (requestId) and origin
    const filtered = state.sessions.filter(
      (s) => !(s.id === session.id && s.origin === session.origin),
    );
    return {
      ...state,
      sessions: [
        ...filtered,
        {
          ...session,
          pairingStatus: session.pairingStatus ?? (session.pairing ? 'paired' : 'pending'),
          timestamp: now,
          lastActivity: now,
        },
      ],
    };
  });
}

export function updateSessionStatus(id: string, origin: string, status: Session['status']) {
  sessionsStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === id && s.origin === origin ? { ...s, status, lastActivity: Date.now() } : s,
    ),
  }));
}

export function updateSessionActivity(id: string, origin: string) {
  sessionsStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === id && s.origin === origin ? { ...s, lastActivity: Date.now() } : s,
    ),
  }));
}

export function updateSessionPasskeyCredentialId(id: string, origin: string, credentialId: string) {
  sessionsStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === id && s.origin === origin
        ? { ...s, passkeyCredentialId: credentialId, lastActivity: Date.now() }
        : s,
    ),
  }));
}

export function updateSessionPairing(
  id: string,
  origin: string,
  pairing: PairingCredentialReference,
) {
  sessionsStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === id && s.origin === origin
        ? { ...s, pairing, pairingStatus: 'paired' as const, lastActivity: Date.now() }
        : s,
    ),
  }));
}

export function revokeSessionPairing(id: string, origin: string) {
  void removePairingCredential(origin, id).catch((error) =>
    console.warn('Failed to remove revoked pairing credential:', error),
  );
  sessionsStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((session) =>
      session.id === id && session.origin === origin
        ? {
            ...session,
            pairing: undefined,
            pairingStatus: 'revoked' as const,
            status: 'failed' as const,
            lastActivity: Date.now(),
          }
        : session,
    ),
  }));
}

/**
 * Drop a rejected local controller credential without declaring the remote
 * pairing revoked. The passkey/session metadata remains available for one
 * foreground WebAuthn refresh that can mint a replacement credential.
 */
export async function clearSessionPairingCredential(id: string, origin: string): Promise<void> {
  sessionsStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((session) =>
      session.id === id && session.origin === origin
        ? {
            ...session,
            pairing: undefined,
            pairingStatus: 'legacy' as const,
            status: 'closed' as const,
            lastActivity: Date.now(),
          }
        : session,
    ),
  }));

  try {
    await removePairingCredential(origin, id);
  } catch (error) {
    // The unusable secret remains inaccessible through app state even if the
    // platform keystore cannot delete it immediately. A replacement overwrites
    // the same service after WebAuthn recovery succeeds.
    console.warn('Failed to remove unauthorized pairing credential:', error);
  }
}

export function removeSession(id: string, origin: string) {
  void removePairingCredential(origin, id).catch((error) =>
    console.warn('Failed to remove forgotten pairing credential:', error),
  );
  sessionsStore.setState((state) => ({
    ...state,
    sessions: state.sessions.filter((s) => !(s.id === id && s.origin === origin)),
  }));
}

export function renameSession(id: string, origin: string, name: string) {
  sessionsStore.setState((state) => ({
    ...state,
    sessions: state.sessions.map((s) => (s.id === id && s.origin === origin ? { ...s, name } : s)),
  }));
}

export async function clearSessions(): Promise<void> {
  const sessions = sessionsStore.state.sessions;
  await Promise.allSettled(
    sessions.map((session) => removePairingCredential(session.origin, session.id)),
  );
  sessionsStore.setState((state) => ({
    ...state,
    sessions: [],
  }));
}
