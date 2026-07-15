import { Store } from '@tanstack/react-store';

export interface UiState {
  drawerOpen: boolean;
  currentSessionId: string | null;
  /**
   * Origin of the connection the Chat tab is showing. Tracked alongside the id
   * so the tab can render a freshly-scanned connection before its session row
   * exists in `sessionsStore` (the row is created by `useConnection`).
   */
  currentOrigin: string | null;
  /**
   * Whether the currently selected connection is allowed to create a platform
   * passkey. This should only be true for explicit fresh connection flows such
   * as scanning a QR code; passive app reopen should only assert existing keys.
   */
  allowPasskeyCreation: boolean;
  /**
   * The active conversation thread id on the current connection. Synced from
   * `ChatScreen` so the History modal can filter to the right thread.
   */
  activeThid: string | null;
}

// Ephemeral UI state (not persisted): which connection the Chat tab is showing
// and whether the chat drawer is open.
export const uiStore = new Store<UiState>({
  drawerOpen: false,
  currentSessionId: null,
  currentOrigin: null,
  allowPasskeyCreation: false,
  activeThid: null,
});

export function openDrawer() {
  uiStore.setState((s) => ({ ...s, drawerOpen: true }));
}
export function closeDrawer() {
  uiStore.setState((s) => ({ ...s, drawerOpen: false }));
}
export function toggleDrawer() {
  uiStore.setState((s) => ({ ...s, drawerOpen: !s.drawerOpen }));
}
export function setCurrentSession(id: string | null) {
  uiStore.setState((s) => ({ ...s, currentSessionId: id }));
}
/** Select the connection (origin + requestId) the Chat tab should display. */
export function setCurrentConnection(
  origin: string,
  requestId: string,
  options: { allowPasskeyCreation?: boolean } = {},
) {
  uiStore.setState((s) => ({
    ...s,
    currentOrigin: origin,
    currentSessionId: requestId,
    allowPasskeyCreation: options.allowPasskeyCreation ?? false,
  }));
}
/** Clear the currently-selected connection so the Chat tab returns to the empty state. */
export function clearCurrentConnection() {
  uiStore.setState((s) => ({
    ...s,
    currentOrigin: null,
    currentSessionId: null,
    allowPasskeyCreation: false,
    activeThid: null,
  }));
}
/** Consume the scanner-only permission after the first successful auth flow. */
export function consumePasskeyCreation() {
  uiStore.setState((s) => ({ ...s, allowPasskeyCreation: false }));
}
/** Sync the active conversation thread from `ChatScreen` so History can filter to it. */
export function setActiveThid(thid: string | null) {
  uiStore.setState((s) => ({ ...s, activeThid: thid }));
}
