import {
  closeDrawer,
  openDrawer,
  setCurrentConnection,
  setCurrentSession,
  toggleDrawer,
  uiStore,
} from '@/stores/ui';

describe('uiStore', () => {
  beforeEach(() =>
    uiStore.setState(() => ({
      drawerOpen: false,
      currentSessionId: null,
      currentOrigin: null,
      allowPasskeyCreation: false,
      activeThid: null,
    })),
  );

  it('opens, closes and toggles the drawer', () => {
    openDrawer();
    expect(uiStore.state.drawerOpen).toBe(true);
    closeDrawer();
    expect(uiStore.state.drawerOpen).toBe(false);
    toggleDrawer();
    expect(uiStore.state.drawerOpen).toBe(true);
  });

  it('sets the current session id', () => {
    setCurrentSession('req-123');
    expect(uiStore.state.currentSessionId).toBe('req-123');
  });

  it('sets the current connection origin and id', () => {
    setCurrentConnection('https://a.example', 'req-456');
    expect(uiStore.state.currentOrigin).toBe('https://a.example');
    expect(uiStore.state.currentSessionId).toBe('req-456');
    expect(uiStore.state.allowPasskeyCreation).toBe(false);
  });

  it('marks explicitly created connections as allowed to create a passkey', () => {
    setCurrentConnection('https://a.example', 'req-456', { allowPasskeyCreation: true });
    expect(uiStore.state.currentOrigin).toBe('https://a.example');
    expect(uiStore.state.currentSessionId).toBe('req-456');
    expect(uiStore.state.allowPasskeyCreation).toBe(true);
  });
});
