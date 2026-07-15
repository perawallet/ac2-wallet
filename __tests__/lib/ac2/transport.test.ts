import {
  createAc2Transport,
  installSignalCandidateNormalizer,
  normalizeIceCandidateForReactNative,
  waitForSignalSocketConnected,
} from '@/lib/ac2/transport';
import { classifyConnectionFailure } from '@/lib/liquid-auth/connection-errors';

describe('normalizeIceCandidateForReactNative', () => {
  it('strips aiortc-style SDP line prefixes from ICE candidates', () => {
    const candidate = {
      candidate: 'a=candidate:1 1 UDP 2116026367 10.0.0.64 58151 typ host',
      sdpMLineIndex: null,
      sdpMid: '0',
      usernameFragment: null,
    };

    expect(normalizeIceCandidateForReactNative(candidate)).toEqual({
      candidate: 'candidate:1 1 UDP 2116026367 10.0.0.64 58151 typ host',
      sdpMLineIndex: 0,
      sdpMid: '0',
    });
  });

  it('leaves browser-style ICE candidates unchanged', () => {
    const candidate = {
      candidate: 'candidate:2079853774 1 udp 2122194687 10.0.0.98 55266 typ host',
      sdpMLineIndex: 0,
      sdpMid: '0',
    };

    expect(normalizeIceCandidateForReactNative(candidate)).toEqual(candidate);
  });

  it('removes null candidate fields before crossing the native bridge', () => {
    const candidate = {
      candidate: 'candidate:2 1 UDP 2114977535 10.0.0.64 58151 typ host',
      sdpMLineIndex: null,
      sdpMid: null,
      usernameFragment: null,
    };

    expect(normalizeIceCandidateForReactNative(candidate)).toEqual({
      candidate: 'candidate:2 1 UDP 2114977535 10.0.0.64 58151 typ host',
    });
  });
});

