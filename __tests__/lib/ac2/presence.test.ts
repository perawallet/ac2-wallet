import {
  hasPeerPresence,
  isPeerOffline,
  isPeerUnreachableError,
  normalizePresence,
  PRESENCE_EVENT,
  queryPresence,
  subscribeToPresence,
} from '@/lib/ac2/presence';

type Ack = (data: unknown) => void;

/** Minimal socket.io-like mock capturing the presence emit + broadcasts. */
function createFakeSocket() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let lastEmit: { event: string; payload: unknown; ack?: Ack } | undefined;
  return {
    lastEmit: () => lastEmit,
    emit(event: string, payload: unknown, ack?: Ack) {
      lastEmit = { event, payload, ack };
    },
    on(event: string, listener: (...args: any[]) => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
    },
    off(event: string, listener: (...args: any[]) => void) {
      listeners.get(event)?.delete(listener);
    },
    broadcast(event: string, ...args: any[]) {
      listeners.get(event)?.forEach((l) => l(...args));
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

describe('normalizePresence', () => {
  it('passes through a well-formed payload', () => {
    expect(normalizePresence('req-1', { requestId: 'req-1', deviceCount: 2, online: true })).toEqual(
      { requestId: 'req-1', deviceCount: 2, online: true },
    );
  });

  it('derives online from deviceCount when missing and falls back to the queried id', () => {
    expect(normalizePresence('req-2', { deviceCount: 3 })).toEqual({
      requestId: 'req-2',
      deviceCount: 3,
      online: true,
    });
    expect(normalizePresence('req-3', {})).toEqual({
      requestId: 'req-3',
      deviceCount: 0,
      online: false,
    });
  });

  it('tolerates a null/undefined payload', () => {
    expect(normalizePresence('req-4', null)).toEqual({
      requestId: 'req-4',
      deviceCount: 0,
      online: false,
    });
  });
});

describe('queryPresence', () => {
  it('emits the presence event and resolves with the server ack', async () => {
    const socket = createFakeSocket();
    const pending = queryPresence(socket, 'req-1');
    const emit = socket.lastEmit();
    expect(emit?.event).toBe(PRESENCE_EVENT);
    expect(emit?.payload).toEqual({ requestId: 'req-1' });
    emit?.ack?.({ requestId: 'req-1', deviceCount: 2, online: true });
    await expect(pending).resolves.toEqual({ requestId: 'req-1', deviceCount: 2, online: true });
  });

  it('rejects on an empty requestId without emitting', async () => {
    const socket = createFakeSocket();
    await expect(queryPresence(socket, '')).rejects.toThrow(/non-empty requestId/);
    expect(socket.lastEmit()).toBeUndefined();
  });

  it('rejects when no ack arrives within the timeout', async () => {
    jest.useFakeTimers();
    try {
      const socket = createFakeSocket();
      const pending = queryPresence(socket, 'req-1', { timeoutMs: 5000 });
      const assertion = expect(pending).rejects.toThrow(/Timed out waiting for presence ack/);
      jest.advanceTimersByTime(5000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a late ack after the timeout already rejected', async () => {
    jest.useFakeTimers();
    try {
      const socket = createFakeSocket();
      const pending = queryPresence(socket, 'req-1', { timeoutMs: 1000 });
      const assertion = expect(pending).rejects.toThrow(/Timed out/);
      jest.advanceTimersByTime(1000);
      await assertion;
      // A late ack must not throw or double-settle.
      expect(() => socket.lastEmit()?.ack?.({ deviceCount: 1 })).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects if the socket emit throws', async () => {
    const socket = {
      emit: () => {
        throw new Error('socket down');
      },
    };
    await expect(queryPresence(socket as any, 'req-1')).rejects.toThrow('socket down');
  });
});

describe('subscribeToPresence', () => {
  it('forwards normalized broadcasts and unsubscribes cleanly', () => {
    const socket = createFakeSocket();
    const seen: unknown[] = [];
    const unsubscribe = subscribeToPresence(socket, (p) => seen.push(p));

    socket.broadcast(PRESENCE_EVENT, { requestId: 'req-1', deviceCount: 1, online: true });
    socket.broadcast(PRESENCE_EVENT, { requestId: 'req-1', deviceCount: 0 });

    expect(seen).toEqual([
      { requestId: 'req-1', deviceCount: 1, online: true },
      { requestId: 'req-1', deviceCount: 0, online: false },
    ]);

    unsubscribe();
    expect(socket.listenerCount(PRESENCE_EVENT)).toBe(0);
  });

  it('is a no-op against a socket without on/off', () => {
    const unsubscribe = subscribeToPresence({ emit: () => {} }, () => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it('is a no-op against a null/undefined socket', () => {
    // A SignalClient initializes its socket asynchronously, so `client.socket`
    // can still be undefined when a caller subscribes. This must not throw
    // "Cannot read property 'on' of undefined".
    expect(() => subscribeToPresence(undefined, () => {})()).not.toThrow();
    expect(() => subscribeToPresence(null, () => {})()).not.toThrow();
  });
});

describe('isPeerOffline', () => {
  it('treats a missing snapshot as unknown (not offline)', () => {
    expect(isPeerOffline(null)).toBe(false);
    expect(isPeerOffline(undefined)).toBe(false);
  });

  it('is offline when only the wallet (or nobody) is in the room', () => {
    expect(isPeerOffline({ requestId: 'req-1', deviceCount: 0, online: false })).toBe(true);
    expect(isPeerOffline({ requestId: 'req-1', deviceCount: 1, online: true })).toBe(true);
  });

  it('is not offline when a peer is present alongside the wallet', () => {
    expect(isPeerOffline({ requestId: 'req-1', deviceCount: 2, online: true })).toBe(false);
    expect(isPeerOffline({ requestId: 'req-1', deviceCount: 3, online: true })).toBe(false);
  });
});

describe('isPeerUnreachableError', () => {
  it('matches the answer-description signaling timeout', () => {
    expect(
      isPeerUnreachableError(
        new Error(
          'Timed out waiting for Liquid Auth answer-description. Check that the signaling socket is authenticated and the OpenClaw peer is still linked to this requestId.',
        ),
      ),
    ).toBe(true);
  });

  it('ignores unrelated errors and non-error inputs', () => {
    expect(isPeerUnreachableError(new Error('ICE connection failed'))).toBe(false);
    expect(isPeerUnreachableError(null)).toBe(false);
    expect(isPeerUnreachableError(undefined)).toBe(false);
    expect(isPeerUnreachableError({} as any)).toBe(false);
  });
});

describe('hasPeerPresence', () => {
  it('resolves true when at least one device is connected', async () => {
    const socket = createFakeSocket();
    const pending = hasPeerPresence(socket, 'req-1');
    socket.lastEmit()?.ack?.({ requestId: 'req-1', deviceCount: 1, online: true });
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when nobody is connected', async () => {
    const socket = createFakeSocket();
    const pending = hasPeerPresence(socket, 'req-1');
    socket.lastEmit()?.ack?.({ requestId: 'req-1', deviceCount: 0, online: false });
    await expect(pending).resolves.toBe(false);
  });

  it('swallows query errors into false', async () => {
    await expect(hasPeerPresence({ emit: () => {} }, '')).resolves.toBe(false);
  });
});
