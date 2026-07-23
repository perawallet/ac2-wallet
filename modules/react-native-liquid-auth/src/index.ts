import type {
  IceServer,
  LiquidAuthConnectionStateEvent,
  LiquidAuthConnectOptions,
  LiquidAuthLinkErrorEvent,
  LiquidAuthMessage,
  LiquidAuthMessageEvent,
  LiquidAuthPeerType,
  LiquidAuthPresenceEvent,
  LiquidAuthStateChangeEvent,
  LiquidAuthTrackEvent,
} from './LiquidAuthNative.types';
import LiquidAuthNativeModule from './LiquidAuthNativeModule';

export * from './LiquidAuthNative.types';

// RTCDataChannel/RTCPeerConnection-shaped adapters over the native event API,
// so consumers written against `react-native-webrtc` can drive the native
// background service unchanged. See `./nativeChannel`.
export * from './nativeChannel';

/** Subscription returned by the event listener helpers. */
export type EventSubscription = ReturnType<typeof LiquidAuthNativeModule.addListener>;

// Re-export the native module. On web it resolves to LiquidAuthNativeModule.web.ts
// and on native platforms to LiquidAuthNativeModule.ts
export { default } from './LiquidAuthNativeModule';

/**
 * Generate a random (time-based) request id.
 */
export function generateRequestId(): string {
  return LiquidAuthNativeModule.generateRequestId();
}

/**
 * Parse a `liquid://<origin>/?requestId=<id>` URI (or JSON payload).
 */
export function parseMessage(value: string): LiquidAuthMessage {
  return LiquidAuthNativeModule.parseMessage(value);
}

/**
 * Start (and bind to) the background signaling service and connect the
 * signaling client to the given `origin`.
 */
export function start(url: string): Promise<void> {
  return LiquidAuthNativeModule.start(url);
}

/**
 * Connect to a remote peer by `requestId`.
 *
 * Pass `options.dataChannels` to open multiple named data channels (e.g.
 * `ac2-v1`, `ac2-stream`) when acting as the offerer (`type: 'answer'`).
 */
export function connect(
  requestId: string,
  type: LiquidAuthPeerType,
  iceServers?: IceServer[],
  options?: LiquidAuthConnectOptions
): Promise<void> {
  return LiquidAuthNativeModule.connect(requestId, type, iceServers, options);
}

/**
 * Abort an in-flight {@link connect} negotiation. The pending `connect`
 * promise rejects with an `E_ABORTED` error.
 */
export function cancel(): Promise<void> {
  return LiquidAuthNativeModule.cancel();
}

/**
 * Send a message over the primary (`liquid`) data channel.
 */
export function send(message: string): void {
  return LiquidAuthNativeModule.send(message);
}

/**
 * Send a message over a specific named data channel.
 */
export function sendToChannel(channel: string, message: string): void {
  return LiquidAuthNativeModule.sendToChannel(channel, message);
}

/**
 * Stop the signaling client and unbind/stop the background service.
 */
export function disconnect(): Promise<void> {
  return LiquidAuthNativeModule.disconnect();
}

/**
 * Subscribe to data-channel messages received from the peer.
 */
export function addMessageListener(
  listener: (event: LiquidAuthMessageEvent) => void
): EventSubscription {
  return LiquidAuthNativeModule.addListener('onMessage', listener);
}

/**
 * Subscribe to data-channel state changes (`OPEN`, `CLOSING`, `CLOSED`, ...).
 */
export function addStateChangeListener(
  listener: (event: LiquidAuthStateChangeEvent) => void
): EventSubscription {
  return LiquidAuthNativeModule.addListener('onStateChange', listener);
}

/**
 * Subscribe to remote media tracks added to the peer connection.
 */
export function addTrackListener(
  listener: (event: LiquidAuthTrackEvent) => void
): EventSubscription {
  return LiquidAuthNativeModule.addListener('onTrack', listener);
}

/**
 * Subscribe to server-broadcast `presence` updates for the connected
 * `requestId` (how many devices are connected).
 */
export function addPresenceListener(
  listener: (event: LiquidAuthPresenceEvent) => void
): EventSubscription {
  return LiquidAuthNativeModule.addListener('onPresence', listener);
}

/**
 * Subscribe to signaling link errors (e.g. the two-peer lockdown `link-error`
 * room refusal), so a full session can fail fast instead of timing out.
 */
export function addLinkErrorListener(
  listener: (event: LiquidAuthLinkErrorEvent) => void
): EventSubscription {
  return LiquidAuthNativeModule.addListener('onLinkError', listener);
}

/**
 * Subscribe to peer ICE connection-state changes (`CONNECTED`, `DISCONNECTED`,
 * `FAILED`, ...), for connectivity monitoring after negotiation.
 */
export function addConnectionStateListener(
  listener: (event: LiquidAuthConnectionStateEvent) => void
): EventSubscription {
  return LiquidAuthNativeModule.addListener('onConnectionStateChange', listener);
}
