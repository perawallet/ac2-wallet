import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => {} }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('expo-router', () => ({ Stack: { Screen: () => null } }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import ProfileOverlay from '@/app/profile';
import { agentIdentitiesStore } from '@/stores/agentIdentities';
import { uiStore } from '@/stores/ui';

const clipboardMock = Clipboard.setStringAsync as jest.MockedFunction<
  typeof Clipboard.setStringAsync
>;

const ORIGIN = 'https://agent.example';
const REQUEST_ID = 'request-1';
const AGENT_DID = 'did:key:zAgent';

/**
 * Mounts the screen with no connection, then points it at a granted identity.
 * Seeding after mount keeps the store notifications inside `act`.
 */
async function renderWithGrantedIdentity() {
  render(<ProfileOverlay />);
  await act(async () => {
    uiStore.setState((s) => ({ ...s, currentSessionId: REQUEST_ID, currentOrigin: ORIGIN }));
    agentIdentitiesStore.setState(() => ({
      identities: [
        {
          id: 'identity-1',
          keyId: 'key-1',
          publicKey: 'cHVibGlj',
          agentDid: AGENT_DID,
          controllerDid: 'did:key:zController',
          origin: ORIGIN,
          requestId: REQUEST_ID,
          createdAt: 1_700_000_000_000,
        },
      ],
    }));
  });
}

describe('ProfileOverlay copy feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clipboardMock.mockResolvedValue(true);
    (Haptics.notificationAsync as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    Platform.OS = 'ios';
    await act(async () => {
      agentIdentitiesStore.setState(() => ({ identities: [] }));
      uiStore.setState((s) => ({ ...s, currentSessionId: null, currentOrigin: null }));
    });
  });

  it('shows a toast after copying a detail row on iOS', async () => {
    await renderWithGrantedIdentity();

    fireEvent.press(screen.getByText('Agent DID'));

    await waitFor(() => expect(clipboardMock).toHaveBeenCalledWith(AGENT_DID));
    expect(await screen.findByText('Copied to clipboard')).toBeTruthy();
  });

  // Android already shows a system confirmation for clipboard writes, so ours
  // would be a second, redundant "Copied" message.
  it('leaves the copy confirmation to the OS on Android', async () => {
    Platform.OS = 'android';
    await renderWithGrantedIdentity();

    fireEvent.press(screen.getByText('Agent DID'));

    await waitFor(() => expect(clipboardMock).toHaveBeenCalledWith(AGENT_DID));
    expect(screen.queryByText('Copied to clipboard')).toBeNull();
  });
});
