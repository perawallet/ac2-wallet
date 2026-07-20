jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: () =>
      JSON.stringify([
        {
          id: 'request-123',
          origin: 'https://agent.example',
          pairing: {
            version: 2,
            pairingId: 'pairing-123',
            role: 'controller',
            storage: 'keychain',
          },
          timestamp: 1,
          status: 'closed',
          lastActivity: 1,
          ttl: 1,
        },
      ]),
    set: jest.fn(),
  }),
}));

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
}));

import { clearSessionPairingCredential, clearSessions, sessionsStore } from '@/stores/sessions';

describe('sessionsStore durable pairing migration', () => {
  it('keeps legacy TTL sessions until explicit removal and clears their secure credential', async () => {
    expect(sessionsStore.state.sessions).toHaveLength(1);
    expect(sessionsStore.state.sessions[0]).toEqual(
      expect.objectContaining({
        id: 'request-123',
        pairingStatus: 'paired',
      }),
    );
    expect(sessionsStore.state.sessions[0]).not.toHaveProperty('ttl');

    await clearSessionPairingCredential('request-123', 'https://agent.example');

    expect(sessionsStore.state.sessions[0]).toEqual(
      expect.objectContaining({
        pairing: undefined,
        pairingStatus: 'legacy',
        status: 'closed',
      }),
    );

    await clearSessions();

    expect(sessionsStore.state.sessions).toEqual([]);
    expect(jest.requireMock('react-native-keychain').resetGenericPassword).toHaveBeenCalledWith(
      expect.objectContaining({ service: expect.stringContaining('liquid-pairing') }),
    );
  });
});
