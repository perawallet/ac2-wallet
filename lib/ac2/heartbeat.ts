/**
 * Wiring for the dedicated `ac2-heartbeat` DataChannel. Inbound frames
 * count as peer liveness; the channel is out-of-band relative to the
 * AC2 control plane (`ac2-v1`) so keepalive never collides with framing.
 */

export interface HeartbeatChannelOptions {
  /** Called on every inbound heartbeat frame (ping or pong) as proof of peer liveness. */
  onInbound: () => void;
}

/**
 * Put one keepalive `ping` on the wire — on the dedicated `ac2-heartbeat`
 * channel ONLY, the one channel with a pong contract (both sides always
 * negotiate it; `ac2-v1` has no pong contract, so a ping there could never
 * prove liveness). Returns `false` when the heartbeat channel is not open —
 * itself evidence the transport is broken when a snapshot claims connected;
 * throws whatever the channel throws, so callers can treat a failed send as a
 * dead transport.
 *
 * @param bufferedWarnBytes a send buffer above this logs a stall diagnostic:
 *   frames aren't draining to the peer even though ICE hasn't flipped yet.
 */
export function sendHeartbeatPing(
  channel: Pick<RTCDataChannel, 'readyState' | 'bufferedAmount' | 'send'> | null,
  bufferedWarnBytes: number,
): boolean {
  if (!channel || channel.readyState !== 'open') return false;
  if (channel.bufferedAmount > bufferedWarnBytes) {
    console.warn(
      `Heartbeat send buffer high (${channel.bufferedAmount} bytes) — transport may be stalling`,
    );
  }
  channel.send('ping');
  return true;
}

/**
 * Attach handlers to a discovered `ac2-heartbeat` DataChannel. Returns the
 * channel for caller-side ref storage.
 *
 * The exchange is symmetric: the wallet pings on an interval and the agent
 * replies `pong`; conversely, when the agent pings the wallet replies `pong`
 * so the agent's own liveness watchdog stays satisfied. Any inbound frame
 * (`ping`, `pong`, or the legacy empty frame) counts as liveness.
 */
export function attachHeartbeatChannel(
  channel: RTCDataChannel,
  opts: HeartbeatChannelOptions,
): RTCDataChannel {
  channel.onmessage = (event) => {
    // Any inbound frame proves the peer is alive.
    opts.onInbound();
    // Reply to the agent's ping with a pong so its watchdog sees us alive. We
    // never reply to a pong, so the two sides can't ping-pong endlessly.
    const data = typeof event.data === 'string' ? event.data : '';
    if (data === 'ping') {
      try {
        if (channel.readyState === 'open') channel.send('pong');
      } catch {
        /* noop */
      }
    }
  };
  channel.onopen = () => console.log('Heartbeat channel opened');
  channel.onclose = () => console.log('Heartbeat channel closed');
  return channel;
}
