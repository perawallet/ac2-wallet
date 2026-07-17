/**
 * Connectivity watchdog for an established WebRTC peer connection.
 *
 * Liquid Auth's `SignalClient` never attaches ICE/connection state handlers, so
 * once negotiation completes nobody notices when ICE drops to `disconnected` or
 * `failed` — the `ac2-v1` DataChannel can stay `open` while the underlying peer
 * is dead (a STUN/TURN "zombie"). This module bridges that gap.
 *
 * `iceConnectionState` is treated as authoritative (the more reliable signal on
 * `react-native-webrtc`); `connectionState` is only a secondary corroborator
 * for the terminal `failed` state.
 */

export type PeerConnectionFailureReason = 'ice';

/**
 * The minimal `RTCPeerConnection` surface this monitor needs. Kept structural
 * so it can be unit-tested with a lightweight fake and so the module doesn't
 * hard-depend on the react-native-webrtc types.
 */
export interface MonitoredPeerConnection {
  iceConnectionState: string;
  connectionState: string;
  addEventListener: (type: string, listener: (event?: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event?: unknown) => void) => void;
}

export interface MonitorPeerConnectionOptions {
  /** Invoked at most once when the peer is judged permanently broken. */
  onFailed: (reason: PeerConnectionFailureReason) => void;
  /**
   * Invoked when a transient `disconnected` recovers to `connected`/`completed`
   * before the grace timer elapses.
   */
  onRecovered?: () => void;
  /**
   * How long to tolerate `iceConnectionState === 'disconnected'` before
   * declaring failure. ICE routinely flaps through `disconnected` during
   * network handoffs (e.g. Wi-Fi -> cellular), so an immediate teardown would
   * churn otherwise-healthy connections.
   */
  gracePeriodMs?: number;
  /** Injectable timer functions for deterministic tests. */
  setTimeoutFn?: (callback: () => void, ms: number) => any;
  clearTimeoutFn?: (handle: any) => void;
}

const DEFAULT_GRACE_PERIOD_MS = 10000;

/**
 * Attach connectivity monitoring to `pc`. Returns a `dispose()` that detaches
 * all listeners and cancels any pending grace timer. `onFailed` fires at most
 * once. Reads the current ICE/connection state synchronously on attach so a
 * peer that is already failed/disconnected is caught immediately.
 */
export function monitorPeerConnection(
  pc: MonitoredPeerConnection,
  options: MonitorPeerConnectionOptions,
): () => void {
  const {
    onFailed,
    onRecovered,
    gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let disposed = false;
  let failed = false;
  let graceTimer: any = null;

  const clearGraceTimer = () => {
    if (graceTimer !== null) {
      clearTimeoutFn(graceTimer);
      graceTimer = null;
    }
  };

  const fail = () => {
    if (disposed || failed) return;
    failed = true;
    clearGraceTimer();
    onFailed('ice');
  };

  const evaluateIceState = () => {
    if (disposed || failed) return;
    switch (pc.iceConnectionState) {
      case 'failed':
        fail();
        break;
      case 'disconnected':
        // Transient by nature — only fail if it stays disconnected past the
        // grace window. Don't stack timers if we're already waiting.
        if (graceTimer === null) {
          graceTimer = setTimeoutFn(() => {
            graceTimer = null;
            // A late recovery may have raced the timer; re-check before failing.
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
              fail();
            }
          }, gracePeriodMs);
        }
        break;
      case 'connected':
      case 'completed':
        // Recovered from a transient disconnect — cancel the pending failure.
        if (graceTimer !== null) {
          clearGraceTimer();
          onRecovered?.();
        }
        break;
      case 'closed':
        // The native PC was closed (remote shutdown or system termination).
        // react-native-webrtc may jump directly to 'closed' without passing
        // through 'disconnected' → 'failed', so treat it as a terminal failure.
        fail();
        break;
      default:
        // 'new' | 'checking' — nothing to act on.
        break;
    }
  };

  const onIceChange = () => evaluateIceState();
  const onConnChange = () => {
    if (disposed || failed) return;
    // Secondary corroboration: terminal peer states are decisive.
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fail();
  };

  pc.addEventListener('iceconnectionstatechange', onIceChange);
  pc.addEventListener('connectionstatechange', onConnChange);

  // Catch a peer that is already failed/disconnected/closed at attach time.
  evaluateIceState();
  if (!failed && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) fail();

  return function dispose() {
    if (disposed) return;
    disposed = true;
    clearGraceTimer();
    pc.removeEventListener('iceconnectionstatechange', onIceChange);
    pc.removeEventListener('connectionstatechange', onConnChange);
  };
}
