/**
 * ICE / connection-state monitoring for a live `RTCPeerConnection`.
 *
 * A dropped WebRTC connection does not always surface as a DataChannel
 * `onClose` (common on mobile radio handovers / NAT rebinding). Watching the
 * peer's ICE and connection state directly catches those cases so recovery can
 * be driven. `failed` / `closed` act immediately; a transient `disconnected`
 * is given a grace period to self-heal before it is treated as a real drop.
 */

export interface PeerConnectionMonitorOptions {
  /** Invoked once when the peer connection is considered dropped. */
  onDrop: (reason: string) => void;
  /**
   * How long to wait on a transient `iceconnectionstate === 'disconnected'`
   * before treating it as a real drop. If ICE recovers to `connected` within
   * this window the pending drop is cancelled.
   */
  disconnectGraceMs: number;
}

/**
 * Attach ICE/connection-state listeners to `peer`. Returns a detach function
 * that removes the listeners and cancels any pending grace timer. Safe to call
 * with a null/incompatible peer (returns a no-op detach).
 */
export function attachPeerConnectionMonitor(
  peer: any,
  opts: PeerConnectionMonitorOptions,
): () => void {
  if (!peer || typeof peer.addEventListener !== 'function') return () => {};

  const { onDrop, disconnectGraceMs } = opts;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGrace = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const onIceChange = () => {
    const state = peer.iceConnectionState;
    if (state === 'failed') {
      clearGrace();
      onDrop('ICE connection failed');
    } else if (state === 'disconnected') {
      if (graceTimer) return; // already in the grace window
      graceTimer = setTimeout(() => {
        graceTimer = null;
        const current = peer.iceConnectionState;
        if (current === 'disconnected' || current === 'failed') {
          onDrop('ICE disconnected (grace elapsed)');
        }
      }, disconnectGraceMs);
    } else if (state === 'connected' || state === 'completed') {
      // Recovered before the grace elapsed — cancel the pending drop.
      clearGrace();
    }
  };

  const onConnectionChange = () => {
    const state = peer.connectionState;
    if (state === 'failed' || state === 'closed') {
      onDrop(`peer connection ${state}`);
    }
  };

  try {
    peer.addEventListener('iceconnectionstatechange', onIceChange);
    peer.addEventListener('connectionstatechange', onConnectionChange);
  } catch {
    /* noop */
  }

  return () => {
    clearGrace();
    try {
      peer.removeEventListener?.('iceconnectionstatechange', onIceChange);
      peer.removeEventListener?.('connectionstatechange', onConnectionChange);
    } catch {
      /* noop */
    }
  };
}
