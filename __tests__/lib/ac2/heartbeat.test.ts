import { attachHeartbeatChannel } from '@/lib/ac2/heartbeat';

describe('attachHeartbeatChannel', () => {
  function createChannel(readyState: RTCDataChannelState = 'open') {
    return {
      readyState,
      send: jest.fn(),
      onmessage: null,
      onopen: null,
      onclose: null,
    } as unknown as RTCDataChannel;
  }

  it('acknowledges an inbound ping and records liveness', () => {
    const channel = createChannel();
    const onPing = jest.fn();
    attachHeartbeatChannel(channel, { onPing });

    channel.onmessage?.({ data: 'ping' } as MessageEvent);

    expect(onPing).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('pong');
  });

  it('does not send on a closed channel or echo pong frames', () => {
    const closed = createChannel('closed');
    attachHeartbeatChannel(closed, { onPing: jest.fn() });
    closed.onmessage?.({ data: 'ping' } as MessageEvent);
    expect(closed.send).not.toHaveBeenCalled();

    const open = createChannel();
    attachHeartbeatChannel(open, { onPing: jest.fn() });
    open.onmessage?.({ data: 'pong' } as MessageEvent);
    expect(open.send).not.toHaveBeenCalled();
  });
});
