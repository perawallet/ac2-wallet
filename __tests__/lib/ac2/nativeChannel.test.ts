import { NativeDataChannel, NativePeerConnection } from '@/lib/ac2/nativeChannel';
import { monitorPeerConnection } from '@/lib/ac2/peerConnectionMonitor';

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
