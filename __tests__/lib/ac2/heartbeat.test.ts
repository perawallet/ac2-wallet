import { attachHeartbeatChannel, sendHeartbeatPing } from '@/lib/ac2/heartbeat';

type FakeHeartbeatChannel = {
  readyState: string;
  bufferedAmount: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  send: jest.Mock;
};

function createFakeChannel(readyState = 'open'): FakeHeartbeatChannel {
  return {
    readyState,
    bufferedAmount: 0,
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

describe('sendHeartbeatPing', () => {
  const WARN_BYTES = 256 * 1024;

  it('sends a ping on an open heartbeat channel', () => {
    const channel = createFakeChannel('open');

    expect(sendHeartbeatPing(channel as any, WARN_BYTES)).toBe(true);
    expect(channel.send).toHaveBeenCalledWith('ping');
  });

  it('reports unsendable when there is no heartbeat channel at all', () => {
    // The heartbeat channel is the SOLE keepalive path: there is no `ac2-v1`
    // fallback (it has no pong contract, so a ping there could never prove
    // liveness — a probe over it would hard-reset a healthy quiet session).
    expect(sendHeartbeatPing(null, WARN_BYTES)).toBe(false);
  });

  it('reports unsendable (and sends nothing) when the heartbeat channel is not open', () => {
    const channel = createFakeChannel('closed');

    expect(sendHeartbeatPing(channel as any, WARN_BYTES)).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('still pings (with a diagnostic) when the send buffer is backing up', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const channel = createFakeChannel('open');
      channel.bufferedAmount = WARN_BYTES + 1;

      expect(sendHeartbeatPing(channel as any, WARN_BYTES)).toBe(true);
      expect(channel.send).toHaveBeenCalledWith('ping');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Heartbeat send buffer high'));
    } finally {
      warn.mockRestore();
    }
  });

  it('propagates a send failure so callers can treat the transport as dead', () => {
    const channel = createFakeChannel('open');
    channel.send.mockImplementation(() => {
      throw new Error('send failed');
    });

    expect(() => sendHeartbeatPing(channel as any, WARN_BYTES)).toThrow('send failed');
  });
});
