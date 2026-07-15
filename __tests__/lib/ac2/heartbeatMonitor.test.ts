import { createHeartbeatMonitor } from '@/lib/ac2/heartbeatMonitor';

/** Deterministic clock + single-interval harness. */
function createHarness() {
  let now = 0;
  let intervalCb: (() => void) | null = null;
  let nextId = 1;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setIntervalFn: (cb: () => void, _ms: number) => {
      intervalCb = cb;
      return nextId++;
    },
    clearIntervalFn: () => {
      intervalCb = null;
    },
    /** Simulate the interval firing at the current time. */
    tick: () => intervalCb?.(),
    hasInterval: () => intervalCb !== null,
  };
}

describe('createHeartbeatMonitor', () => {
  it('sends an immediate ping on start, then one per interval tick', () => {
    const send = jest.fn();
    const h = createHarness();
    const monitor = createHeartbeatMonitor({
      send,
      intervalMs: 20000,
      timeoutMs: 45000,
      onTimeout: jest.fn(),
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    monitor.start();
    expect(send).toHaveBeenCalledTimes(1);

    h.advance(20000);
    h.tick();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('times out once after the peer is silent past the deadline, then stops', () => {
    const send = jest.fn();
    const onTimeout = jest.fn();
    const h = createHarness();
    const monitor = createHeartbeatMonitor({
      send,
      intervalMs: 20000,
      timeoutMs: 45000,
      onTimeout,
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    monitor.start(); // t=0, send #1
    h.advance(20000);
    h.tick(); // t=20s < 45s → send #2
    h.advance(20000);
    h.tick(); // t=40s < 45s → send #3
    const sendsBeforeTimeout = send.mock.calls.length;
    h.advance(20000);
    h.tick(); // t=60s >= 45s → timeout, stop, no send

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(h.hasInterval()).toBe(false);
    // No ping is sent on the tick that declares failure.
    expect(send).toHaveBeenCalledTimes(sendsBeforeTimeout);
  });

  it('noteInbound resets the deadline so an active peer never times out', () => {
    const onTimeout = jest.fn();
    const h = createHarness();
    const monitor = createHeartbeatMonitor({
      send: jest.fn(),
      intervalMs: 20000,
      timeoutMs: 45000,
      onTimeout,
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    monitor.start();
    for (let i = 0; i < 5; i++) {
      h.advance(40000);
      monitor.noteInbound(); // pong arrived just now
      h.tick(); // now - lastInbound == 0 < 45s
    }

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('stop() halts pinging and prevents any timeout', () => {
    const onTimeout = jest.fn();
    const h = createHarness();
    const monitor = createHeartbeatMonitor({
      send: jest.fn(),
      intervalMs: 20000,
      timeoutMs: 45000,
      onTimeout,
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    monitor.start();
    monitor.stop();
    expect(h.hasInterval()).toBe(false);

    h.advance(100000);
    h.tick(); // interval cleared — no-op

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('never times out when timeoutMs is Infinity (fallback keepalive)', () => {
    const send = jest.fn();
    const onTimeout = jest.fn();
    const h = createHarness();
    const monitor = createHeartbeatMonitor({
      send,
      intervalMs: 20000,
      timeoutMs: Infinity,
      onTimeout,
      now: h.now,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    monitor.start();
    h.advance(10_000_000);
    h.tick();

    expect(onTimeout).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
