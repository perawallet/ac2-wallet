import { Store } from '@tanstack/react-store';

export interface UiState {
  drawerOpen: boolean;
  currentSessionId: string | null;
}

// Ephemeral UI state (not persisted): which session the Chat tab is showing
// and whether the chat drawer is open.
export const uiStore = new Store<UiState>({ drawerOpen: false, currentSessionId: null });

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
