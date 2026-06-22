import { render, screen, fireEvent } from '@testing-library/react-native';
import { AppHeader } from '@/components/navigation/AppHeader';
import { uiStore } from '@/stores/ui';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

describe('AppHeader', () => {
  beforeEach(() => {
    mockPush.mockClear();
    uiStore.setState(() => ({ drawerOpen: false, currentSessionId: null }));
  });

  it('toggles the drawer from the hamburger', () => {
    render(<AppHeader title="Chat" showActions />);
    fireEvent.press(screen.getByLabelText('Open chats'));
    expect(uiStore.state.drawerOpen).toBe(true);
  });

  it('pushes the scan overlay', () => {
    render(<AppHeader title="Chat" showActions />);
    fireEvent.press(screen.getByLabelText('Scan QR code'));
    expect(mockPush).toHaveBeenCalledWith('/scan');
  });
});
