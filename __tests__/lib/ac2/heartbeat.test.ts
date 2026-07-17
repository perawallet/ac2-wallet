import { attachHeartbeatChannel } from '@/lib/ac2/heartbeat';

type FakeHeartbeatChannel = {
  readyState: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  send: jest.Mock;
};

function createFakeChannel(readyState = 'open'): FakeHeartbeatChannel {
  return {
    readyState,
    onmessage: null,
    onopen: null,
    onclose: null,
    send: jest.fn(),
  };
}

describe('attachHeartbeatChannel', () => {
  it('replies pong to an inbound ping and reports liveness', () => {
    const channel = createFakeChannel('open');
    const onInbound = jest.fn();
    attachHeartbeatChannel(channel as any, { onInbound });

    channel.onmessage?.({ data: 'ping' });

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('pong');
  });

  it('reports liveness on an inbound pong without replying', () => {
    const channel = createFakeChannel('open');
    const onInbound = jest.fn();
    attachHeartbeatChannel(channel as any, { onInbound });

    channel.onmessage?.({ data: 'pong' });

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does not reply to a ping when the channel is not open', () => {
    const channel = createFakeChannel('closing');
    const onInbound = jest.fn();
    attachHeartbeatChannel(channel as any, { onInbound });

    channel.onmessage?.({ data: 'ping' });

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('counts a non-string frame as liveness without replying', () => {
    const channel = createFakeChannel('open');
    const onInbound = jest.fn();
    attachHeartbeatChannel(channel as any, { onInbound });

    channel.onmessage?.({ data: new ArrayBuffer(2) });

    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
  });
});
