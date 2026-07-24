import { NativeDataChannel, NativePeerConnection } from '@/lib/ac2/nativeChannel';
import { monitorPeerConnection } from '@/lib/ac2/peerConnectionMonitor';

/**
 * Let the microtask queue drain so the shim's deferred backlog flush
 * (`queueMicrotask`) runs before assertions.
 */
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('NativeDataChannel', () => {
  it('starts connecting and forwards sends to the native channel by label', () => {
    const send = jest.fn();
    const channel = new NativeDataChannel('ac2-v1', send);

    expect(channel.label).toBe('ac2-v1');
    expect(channel.readyState).toBe('connecting');

    channel.send('hello');
    expect(send).toHaveBeenCalledWith('ac2-v1', 'hello');
  });

  it('maps uppercase native states to the RTCDataChannel readyState union', () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());

    channel.setState('OPEN');
    expect(channel.readyState).toBe('open');
    channel.setState('CLOSING');
    expect(channel.readyState).toBe('closing');
    channel.setState('CLOSED');
    expect(channel.readyState).toBe('closed');
  });

  it('fires onopen and "open" listeners on transition to open (once)', () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());
    const onopen = jest.fn();
    const listener = jest.fn();
    channel.onopen = onopen;
    channel.addEventListener('open', listener);

    channel.setState('OPEN');
    channel.setState('OPEN'); // no-op: already open

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('delivers inbound messages via onmessage and "message" listeners', () => {
    const channel = new NativeDataChannel('ac2-stream', jest.fn());
    const onmessage = jest.fn();
    const listener = jest.fn();
    channel.onmessage = onmessage;
    channel.addEventListener('message', listener);

    channel.dispatchMessage('frame');

    expect(onmessage).toHaveBeenCalledWith({ data: 'frame' });
    expect(listener).toHaveBeenCalledWith({ data: 'frame' });
  });

  it('buffers messages that arrive before a consumer attaches and flushes them on onmessage', async () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());
    // Messages replayed from the offline queue during hydrate arrive before the
    // SDK client wires `onmessage` on the control channel.
    channel.dispatchMessage('first');
    channel.dispatchMessage('second');

    const onmessage = jest.fn();
    channel.onmessage = onmessage;

    // The flush is deferred to a microtask so a consumer that wires its real
    // handlers on the lines AFTER assigning `onmessage` (like the AC2 SDK's
    // `rtcDataChannelTransport`) is fully ready before the backlog is replayed.
    // Nothing is delivered synchronously.
    expect(onmessage).not.toHaveBeenCalled();

    await flushMicrotasks();

    // After the microtask, the buffered messages arrive in order.
    expect(onmessage).toHaveBeenNthCalledWith(1, { data: 'first' });
    expect(onmessage).toHaveBeenNthCalledWith(2, { data: 'second' });
    expect(onmessage).toHaveBeenCalledTimes(2);
  });

  it('flushes buffered messages when a "message" listener is added', async () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());
    channel.dispatchMessage('buffered');

    const listener = jest.fn();
    channel.addEventListener('message', listener);

    await flushMicrotasks();

    expect(listener).toHaveBeenCalledWith({ data: 'buffered' });
  });

  it('preserves arrival order when a live frame arrives before the deferred flush', async () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());
    // Backlog buffered before any consumer.
    channel.dispatchMessage('backlog');

    const onmessage = jest.fn();
    channel.onmessage = onmessage;

    // A live frame arrives after the consumer attaches but before the deferred
    // flush runs — it must queue behind the backlog, not jump ahead.
    channel.dispatchMessage('live');
    expect(onmessage).not.toHaveBeenCalled();

    await flushMicrotasks();

    expect(onmessage).toHaveBeenNthCalledWith(1, { data: 'backlog' });
    expect(onmessage).toHaveBeenNthCalledWith(2, { data: 'live' });
    expect(onmessage).toHaveBeenCalledTimes(2);
  });

  it('does not re-deliver buffered messages once flushed', async () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());
    channel.dispatchMessage('once');

    const first = jest.fn();
    channel.onmessage = first;
    await flushMicrotasks();
    expect(first).toHaveBeenCalledTimes(1);

    // A later handler must not see the already-flushed backlog again.
    const second = jest.fn();
    channel.onmessage = second;
    await flushMicrotasks();
    expect(second).not.toHaveBeenCalled();
  });

  it('close() flips to closed and fires close once', () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());
    const onclose = jest.fn();
    channel.onclose = onclose;

    channel.close();
    channel.close();

    expect(channel.readyState).toBe('closed');
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('removeEventListener detaches a listener', () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());
    const listener = jest.fn();
    channel.addEventListener('open', listener);
    channel.removeEventListener('open', listener);

    channel.setState('OPEN');
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps dispatching even if a consumer handler throws', () => {
    const channel = new NativeDataChannel('ac2-v1', jest.fn());
    const listener = jest.fn();
    channel.onmessage = () => {
      throw new Error('boom');
    };
    channel.addEventListener('message', listener);

    expect(() => channel.dispatchMessage('x')).not.toThrow();
    expect(listener).toHaveBeenCalledWith({ data: 'x' });
  });
});

describe('NativePeerConnection', () => {
  it('lowercases native ICE states into iceConnectionState/connectionState', () => {
    const pc = new NativePeerConnection();
    pc.setConnectionState('CONNECTED');
    expect(pc.iceConnectionState).toBe('connected');
    expect(pc.connectionState).toBe('connected');
  });

  it('notifies iceconnectionstatechange listeners', () => {
    const pc = new NativePeerConnection();
    const listener = jest.fn();
    pc.addEventListener('iceconnectionstatechange', listener);

    pc.setConnectionState('DISCONNECTED');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pc.iceConnectionState).toBe('disconnected');
  });

  it('drives the real peerConnectionMonitor to failure on FAILED', () => {
    const pc = new NativePeerConnection();
    const onFailed = jest.fn();
    const dispose = monitorPeerConnection(pc as any, { onFailed });

    pc.setConnectionState('FAILED');

    expect(onFailed).toHaveBeenCalledWith('ice');
    dispose();
  });

  it('lets the monitor recover a transient disconnect before the grace window', () => {
    jest.useFakeTimers();
    try {
      const pc = new NativePeerConnection();
      const onFailed = jest.fn();
      const onRecovered = jest.fn();
      const dispose = monitorPeerConnection(pc as any, {
        onFailed,
        onRecovered,
        gracePeriodMs: 10000,
      });

      pc.setConnectionState('DISCONNECTED');
      pc.setConnectionState('CONNECTED');
      jest.advanceTimersByTime(10000);

      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(onFailed).not.toHaveBeenCalled();
      dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});
