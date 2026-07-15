import { closeSignalClient, closeSignalClientWhenSafe } from '@/lib/liquid-auth/signal-client';
import type { SignalClient } from '@algorandfoundation/liquid-client';

function createClient() {
  const peerClose = jest.fn();
  const close = jest.fn();
  const client = {
    close,
    peerClient: { close: peerClose },
  } as unknown as SignalClient;

  return { client, close, peerClose };
}

describe('closeSignalClient', () => {
  it('disconnects without closing an unsafe in-flight peer', () => {
    const { client, close, peerClose } = createClient();

    closeSignalClient(client, false);

    expect(close).toHaveBeenCalledWith(true, false);
    expect(peerClose).not.toHaveBeenCalled();
  });

  it('closes the peer for an established transport on the current client API', () => {
    const { client, close, peerClose } = createClient();

    closeSignalClient(client, true);

    expect(close).toHaveBeenCalledWith(true, true);
    expect(peerClose).toHaveBeenCalledTimes(1);
  });

  it('does not double-close when a future client clears its peer reference', () => {
    const { client, close, peerClose } = createClient();
    close.mockImplementation(() => {
      client.peerClient?.close();
      client.peerClient = undefined;
    });

    closeSignalClient(client, true);

    expect(close).toHaveBeenCalledWith(true, true);
    expect(peerClose).toHaveBeenCalledTimes(1);
  });

  it('uses upstream native-work tracking for deferred peer cleanup', async () => {
    const { client, close, peerClose } = createClient();
    const closePeerWhenSafe = jest.fn().mockResolvedValue(undefined);
    Object.assign(client, { closePeerWhenSafe });

    await closeSignalClientWhenSafe(client, 2500);

    expect(close).toHaveBeenCalledWith(true, false);
    expect(closePeerWhenSafe).toHaveBeenCalledWith(2500);
    expect(peerClose).not.toHaveBeenCalled();
  });

  it('bounds cleanup for a currently published client without native-work tracking', async () => {
    jest.useFakeTimers();
    try {
      const { client, close, peerClose } = createClient();

      const first = closeSignalClientWhenSafe(client, 2500);
      const duplicate = closeSignalClientWhenSafe(client, 2500);

      expect(duplicate).toBe(first);
      expect(close).toHaveBeenCalledTimes(1);
      expect(peerClose).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(2499);
      expect(peerClose).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await first;

      expect(peerClose).toHaveBeenCalledTimes(1);
      expect(client.peerClient).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
