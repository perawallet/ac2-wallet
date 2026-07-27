/**
 * Idle-session policy for `useConnection`'s inactivity watchdog, extracted as a
 * pure function so the resume-after-background behavior is unit-testable.
 *
 * Liveness is owned by the ICE monitor + heartbeat watchdog (they detect a
 * dead transport within seconds and auto-reconnect); the idle watchdog is a
 * slower secondary safety net that (a) tears down a genuinely idle session and
 * (b) recovers a connection that went stale while backgrounded (JS timers are
 * suspended there, so the fast detectors can't fire until foreground).
 *
 * The subtlety this module exists for: after a LONG background the liveness
 * clocks are hours old — but that gap says nothing about the connection's
 * actual health, because the native background service keeps the peer alive
 * independently of the JS runtime. On resume, the watchdog's suspended
 * interval can fire BEFORE the AppState listener's snapshot reconcile runs,
 * so judging by the stale clocks alone tore down verified-live connections
 * ("Closing stale connection after background" on a session whose heartbeat
 * channel was still delivering). When the idleness is explained by the
 * background gap, the native truth must be consulted first: an open control
 * channel means the session is NOT stale — refresh the clocks and let the
 * heartbeats resume.
 */

/** What the inactivity watchdog should do on this tick. */
export type IdleSessionVerdict =
  /** Recent activity — nothing to do. */
  | { action: 'none' }
  /**
   * The clocks are stale only because of a background gap and the native
   * service still holds the open channel: the session is alive. Reset the
   * liveness clocks (and the backgrounded flag) instead of tearing down.
   */
  | { action: 'refresh' }
  /**
   * Went stale while backgrounded and the native side is dead too —
   * recoverable; tear down and let the machine auto-reconnect.
   */
  | { action: 'close-stale' }
  /**
   * A genuine foreground idle (or an intentional stop) — terminal until the
   * user acts (avoids churn / repeated biometric prompts).
   */
  | { action: 'close-idle' };

export interface IdleSessionInput {
  now: number;
  /** Last inbound peer traffic (frames / heartbeat pongs). */
  lastInboundAt: number;
  /** Last local user action. */
  lastLocalAt: number;
  idleTimeoutMs: number;
  /** The user explicitly disconnected — never auto-resume. */
  userStopped: boolean;
  /** The app was backgrounded since the last inbound heartbeat. */
  wasBackgrounded: boolean;
  /**
   * Pulls the native truth: does the background service still hold a live
   * connection with an open control channel for THIS session? Only consulted
   * when the idleness is explained by a background gap; a throw (native
   * module unavailable) is treated as "not open".
   */
  isNativeChannelOpen: () => boolean;
}

export function evaluateIdleSession(input: IdleSessionInput): IdleSessionVerdict {
  const lastActivity = Math.max(input.lastInboundAt, input.lastLocalAt);
  if (input.now - lastActivity < input.idleTimeoutMs) return { action: 'none' };

  // A stale session whose idleness is explained by the app having been
  // backgrounded should recover automatically; a genuine foreground idle
  // should not. An intentional disconnect never resumes.
  const staleFromBackground = !input.userStopped && input.wasBackgrounded;
  if (!staleFromBackground) return { action: 'close-idle' };

  let channelOpen = false;
  try {
    channelOpen = input.isNativeChannelOpen();
  } catch {
    /* native module unavailable (tests / web) — treat as dead */
  }
  return channelOpen ? { action: 'refresh' } : { action: 'close-stale' };
}
