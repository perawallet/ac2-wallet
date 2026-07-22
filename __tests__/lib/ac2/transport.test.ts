import {
  attachSignalingDiagnostics,
  installSignalCandidateNormalizer,
  normalizeIceCandidateForReactNative,
  waitForChannelOpen,
} from '@/lib/ac2/transport';

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
});

describe('attachSignalingDiagnostics', () => {
  // A minimal EventEmitter-shaped SignalClient stand-in.
  function createFakeSignalClient() {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    return {
      on(event: string, listener: (...args: any[]) => void) {
        (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
      },
      off(event: string, listener: (...args: any[]) => void) {
        listeners.get(event)?.delete(listener);
      },
      emit(event: string, ...args: any[]) {
        listeners.get(event)?.forEach((listener) => listener(...args));
      },
      listenerCount(event: string) {
        return listeners.get(event)?.size ?? 0;
      },
    };
  }

  it('logs a start line and each signaling milestone', () => {
    const client = createFakeSignalClient();
    const logs: string[] = [];

    attachSignalingDiagnostics(client as any, 'req-12345678', (m) => logs.push(m));

    expect(logs.some((m) => m.includes("peer('answer') started"))).toBe(true);

    client.emit('offer-description', 'sdp-offer');
    client.emit('answer-description', { type: 'answer', sdp: 'sdp-answer' });

    expect(logs.some((m) => m.includes('offer-description') && m.includes('SENT'))).toBe(true);
    expect(logs.some((m) => m.includes('answer-description') && m.includes('RECEIVED'))).toBe(true);
  });

  it('logs only the first candidate of each kind and reports totals on dispose', () => {
    const client = createFakeSignalClient();
    const logs: string[] = [];

    const dispose = attachSignalingDiagnostics(client as any, 'req-1', (m) => logs.push(m));

    client.emit('offer-candidate', {});
    client.emit('offer-candidate', {});
    client.emit('offer-candidate', {});

    const firstLines = logs.filter((m) => m.includes('offer-candidate'));
    expect(firstLines).toHaveLength(1);
    expect(firstLines[0]).toContain('(first)');

    dispose();
    expect(logs.some((m) => m.includes('diagnostics detached') && m.includes('offer-candidate=3'))).toBe(
      true,
    );
  });

  it('detaches every listener on dispose so a reused client does not accumulate handlers', () => {
    const client = createFakeSignalClient();

    const dispose = attachSignalingDiagnostics(client as any, 'req-1', () => {});
    expect(client.listenerCount('answer-description')).toBe(1);

    dispose();
    expect(client.listenerCount('answer-description')).toBe(0);
    expect(client.listenerCount('offer-description')).toBe(0);
    expect(client.listenerCount('data-channel')).toBe(0);
  });
});

describe('waitForChannelOpen', () => {
  type FakeChannel = {
    readyState: string;
    addEventListener: (type: string, cb: () => void) => void;
    removeEventListener: (type: string, cb: () => void) => void;
    emit: (type: string) => void;
    listenerCount: (type: string) => number;
  };

  function createFakeChannel(initialState = 'connecting'): FakeChannel {
    const listeners: Record<string, Set<() => void>> = {};
    return {
      readyState: initialState,
      addEventListener(type, cb) {
        (listeners[type] ??= new Set()).add(cb);
      },
      removeEventListener(type, cb) {
        listeners[type]?.delete(cb);
      },
      emit(type) {
        listeners[type]?.forEach((cb) => cb());
      },
      listenerCount(type) {
        return listeners[type]?.size ?? 0;
      },
    };
  }

  it('resolves immediately when the channel is already open', async () => {
    const channel = createFakeChannel('open');
    await expect(waitForChannelOpen(channel as any, 1000)).resolves.toBeUndefined();
  });

  it('resolves when the open event fires before the deadline and detaches listeners', async () => {
    const channel = createFakeChannel('connecting');
    const promise = waitForChannelOpen(channel as any, 1000);
    channel.readyState = 'open';
    channel.emit('open');
    await expect(promise).resolves.toBeUndefined();
    expect(channel.listenerCount('open')).toBe(0);
    expect(channel.listenerCount('close')).toBe(0);
    expect(channel.listenerCount('error')).toBe(0);
  });

  it('rejects when the channel never opens within the deadline', async () => {
    jest.useFakeTimers();
    try {
      const channel = createFakeChannel('connecting');
      const promise = waitForChannelOpen(channel as any, 15000);
      const assertion = expect(promise).rejects.toThrow(
        /Timed out waiting for the ac2-v1 DataChannel to open/,
      );
      jest.advanceTimersByTime(15000);
      await assertion;
      expect(channel.listenerCount('open')).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects with AbortError when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    const channel = createFakeChannel('connecting');
    const promise = waitForChannelOpen(channel as any, 1000, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const channel = createFakeChannel('connecting');
    await expect(waitForChannelOpen(channel as any, 1000, controller.signal)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
  });

  it('rejects when the channel closes before it opens', async () => {
    const channel = createFakeChannel('connecting');
    const promise = waitForChannelOpen(channel as any, 1000);
    const assertion = expect(promise).rejects.toThrow(/closed before it opened/);
    channel.emit('close');
    await assertion;
  });
});
