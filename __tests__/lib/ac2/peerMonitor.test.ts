import { attachPeerConnectionMonitor } from '@/lib/ac2/peerMonitor';

type Listener = () => void;

function makeFakePeer(initial: { ice?: string; conn?: string } = {}) {
  const listeners: Record<string, Listener[]> = {};
  return {
    iceConnectionState: initial.ice ?? 'connected',
    connectionState: initial.conn ?? 'connected',
    addEventListener: jest.fn((event: string, listener: Listener) => {
      (listeners[event] ||= []).push(listener);
    }),
    removeEventListener: jest.fn((event: string, listener: Listener) => {
      listeners[event] = (listeners[event] || []).filter((l) => l !== listener);
    }),
    emit(event: string) {
      (listeners[event] || []).forEach((l) => l());
    },
    listenerCount(event: string) {
      return (listeners[event] || []).length;
    },
  };
}

describe('attachPeerConnectionMonitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('returns a no-op detach for an incompatible peer', () => {
    const onDrop = jest.fn();
    const detach = attachPeerConnectionMonitor(null, { onDrop, disconnectGraceMs: 1000 });
    expect(() => detach()).not.toThrow();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('drops immediately on ICE failed', () => {
    const peer = makeFakePeer();
    const onDrop = jest.fn();
    attachPeerConnectionMonitor(peer, { onDrop, disconnectGraceMs: 1000 });

    peer.iceConnectionState = 'failed';
    peer.emit('iceconnectionstatechange');

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('ICE connection failed');
  });

  it('drops on peer connection failed/closed', () => {
    const peer = makeFakePeer();
    const onDrop = jest.fn();
    attachPeerConnectionMonitor(peer, { onDrop, disconnectGraceMs: 1000 });

    peer.connectionState = 'closed';
    peer.emit('connectionstatechange');

    expect(onDrop).toHaveBeenCalledWith('peer connection closed');
  });

  it('waits the grace period before dropping on a transient disconnect', () => {
    const peer = makeFakePeer();
    const onDrop = jest.fn();
    attachPeerConnectionMonitor(peer, { onDrop, disconnectGraceMs: 1000 });

    peer.iceConnectionState = 'disconnected';
    peer.emit('iceconnectionstatechange');
    expect(onDrop).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    expect(onDrop).toHaveBeenCalledWith('ICE disconnected (grace elapsed)');
  });

  it('cancels the pending drop when ICE recovers within the grace window', () => {
    const peer = makeFakePeer();
    const onDrop = jest.fn();
    attachPeerConnectionMonitor(peer, { onDrop, disconnectGraceMs: 1000 });

    peer.iceConnectionState = 'disconnected';
    peer.emit('iceconnectionstatechange');

    peer.iceConnectionState = 'connected';
    peer.emit('iceconnectionstatechange');

    jest.advanceTimersByTime(1000);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('does not stack grace timers on repeated disconnect events', () => {
    const peer = makeFakePeer();
    const onDrop = jest.fn();
    attachPeerConnectionMonitor(peer, { onDrop, disconnectGraceMs: 1000 });

    peer.iceConnectionState = 'disconnected';
    peer.emit('iceconnectionstatechange');
    peer.emit('iceconnectionstatechange');

    jest.advanceTimersByTime(1000);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('detach removes listeners and cancels a pending grace timer', () => {
    const peer = makeFakePeer();
    const onDrop = jest.fn();
    const detach = attachPeerConnectionMonitor(peer, { onDrop, disconnectGraceMs: 1000 });

    peer.iceConnectionState = 'disconnected';
    peer.emit('iceconnectionstatechange');

    detach();
    expect(peer.listenerCount('iceconnectionstatechange')).toBe(0);
    expect(peer.listenerCount('connectionstatechange')).toBe(0);

    jest.advanceTimersByTime(1000);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