describe('createAc2Transport cancellation', () => {
  function createPendingSignalClient() {
    const peerClient = { close: jest.fn() };
    const socket: any = {
      connected: true,
      on: jest.fn().mockReturnThis(),
      off: jest.fn().mockReturnThis(),
      once: jest.fn().mockReturnThis(),
    };
    const signalClient: any = {
      socket,
      peerClient,
      on: jest.fn().mockReturnThis(),
      peer: jest.fn(() => new Promise<RTCDataChannel>(() => undefined)),
      close: jest.fn(),
      closePeerWhenSafe: jest.fn().mockResolvedValue(undefined),
    };
    return { signalClient, peerClient };
  }

  it('detaches signaling on abort without hard-closing an in-flight native peer', async () => {
    const { signalClient, peerClient } = createPendingSignalClient();
    const controller = new AbortController();
    const result = createAc2Transport({
      requestId: 'pairing-123456789',
      signalClient,
      onSideChannel: jest.fn(),
      signal: controller.signal,
    });
    await Promise.resolve();

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(signalClient.close).toHaveBeenCalledWith(true, false);
    expect(signalClient.closePeerWhenSafe).toHaveBeenCalledWith(10_000);
    expect(peerClient.close).not.toHaveBeenCalled();
  });

  it('detaches signaling on timeout without hard-closing an in-flight native peer', async () => {
    jest.useFakeTimers();
    try {
      const { signalClient, peerClient } = createPendingSignalClient();
      const result = createAc2Transport({
        requestId: 'pairing-123456789',
        signalClient,
        onSideChannel: jest.fn(),
      });
      await Promise.resolve();
      const rejection = expect(result).rejects.toThrow(
        'Timed out waiting for Liquid Auth answer-description',
      );

      await jest.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(signalClient.close).toHaveBeenCalledWith(true, false);
      expect(signalClient.closePeerWhenSafe).toHaveBeenCalledWith(10_000);
      expect(peerClient.close).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('installSignalCandidateNormalizer', () => {
  it('normalizes candidate events before invoking socket listeners', () => {
    const listeners = new Map<string, (...args: any[]) => unknown>();
    type MockSocket = {
      on: jest.Mock<MockSocket, [string, (...args: any[]) => unknown]>;
    };
    const socket: MockSocket = {
      on: jest.fn<MockSocket, [string, (...args: any[]) => unknown]>((event, listener) => {
        listeners.set(event, listener);
        return socket;
      }),
    };
    const signalClient = { socket } as any;
    const listener = jest.fn();

    installSignalCandidateNormalizer(signalClient);
    socket.on('answer-candidate', listener);
    listeners.get('answer-candidate')?.(
      {
        candidate: 'a=candidate:2 1 UDP 2114977535 10.0.0.64 58151 typ host',
        sdpMLineIndex: null,
        sdpMid: '0',
      },
      'extra-arg',
    );

    expect(listener).toHaveBeenCalledWith(
      {
        candidate: 'candidate:2 1 UDP 2114977535 10.0.0.64 58151 typ host',
        sdpMLineIndex: 0,
        sdpMid: '0',
      },
      'extra-arg',
    );
  });

  it.each(['off', 'removeListener'] as const)(
    'removes the wrapped listener by its original identity through %s',
    (removalMethod) => {
      const listeners = new Map<string, ((...args: any[]) => unknown)[]>();
      const socket: any = {
        on(event: string, listener: (...args: any[]) => unknown) {
          const current = listeners.get(event) ?? [];
          current.push(listener);
          listeners.set(event, current);
          return socket;
        },
        off(event: string, listener?: (...args: any[]) => unknown) {
          if (!listener) {
            listeners.delete(event);
            return socket;
          }
          const current = listeners.get(event) ?? [];
          const index = current.findIndex(
            (candidate: any) => candidate === listener || candidate.fn === listener,
          );
          if (index >= 0) current.splice(index, 1);
          return socket;
        },
        removeListener(event: string, listener?: (...args: any[]) => unknown) {
          return socket.off(event, listener);
        },
        listenerCount(event: string) {
          return listeners.get(event)?.length ?? 0;
        },
      };
      const listener = jest.fn();

      installSignalCandidateNormalizer({ socket } as any);
      socket.on('answer-candidate', listener);
      expect(socket.listenerCount('answer-candidate')).toBe(1);

      socket[removalMethod]('answer-candidate', listener);

      expect(socket.listenerCount('answer-candidate')).toBe(0);
    },
  );

  it('normalizes a once listener and removes its wrapper after the first event', () => {
    const listeners = new Map<string, ((...args: any[]) => unknown)[]>();
    const socket: any = {
      on(event: string, listener: (...args: any[]) => unknown) {
        const current = listeners.get(event) ?? [];
        current.push(listener);
        listeners.set(event, current);
        return socket;
      },
      off(event: string, listener?: (...args: any[]) => unknown) {
        if (!listener) {
          listeners.delete(event);
          return socket;
        }
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
        return socket;
      },
      removeListener(event: string, listener?: (...args: any[]) => unknown) {
        return socket.off(event, listener);
      },
      once(event: string, listener: (...args: any[]) => unknown) {
        return socket.on(event, listener);
      },
      listenerCount(event: string) {
        return listeners.get(event)?.length ?? 0;
      },
    };
    const listener = jest.fn();

    installSignalCandidateNormalizer({ socket } as any);
    socket.once('offer-candidate', listener);
    const wrapped = listeners.get('offer-candidate')?.[0];
    wrapped?.({ candidate: 'a=candidate:3 1 UDP 1 10.0.0.1 1234 typ host' });

    expect(listener).toHaveBeenCalledWith({
      candidate: 'candidate:3 1 UDP 1 10.0.0.1 1234 typ host',
    });
    expect(socket.listenerCount('offer-candidate')).toBe(0);
  });
});

describe('waitForSignalSocketConnected', () => {
  function createSignalClient() {
    const listeners = new Map<string, (...args: any[]) => void>();
    const socket = {
      connected: false,
      on: jest.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
      }),
      off: jest.fn((event: string, listener: (...args: any[]) => void) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      }),
    };
    return {
      listeners,
      signalClient: { _socketPromise: Promise.resolve(), socket } as any,
    };
  }

  it('keeps waiting after a recoverable Socket.IO transport error', async () => {
    const { listeners, signalClient } = createSignalClient();
    const connected = waitForSignalSocketConnected(signalClient);
    await Promise.resolve();

    listeners.get('connect_error')?.(new Error('xhr poll error'));
    listeners.get('connect')?.();

    await expect(connected).resolves.toBeUndefined();
  });

  it('does not delete a pairing for a generic proxy authorization error', async () => {
    const { listeners, signalClient } = createSignalClient();
    const connected = waitForSignalSocketConnected(signalClient);
    await Promise.resolve();

    listeners.get('connect_error')?.(
      Object.assign(new Error('unauthorized'), { data: { status: 401 } }),
    );
    listeners.get('connect')?.();

    await expect(connected).resolves.toBeUndefined();
  });

  it('fails immediately when the agent revoked the pairing', async () => {
    const { listeners, signalClient } = createSignalClient();
    const connected = waitForSignalSocketConnected(signalClient);
    await Promise.resolve();
    const error = Object.assign(new Error('unauthorized'), {
      data: { code: 'PAIRING_REVOKED' },
    });

    listeners.get('connect_error')?.(error);

    await expect(connected).rejects.toBe(error);
  });

  it('fails immediately when an explicit controller credential is unauthorized', async () => {
    const { listeners, signalClient } = createSignalClient();
    const connected = waitForSignalSocketConnected(signalClient);
    await Promise.resolve();
    const error = Object.assign(new Error('unauthorized'), {
      data: { code: 'PAIRING_UNAUTHORIZED' },
    });

    listeners.get('connect_error')?.(error);

    await expect(connected).rejects.toBe(error);
  });
});

describe('connection recovery classification', () => {
  it('refreshes an explicitly unauthorized durable credential without treating it as revoked', () => {
    const error = Object.assign(new Error('credential rejected'), {
      data: { code: 'PAIRING_UNAUTHORIZED' },
    });

    expect(classifyConnectionFailure(error, true)).toBe('pairing-unauthorized');
  });

  it('forgets only an explicitly revoked pairing', () => {
    expect(classifyConnectionFailure({ code: 'PAIRING_REVOKED' }, true)).toBe('pairing-revoked');
  });

  it('keeps status-only and transport authorization errors retryable', () => {
    expect(
      classifyConnectionFailure(
        Object.assign(new Error('proxy unauthorized'), { data: { status: 401 } }),
        true,
      ),
    ).toBe('transient');
    expect(classifyConnectionFailure(new Error('xhr poll error'), true)).toBe('transient');
  });
});
