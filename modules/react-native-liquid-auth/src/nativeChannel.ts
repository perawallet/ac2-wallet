/**
 * Adapter shims that present `react-native-liquid-auth`'s *event-based* native
 * background service as the `RTCDataChannel`- and `RTCPeerConnection`-shaped
 * objects that connection code written against `react-native-webrtc` already
 * consumes.
 *
 * The native module owns the signaling socket + WebRTC peer in a foreground
 * service and only surfaces messages/state as events (`onMessage`,
 * `onStateChange`, `onConnectionStateChange`, ...). Consumers, however, are
 * frequently written against live `RTCDataChannel` objects from
 * `react-native-webrtc` (`.send`, `.readyState`, `.onmessage`,
 * `.addEventListener('open')`, `.bufferedAmount`) and a monitored
 * `RTCPeerConnection` (`.iceConnectionState`, `.addEventListener`).
 *
 * These shims bridge that gap so adopting the native service changes downstream
 * consumers minimally: a transport routes native events into per-channel shim
 * instances, and the shims re-emit them through the classic
 * DataChannel/PeerConnection APIs.
 *
 * The native side stringifies WebRTC enums verbatim, so states arrive
 * UPPERCASE (`OPEN`, `CLOSING`, `CONNECTED`, `FAILED`, ...); both shims
 * lowercase them to match the `RTCDataChannel.readyState` union and the ICE
 * states an ICE connection-state monitor expects.
 */

/** The `RTCDataChannel.readyState` union a transport wrapper expects. */
export type DataChannelReadyState = 'connecting' | 'open' | 'closing' | 'closed';

/** Shape of the message event a `.onmessage` handler reads. */
export interface DataChannelMessageEvent {
  data: string;
}

type ChannelEventType = 'open' | 'close' | 'error' | 'message';
type PeerEventType = 'iceconnectionstatechange' | 'connectionstatechange';

/**
 * Lowercase a native WebRTC enum string (e.g. `"OPEN"` -> `"open"`), tolerating
 * a `null`/`undefined` state by treating it as `closed` (the native side sends
 * `null` when a channel/peer has no meaningful state left).
 */
function normalizeState(state: string | null | undefined): string {
  return (state ?? 'closed').toLowerCase();
}

/**
 * An `RTCDataChannel`-shaped adapter backed by the native background service.
 *
 * A single instance represents one named channel (e.g. `ac2-v1`). The owning
 * transport factory feeds it native events via {@link dispatchMessage} /
 * {@link setState}; consumers interact with it exactly as they would a real
 * `RTCDataChannel`.
 *
 * Both the property-style handlers (`onopen`/`onmessage`/...) and the
 * `addEventListener` style are supported.
 */
export class NativeDataChannel {
  readonly label: string;

