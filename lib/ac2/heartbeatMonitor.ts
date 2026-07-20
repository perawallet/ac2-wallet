/**
 * Liveness watchdog for the dedicated `ac2-heartbeat` DataChannel.
 *
 * The wallet sends `ping` on an interval; the OpenClaw agent replies `pong`
 * (and the wallet replies `pong` to the agent's pings — see
 * `attachHeartbeatChannel`). If no inbound frame arrives within `timeoutMs`,
 * the peer is presumed unreachable even though ICE may still report
 * `connected` — a silent stall — and `onTimeout` fires so the caller can
 * recover.
 *
 * Pure and fully injectable so it can be unit-tested deterministically.
 */

export interface HeartbeatMonitorOptions {
  /** Send one keepalive ping over the wire. */
  send: () => void;
  /** How often to send a ping. */
  intervalMs: number;
  /**
   * Maximum time without ANY inbound frame before the peer is declared dead.
   * Pass `Infinity` to keep sending keepalives without ever timing out (used
   * for the `ac2-v1` fallback, where there is no pong contract).
   */
  timeoutMs: number;
  /** Invoked at most once when `timeoutMs` elapses with no inbound frame. */
  onTimeout: () => void;
  /** Injectable clock/timers for tests. */
  now?: () => number;
  setIntervalFn?: (callback: () => void, ms: number) => any;
  clearIntervalFn?: (handle: any) => void;
}

export interface HeartbeatMonitor {
  /** Begin pinging. Sends an immediate ping and anchors the deadline. */
  start: () => void;
  /** Stop pinging and cancel the deadline. Idempotent. */
  stop: () => void;
  /** Record inbound peer traffic — resets the missed-response deadline. */
  noteInbound: () => void;
}

export function createHeartbeatMonitor(options: HeartbeatMonitorOptions): HeartbeatMonitor {
  const {
    send,
    intervalMs,
    timeoutMs,
    onTimeout,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  let timer: any = null;
  let lastInbound = 0;
  let timedOut = false;
  // Kept separately from `timer`: the immediate send in `start()` is allowed to
  // synchronously trigger transport teardown, whose cleanup calls `stop()`
  // before an interval handle has been assigned.
  let running = false;

  const stop = () => {
    running = false;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  const tick = () => {
    // A callback already queued by the runtime may still arrive after
    // `clearInterval`; teardown must make that callback inert as well.
    if (!running) return;
    // Declare failure once if the peer has been silent past the timeout;
    // otherwise send the next keepalive ping.
    if (now() - lastInbound >= timeoutMs) {
      if (!timedOut) {
        timedOut = true;
        stop();
        onTimeout();
      }
      return;
    }
    send();
  };

  const start = () => {
    if (running) return;
    running = true;
    timedOut = false;
    lastInbound = now();
    // Send an immediate first ping so the deadline is anchored to a real send,
    // then continue on the interval. `send()` may synchronously call `stop()`
    // through the connection failure path; never install an orphaned timer in
    // that case.
    try {
      send();
    } catch (error) {
      running = false;
      throw error;
    }
    if (!running) return;

    const nextTimer = setIntervalFn(tick, intervalMs);
    if (!running) {
      // Defensive support for injectable/synchronous timer implementations.
      clearIntervalFn(nextTimer);
      return;
    }
    timer = nextTimer;
  };

  const noteInbound = () => {
    lastInbound = now();
  };

  return { start, stop, noteInbound };
}
