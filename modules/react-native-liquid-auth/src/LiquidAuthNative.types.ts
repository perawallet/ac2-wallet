// Public types for the Liquid Auth native bindings.

/**
 * The type of the *remote* peer we are connecting to.
 * - `answer`: the local device creates the offer (acts as the offerer)
 * - `offer`: the local device waits for the offer and answers it
 */
export type LiquidAuthPeerType = 'offer' | 'answer';

/**
 * A single ICE server configuration passed to the WebRTC peer connection.
 */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Configuration for a single named data channel, mirroring the
 * `RTCDataChannelInit` options accepted by `liquid-auth-js`.
 */
export interface DataChannelInit {
  ordered?: boolean;
  maxRetransmits?: number;
  maxPacketLifeTime?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
}

/**
 * A single notification template the native background service uses to render
 * a per-message-type notification while the app is backgrounded.
 */
export interface NotificationTemplate {
  /** Notification title. When omitted, the ongoing notification's title is kept. */
  title?: string;
  /** Notification body text. When omitted, the raw message is used. */
  body?: string;
}

/**
 * Configuration for the per-message notifications the native background
 * service shows while the app is backgrounded (or its JS runtime is
 * suspended/killed). The consumer owns all copy; the native service renders
 * from this map, so notifications work even when the JS runtime is not
 * running. Content is keyed by the message's `type` (see {@link typeKey}).
 */
export interface NotificationConfig {
  /**
   * Channel labels to never notify for (e.g. `ac2-heartbeat` / `ac2-stream`
   * control traffic).
   */
  suppressChannels?: string[];
  /** JSON field in the message used to select a template (default `type`). */
  typeKey?: string;
  /** Per-message-type templates, keyed by the value of {@link typeKey}. */
  templates?: Record<string, NotificationTemplate>;
  /**
   * Fallback template used when the message's type matches no entry in
   * {@link templates}. Omit to suppress unmatched messages entirely.
   */
  fallback?: NotificationTemplate;
}

/**
 * Extra options for {@link connect}, mirroring the `options` argument of the
 * `SignalClient.peer()` method in `liquid-auth-js`.
 */
export interface LiquidAuthConnectOptions {
  /**
   * Named data channels to open, keyed by label (e.g. `ac2-v1`,
   * `ac2-stream`). Only used when acting as the offerer (`type: 'answer'`).
   * Defaults to a single `liquid` channel.
   */
  dataChannels?: Record<string, DataChannelInit>;
  /**
   * Per-message-type notification content shown natively while the app is
   * backgrounded. When omitted, the native service falls back to showing the
   * raw message text for every channel.
   */
  notifications?: NotificationConfig;
  /**
   * Data-channel labels whose inbound messages the background service buffers
   * while the app is offline (its JS listener is not attached) and replays via
   * `onMessage` once it comes back online (see `setActive`). When omitted,
   * messages on every channel are buffered; pass an explicit list to buffer
   * only the channels that carry deliverable app requests (e.g. `ac2-v1`,
   * `ac2-stream`) and skip pure control traffic (e.g. `ac2-heartbeat`).
   */
  queueChannels?: string[];
}

/**
 * A parsed `liquid://<origin>/?requestId=<id>` message.
 */
export interface LiquidAuthMessage {
  origin: string;
  requestId: string;
}

/**
 * Payload emitted for every data-channel message received from the peer.
 * `channel` is the label of the data channel the message arrived on.
 */
export interface LiquidAuthMessageEvent {
  channel: string;
  message: string;
}

/**
 * Payload emitted when a data-channel state changes
 * (e.g. `OPEN`, `CLOSING`, `CLOSED`). `channel` is the label of the affected
 * data channel.
 */
export interface LiquidAuthStateChangeEvent {
  channel: string;
  state: string | null;
}

/**
 * Payload emitted when a remote media track is added to the connection.
 */
export interface LiquidAuthTrackEvent {
  id: string;
  kind: string;
  enabled: boolean;
}

/**
 * Payload emitted for server-broadcast `presence` updates, mirroring the
 * `PresenceResult` shape the wallet consumes: how many devices are currently
 * connected for the `requestId`.
 */
export interface LiquidAuthPresenceEvent {
  requestId: string;
  deviceCount: number;
  online: boolean;
}

/**
 * Payload emitted when the signaling server rejects the link for a `requestId`
 * (e.g. the two-peer lockdown `link-error` room refusal). Forwarded from the
 * signaling socket's `exception` event.
 */
export interface LiquidAuthLinkErrorEvent {
  /** The originating signaling event, typically `link-error`. */
  event?: string;
  /** The `requestId` the refusal applies to, when present. */
  requestId?: string;
  /** Machine-readable reason, e.g. `room-full` / `duplicate-peer`. */
  reason?: string;
  /** Human-readable message from the server. */
  message?: string;
}

/**
 * Payload emitted when the peer connection's ICE connection state changes
 * (e.g. `CONNECTED`, `DISCONNECTED`, `FAILED`).
 */
export interface LiquidAuthConnectionStateEvent {
  state: string;
}

/**
 * The result of an authenticated {@link request} performed through the native
 * module's shared cookie-jar HTTP client (the same client that backs the
 * background signaling socket). `body` is the raw response text; callers parse
 * JSON themselves.
 */
export interface LiquidAuthResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

/**
 * Events emitted by the native module.
 */
export type LiquidAuthNativeModuleEvents = {
  onMessage: (event: LiquidAuthMessageEvent) => void;
  onStateChange: (event: LiquidAuthStateChangeEvent) => void;
  onTrack: (event: LiquidAuthTrackEvent) => void;
  onPresence: (event: LiquidAuthPresenceEvent) => void;
  onLinkError: (event: LiquidAuthLinkErrorEvent) => void;
  onConnectionStateChange: (event: LiquidAuthConnectionStateEvent) => void;
};
