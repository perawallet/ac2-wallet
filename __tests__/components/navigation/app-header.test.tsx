import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppHeader } from '@/components/navigation/AppHeader';
import { networkStore, setNetwork } from '@/stores/network';
import { uiStore } from '@/stores/ui';
import React from 'react';

const mockPush = jest.fn();
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: jest.fn() }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('react-native-copilot', () => ({
  CopilotStep: ({ children }: { children: React.ReactElement }) => children,
  walkthroughable: (Component: React.ComponentType) => Component,
}));

describe('AppHeader', () => {
  beforeEach(() => {
    mockPush.mockClear();
    networkStore.setState(() => ({ network: 'testnet' }));
    uiStore.setState(() => ({
      drawerOpen: false,
      currentSessionId: null,
      currentOrigin: null,
      allowPasskeyCreation: false,
      activeThid: null,
    }));
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

  it('shows the current network', () => {
    render(<AppHeader title="Wallet" />);

    expect(screen.getByText('TestNet')).toBeTruthy();
    expect(screen.getByLabelText('Current network: TestNet')).toBeTruthy();
  });

  it('updates the network indicator when the network changes', () => {
    render(<AppHeader title="Menu" />);

    act(() => setNetwork('mainnet'));

    expect(screen.getByText('MainNet')).toBeTruthy();
    expect(screen.getByLabelText('Current network: MainNet')).toBeTruthy();
    expect(screen.queryByText('TestNet')).toBeNull();
  });
});
