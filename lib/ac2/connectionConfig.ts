/**
 * Tuning constants and helpers for the AC2 connection lifecycle
 * (`hooks/useConnection`). Kept in one place so the timing policy is easy to
 * read and adjust, and so the pure backoff calculation is unit-testable.
 */

/**
 * Base delay for the first automatic reconnect. Subsequent attempts back off
 * exponentially (see `computeReconnectDelay`) so a peer/network that is slow to
 * recover isn't hammered.
 */
export const AUTO_RECONNECT_BASE_DELAY_MS = 3000;
/** Ceiling for the exponential backoff so the delay never grows unbounded. */
export const AUTO_RECONNECT_MAX_DELAY_MS = 20000;
/**
 * Random +/- jitter applied to each backoff delay to avoid thundering-herd
 * reconnect storms when many clients drop at once.
 */
export const AUTO_RECONNECT_JITTER_MS = 750;
/**
 * Bounded auto-reconnect budget. After this many failed automatic attempts we
 * stop retrying and fall back to the manual "Reconnect" button.
 */
export const MAX_RECONNECT_ATTEMPTS = 5;
/**
 * Hard ceiling on any auth/session HTTP request during setup. React Native's
 * `fetch` has NO default timeout, so a request issued while the network is
 * still recovering from a drop (exactly when auto-reconnect fires) can stall
 * forever. Bounding it turns a silent hang into a rejection that flows into the
 * retry state machine instead.
 */
export const REQUEST_TIMEOUT_MS = 15000;
/** Cadence at which the wallet sends keepalive pings once connected. */
export const HEARTBEAT_INTERVAL_MS = 20000;
/**
 * Liveness watchdog: if NO inbound frame (heartbeat, envelope, chat, or stream
 * control) is seen from the peer for this long, the connection is treated as
 * silently dead and a recoverable reconnect is triggered. Kept generous (well
 * above the heartbeat cadence) so ordinary quiet periods never false-positive.
 */
export const HEARTBEAT_STALE_MS = 90000;
/** Cadence of the connection monitor (watchdog + inactivity) sweep. */
export const CONNECTION_MONITOR_INTERVAL_MS = 5000;
/** Close a connection after this long with no user activity at all (idle). */
export const INACTIVITY_TIMEOUT_MS = 60000;
/**
 * `iceconnectionstate === 'disconnected'` is frequently transient (a brief NAT
 * rebinding or radio handover) and often self-heals back to `connected`. Wait
 * this long before treating it as a real drop; `failed`/`closed` act at once.
 */
export const ICE_DISCONNECT_GRACE_MS = 8000;

/**
 * Exponential backoff (`base * 2^(attempt-1)`) capped at the max, plus a small
 * random jitter to de-correlate simultaneous reconnects. `attempt` is 1-based.
 */
export function computeReconnectDelay(attempt: number, random: () => number = Math.random): number {
  const backoff = Math.min(
    AUTO_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
    AUTO_RECONNECT_MAX_DELAY_MS,
  );
  const jitter = Math.floor((random() * 2 - 1) * AUTO_RECONNECT_JITTER_MS);
  return Math.max(0, backoff + jitter);
}
