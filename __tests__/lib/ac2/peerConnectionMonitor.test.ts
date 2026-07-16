import { monitorPeerConnection } from '@/lib/ac2/peerConnectionMonitor';

type FakePeerConnection = {
  iceConnectionState: string;
  connectionState: string;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  emit: (type: string) => void;
  listenerCount: (type: string) => number;
};

function createFakePeer(
  initial: { iceConnectionState?: string; connectionState?: string } = {},
): FakePeerConnection {
  const listeners: Record<string, Set<() => void>> = {};
  return {
    iceConnectionState: initial.iceConnectionState ?? 'new',
    connectionState: initial.connectionState ?? 'new',
    addEventListener(type, listener) {
      (listeners[type] ??= new Set()).add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type]?.delete(listener);
    },
    emit(type) {
      listeners[type]?.forEach((cb) => cb());
    },
    listenerCount(type) {
      return listeners[type]?.size ?? 0;
    },
  };
}

/** Deterministic timer harness capturing scheduled grace callbacks. */
function createTimerHarness() {
  const scheduled: { id: number; cb: () => void; ms: number }[] = [];
  let nextId = 1;
  return {
    setTimeoutFn: (cb: () => void, ms: number) => {
      const id = nextId++;
      scheduled.push({ id, cb, ms });
      return id;
    },
    clearTimeoutFn: (handle: number) => {
      const idx = scheduled.findIndex((s) => s.id === handle);
      if (idx !== -1) scheduled.splice(idx, 1);
    },
    /** Run the most recently scheduled (still pending) timer. */
    flush: () => {
      const next = scheduled.shift();
      next?.cb();
    },
    pendingCount: () => scheduled.length,
  };
}

describe('monitorPeerConnection', () => {
  it('reports failure when ICE reaches "failed" (while the channel stays open)', () => {
    const pc = createFakePeer({ iceConnectionState: 'connected' });
    const onFailed = jest.fn();
    monitorPeerConnection(pc as any, { onFailed });

    pc.iceConnectionState = 'failed';
    pc.emit('iceconnectionstatechange');

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith('ice');
  });

  it('does not fail when a "disconnected" recovers before the grace timer', () => {
    const pc = createFakePeer({ iceConnectionState: 'connected' });
    const onFailed = jest.fn();
    const onRecovered = jest.fn();
    const timers = createTimerHarness();
    monitorPeerConnection(pc as any, {
      onFailed,
      onRecovered,
      gracePeriodMs: 10000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    pc.iceConnectionState = 'disconnected';
    pc.emit('iceconnectionstatechange');
    expect(timers.pendingCount()).toBe(1);

    pc.iceConnectionState = 'connected';
    pc.emit('iceconnectionstatechange');

    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(0);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('fails when "disconnected" persists past the grace period', () => {
    const pc = createFakePeer({ iceConnectionState: 'connected' });
    const onFailed = jest.fn();
    const timers = createTimerHarness();
    monitorPeerConnection(pc as any, {
      onFailed,
      gracePeriodMs: 10000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    pc.iceConnectionState = 'disconnected';
    pc.emit('iceconnectionstatechange');
    timers.flush();

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith('ice');
  });

  it('reports failure immediately when the peer is already failed at attach', () => {
    const pc = createFakePeer({ iceConnectionState: 'failed' });
    const onFailed = jest.fn();
    monitorPeerConnection(pc as any, { onFailed });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('treats a terminal connectionState "failed" as failure (secondary signal)', () => {
    const pc = createFakePeer({ iceConnectionState: 'connected', connectionState: 'connected' });
    const onFailed = jest.fn();
    monitorPeerConnection(pc as any, { onFailed });

    pc.connectionState = 'failed';
    pc.emit('connectionstatechange');

    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('fires onFailed at most once across multiple transitions', () => {
    const pc = createFakePeer({ iceConnectionState: 'connected' });
    const onFailed = jest.fn();
    monitorPeerConnection(pc as any, { onFailed });

    pc.iceConnectionState = 'failed';
    pc.emit('iceconnectionstatechange');
    pc.connectionState = 'failed';
    pc.emit('connectionstatechange');
    pc.iceConnectionState = 'closed';
    pc.emit('iceconnectionstatechange');

    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels a pending grace timer and detaches listeners', () => {
    const pc = createFakePeer({ iceConnectionState: 'connected' });
    const onFailed = jest.fn();
    const timers = createTimerHarness();
    const dispose = monitorPeerConnection(pc as any, {
      onFailed,
      gracePeriodMs: 10000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    pc.iceConnectionState = 'disconnected';
    pc.emit('iceconnectionstatechange');
    expect(timers.pendingCount()).toBe(1);

    dispose();

    expect(timers.pendingCount()).toBe(0);
    expect(pc.listenerCount('iceconnectionstatechange')).toBe(0);
    expect(pc.listenerCount('connectionstatechange')).toBe(0);

    // A late transition after dispose must not fire onFailed.
    pc.iceConnectionState = 'failed';
    pc.emit('iceconnectionstatechange');
    expect(onFailed).not.toHaveBeenCalled();
  });
});