  /** Mirrors `RTCDataChannel.bufferedAmount`; the native path never buffers in JS. */
  bufferedAmount = 0;

  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: DataChannelMessageEvent) => void) | null = null;

  private _readyState: DataChannelReadyState = 'connecting';
  private readonly _send: (label: string, message: string) => void;
  private readonly _listeners = new Map<ChannelEventType, Set<(ev?: unknown) => void>>();

  constructor(label: string, send: (label: string, message: string) => void) {
    this.label = label;
    this._send = send;
  }

  get readyState(): DataChannelReadyState {
    return this._readyState;
  }

  /** Send a frame over this channel through the native service. */
  send(data: string): void {
    this._send(this.label, data);
  }

  /**
   * Locally mark the channel closed. There is no per-channel native close
   * (teardown happens via the service's `disconnect`), so this only flips the
   * local state and fires `close`, matching how consumers observe a closed
   * channel.
   */
  close(): void {
    if (this._readyState === 'closed') return;
    this._readyState = 'closed';
    this._fireClose();
  }

  addEventListener(type: ChannelEventType, listener: (ev?: unknown) => void): void {
    const set = this._listeners.get(type) ?? new Set();
    set.add(listener);
    this._listeners.set(type, set);
  }

  removeEventListener(type: ChannelEventType, listener: (ev?: unknown) => void): void {
    this._listeners.get(type)?.delete(listener);
  }

  /** Route a native `onMessage` frame for this channel to the consumer. */
  dispatchMessage(message: string): void {
    const event: DataChannelMessageEvent = { data: message };
    try {
      this.onmessage?.(event);
    } catch {
      /* consumer handler threw; do not break dispatch */
    }
    this._emit('message', event);
  }

  /**
   * Apply a native `onStateChange` for this channel. Transitions to `open`
   * fire `open`; transitions to `closed` fire `close`. The uppercase native
   * enum is lowercased to the `RTCDataChannel.readyState` union.
   */
  setState(state: string | null | undefined): void {
    const next = normalizeState(state);
    const readyState = (['connecting', 'open', 'closing', 'closed'] as const).includes(
      next as DataChannelReadyState,
    )
      ? (next as DataChannelReadyState)
      : 'closed';
    if (readyState === this._readyState) return;
    this._readyState = readyState;
    if (readyState === 'open') this._fireOpen();
    else if (readyState === 'closed') this._fireClose();
  }

  /** Surface a native transport error to the consumer. */
  dispatchError(err?: unknown): void {
    try {
      this.onerror?.(err);
    } catch {
      /* consumer handler threw; do not break dispatch */
    }
    this._emit('error', err);
  }

  private _fireOpen(): void {
    try {
      this.onopen?.();
    } catch {
      /* noop */
    }
    this._emit('open');
  }

  private _fireClose(): void {
    try {
      this.onclose?.();
    } catch {
      /* noop */
    }
    this._emit('close');
  }

  private _emit(type: ChannelEventType, ev?: unknown): void {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(ev);
      } catch {
        /* listener threw; keep dispatching */
      }
    }
  }
}

/**
 * An `RTCPeerConnection`-shaped adapter exposing only the surface an ICE
 * connection-state monitor reads: `iceConnectionState`, `connectionState`, and
 * `addEventListener`/`removeEventListener` for the two state-change events.
 *
 * The native service reports a single ICE connection state string via
 * `onConnectionStateChange`; it is lowercased into `iceConnectionState` (and
 * mirrored into `connectionState`) and re-emitted so the monitor's failure
 * detection works unchanged.
 */
export class NativePeerConnection {
  iceConnectionState = 'new';
  connectionState = 'new';

  private readonly _listeners = new Map<PeerEventType, Set<(ev?: unknown) => void>>();

  addEventListener(type: string, listener: (ev?: unknown) => void): void {
    const key = type as PeerEventType;
    const set = this._listeners.get(key) ?? new Set();
    set.add(listener);
    this._listeners.set(key, set);
  }

  removeEventListener(type: string, listener: (ev?: unknown) => void): void {
    this._listeners.get(type as PeerEventType)?.delete(listener);
  }

  /**
   * Apply a native ICE connection-state change. The monitor treats
   * `iceConnectionState` as authoritative and only reads `connectionState` for
   * the terminal `failed`/`closed` states, so mirroring the same lowercased
   * value into both (and firing both events) satisfies it exactly.
   */
  setConnectionState(state: string | null | undefined): void {
    const next = normalizeState(state);
    this.iceConnectionState = next;
    this.connectionState = next;
    this._emit('iceconnectionstatechange');
    this._emit('connectionstatechange');
  }

  /** Mark the peer closed locally and notify the monitor. */
  close(): void {
    if (this.iceConnectionState === 'closed' && this.connectionState === 'closed') return;
    this.iceConnectionState = 'closed';
    this.connectionState = 'closed';
    this._emit('iceconnectionstatechange');
    this._emit('connectionstatechange');
  }

  private _emit(type: PeerEventType): void {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener();
      } catch {
        /* listener threw; keep dispatching */
      }
    }
  }
}
