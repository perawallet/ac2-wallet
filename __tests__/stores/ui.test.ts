import { uiStore, openDrawer, closeDrawer, toggleDrawer, setCurrentSession } from '@/stores/ui';

describe('uiStore', () => {
  beforeEach(() => uiStore.setState(() => ({ drawerOpen: false, currentSessionId: null })));

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
});
