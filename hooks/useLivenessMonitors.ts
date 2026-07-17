/**
 * Owns the two transport-liveness watchdogs for a WebRTC peer connection:
 *
 * - The ICE/connection-state monitor (`monitorPeerConnection`), which catches a
 *   dead transport the SDK never surfaces (the DataChannel can stay `open`
 *   while the peer is gone).
 * - The heartbeat monitor (`createHeartbeatMonitor`), which pings the peer and
 *   fails on a silent stall — no inbound frame — even while ICE still reads
 *   `connected`.
 *
 * Both funnel a detected drop through the caller-supplied `onFailure`, and both
 * are torn down together via `teardown()` so a deliberate close is never
 * misread as a failure.
 */
import type { ConnectionFailureReason } from '@/hooks/useConnectionRecovery';
import {
  attachHeartbeatChannel,
  createHeartbeatMonitor,
  monitorPeerConnection,
  type HeartbeatMonitor,
  type MonitoredPeerConnection,
} from '@/lib/ac2';
import { useCallback, useRef } from 'react';

export interface UseLivenessMonitorsOptions {
  /** How often to send a keepalive ping. */
  intervalMs: number;
  /**
   * Max silence before declaring the peer dead, used only when a dedicated
   * `ac2-heartbeat` channel exists; over the `ac2-v1` fallback (no pong
   * contract) keepalives run without a timeout.
   */
  timeoutMs: number;
  /** Send-buffer size above which a stalling transport is logged. */
  bufferedWarnBytes: number;
  /** The `ac2-v1` DataChannel used for keepalives when no heartbeat channel exists. */
  getFallbackChannel: () => RTCDataChannel | null;
  /** Called on any inbound heartbeat frame for caller-side activity bookkeeping. */
  onInbound: () => void;
  /** Route a detected drop through the caller's single recovery funnel. */
  onFailure: (reason: ConnectionFailureReason, isCurrent: () => boolean) => void;
}

export interface UseLivenessMonitorsResult {
  /** Stash the negotiated peer connection; the ICE monitor attaches in `start`. */
  stashPeerConnection: (pc: MonitoredPeerConnection) => void;
  /** Wire a discovered `ac2-heartbeat` channel; returns it for the caller. */
  attachHeartbeat: (channel: RTCDataChannel) => RTCDataChannel;
  /** Record inbound peer traffic (stream frames, envelopes) as liveness. */
  noteInbound: () => void;
  /**
   * Attach the ICE monitor and start the heartbeat watchdog once the channel is
   * live. `isCurrent` gates late callbacks from a superseded setup run.
   */
  start: (isCurrent: () => boolean) => void;
  /** Stop both watchdogs and close the heartbeat channel. Idempotent. */
  teardown: () => void;
}

export function useLivenessMonitors(
  options: UseLivenessMonitorsOptions,
): UseLivenessMonitorsResult {
  const { intervalMs, timeoutMs, bufferedWarnBytes } = options;

  // Mirror the volatile callbacks so the returned functions stay stable while
  // always calling the latest closures.
  const getFallbackChannelRef = useRef(options.getFallbackChannel);
  getFallbackChannelRef.current = options.getFallbackChannel;
  const onInboundRef = useRef(options.onInbound);
  onInboundRef.current = options.onInbound;
  const onFailureRef = useRef(options.onFailure);
  onFailureRef.current = options.onFailure;

  const heartbeatChannelRef = useRef<RTCDataChannel | null>(null);
  const heartbeatMonitorRef = useRef<HeartbeatMonitor | null>(null);
  const peerConnectionRef = useRef<MonitoredPeerConnection | null>(null);
  const peerMonitorDisposeRef = useRef<(() => void) | null>(null);

  const noteInbound = useCallback(() => {
    heartbeatMonitorRef.current?.noteInbound();
  }, []);

  const stashPeerConnection = useCallback((pc: MonitoredPeerConnection) => {
    peerConnectionRef.current = pc;
  }, []);

  const attachHeartbeat = useCallback((channel: RTCDataChannel) => {
    heartbeatChannelRef.current = attachHeartbeatChannel(channel, {
      onInbound: () => {
        onInboundRef.current();
        heartbeatMonitorRef.current?.noteInbound();
      },
    });
    return heartbeatChannelRef.current;
  }, []);

  const start = useCallback(
    (isCurrent: () => boolean) => {
      // Watch the peer for connectivity loss (ICE disconnected/failed) the SDK
      // never surfaces — the DataChannel can stay "open" while the underlying
      // transport is dead. `isCurrent` makes a late callback from a superseded
      // run a no-op.
      if (peerMonitorDisposeRef.current) peerMonitorDisposeRef.current();
      peerMonitorDisposeRef.current = peerConnectionRef.current
        ? monitorPeerConnection(peerConnectionRef.current, {
            onFailed: (reason) => onFailureRef.current(reason, isCurrent),
          })
        : null;

      // Start the liveness watchdog. It pings on `ac2-heartbeat` and fails if
      // the peer stops responding (a silent stall) even while ICE still reads
      // "connected". Over the `ac2-v1` fallback there is no pong contract, so
      // run keepalives without a timeout.
      if (heartbeatMonitorRef.current) heartbeatMonitorRef.current.stop();
      heartbeatMonitorRef.current = createHeartbeatMonitor({
        intervalMs,
        timeoutMs: heartbeatChannelRef.current ? timeoutMs : Infinity,
        send: () => {
          const hb = heartbeatChannelRef.current;
          const dc = getFallbackChannelRef.current();
          const channel =
            hb && hb.readyState === 'open' ? hb : dc && dc.readyState === 'open' ? dc : null;
          if (!channel) return;
          // A growing send buffer means frames aren't draining to the peer — an
          // early signal the transport is stalling before ICE even flips state.
          if (channel.bufferedAmount > bufferedWarnBytes) {
            console.warn(
              `Heartbeat send buffer high (${channel.bufferedAmount} bytes) — transport may be stalling`,
            );
          }
          try {
            channel.send(channel === hb ? 'ping' : '');
          } catch (err) {
            console.warn('Heartbeat send failed; treating as a dropped connection', err);
            onFailureRef.current('send', isCurrent);
          }
        },
        onTimeout: () => onFailureRef.current('heartbeat', isCurrent),
      });
      heartbeatMonitorRef.current.start();
    },
    [intervalMs, timeoutMs, bufferedWarnBytes],
  );

  const teardown = useCallback(() => {
    // Stop the watchdog and detach the connectivity monitor before anything
    // closes the peer, so a deliberate teardown can't be misread as a heartbeat
    // timeout or an ICE failure.
    if (heartbeatMonitorRef.current) {
      heartbeatMonitorRef.current.stop();
      heartbeatMonitorRef.current = null;
    }
    if (peerMonitorDisposeRef.current) {
      peerMonitorDisposeRef.current();
      peerMonitorDisposeRef.current = null;
    }
    peerConnectionRef.current = null;
    if (heartbeatChannelRef.current) {
      try {
        heartbeatChannelRef.current.close();
      } catch {
        /* noop */
      }
      heartbeatChannelRef.current = null;
    }
  }, []);

  return { stashPeerConnection, attachHeartbeat, noteInbound, start, teardown };
}
