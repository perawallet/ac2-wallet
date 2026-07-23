/**
 * Native-backed AC2 transport: the Phase-4 replacement for the in-process
 * `@algorandfoundation/liquid-client` + `react-native-webrtc` path in
 * `./transport`.
 *
 * Instead of running signaling/WebRTC inside the JS runtime (which goes stale
 * when the app is backgrounded), this drives `react-native-liquid-auth`'s
 * native foreground `SignalService` and routes its events
 * (`onMessage`/`onStateChange`/`onConnectionStateChange`/`onPresence`/
 * `onLinkError`) into the `RTCDataChannel`/`RTCPeerConnection`-shaped shims in
 * `./nativeChannel`. Downstream consumers (the AC2 SDK client, heartbeat,
 * stream, and the connectivity monitor) keep working against those shims
 * unchanged.
 *
 * The negotiation resolves once the control channel (`ac2-v1`) is `open`,
 * mirroring `createAc2Transport`'s post-negotiation `waitForChannelOpen` guard
 * so a peer whose ICE never establishes fails fast into the caller's retry path
 * rather than hanging.
 */

import { NativeDataChannel, NativePeerConnection } from './nativeChannel';
import type { PresenceResult } from './presence';
import {
  CHANNEL_OPEN_TIMEOUT_MS,
  DEFAULT_DATA_CHANNELS,
  DEFAULT_ICE_SERVERS,
  waitForChannelOpen,
} from './transport';

/** The AC2 control-plane channel label the SDK client binds to. */
export const AC2_CONTROL_CHANNEL = 'ac2-v1' as const;

/** A single ICE server, matching `react-native-liquid-auth`'s `IceServer`. */
export interface NativeIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Options for a single named data channel (mirrors `RTCDataChannelInit`). */
export interface NativeDataChannelInit {
  ordered?: boolean;
  maxRetransmits?: number;
  maxPacketLifeTime?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
}

/** Native-broadcast presence payload (mirrors {@link PresenceResult}). */
export interface NativePresenceEvent {
  requestId: string;
  deviceCount: number;
  online: boolean;
}

/** Native signaling link-error payload (e.g. the two-peer lockdown refusal). */
export interface NativeLinkErrorEvent {
  event?: string;
  requestId?: string;
  reason?: string;
  message?: string;
}

/** A removable native event subscription (Expo's `EventSubscription`). */
export interface NativeSubscription {
  remove(): void;
}

/**
 * The subset of the `react-native-liquid-auth` module this factory uses.
 * Declared as an injectable interface so the transport is unit-testable with a
 * fake and does not hard-depend on the native package at module load time.
 */
export interface LiquidAuthNativeApi {
  start(url: string): Promise<void>;
  connect(
    requestId: string,
    type: 'offer' | 'answer',
    iceServers?: NativeIceServer[],
    options?: { dataChannels?: Record<string, NativeDataChannelInit> },
  ): Promise<void>;
  cancel(): Promise<void>;
  sendToChannel(channel: string, message: string): void;
  disconnect(): Promise<void>;
  addMessageListener(listener: (e: { channel: string; message: string }) => void): NativeSubscription;
  addStateChangeListener(
    listener: (e: { channel: string; state: string | null }) => void,
  ): NativeSubscription;
  addConnectionStateListener(listener: (e: { state: string }) => void): NativeSubscription;
  addPresenceListener(listener: (e: NativePresenceEvent) => void): NativeSubscription;
  addLinkErrorListener(listener: (e: NativeLinkErrorEvent) => void): NativeSubscription;
}

export interface CreateNativeAc2TransportOptions {
  /** Signaling origin, e.g. `https://debug.liquidauth.com`. */
  url: string;
  requestId: string;
  /** Called for each negotiated side-channel (`ac2-stream`, `ac2-heartbeat`). */
  onSideChannel: (channel: NativeDataChannel) => void;
  /**
   * Called once with the peer-connection shim after `ac2-v1` opens, so the
   * caller can attach the connectivity monitor (as with the JS path).
   */
  onPeerConnection?: (peerConnection: NativePeerConnection) => void;
  /** Optional abort signal; cancels the in-flight native negotiation. */
  signal?: AbortSignal;
  /** Optional presence listener for server-broadcast device counts. */
  onPresence?: (presence: PresenceResult) => void;
  /** Optional link-error listener (fail fast on room refusal). */
  onLinkError?: (error: NativeLinkErrorEvent) => void;
  /** ICE servers; defaults to the shared AC2 STUN/TURN config. */
  iceServers?: NativeIceServer[];
  /** Named data channels to open; defaults to the AC2 spec set. */
  dataChannels?: Record<string, NativeDataChannelInit>;
  /** Injected native module (defaults to the real `react-native-liquid-auth`). */
  native?: LiquidAuthNativeApi;
}

export interface NativeAc2TransportSetup {
  /** The AC2 control-plane channel shim (`ac2-v1`). */
  datachannel: NativeDataChannel;
  /** All negotiated channel shims, keyed by label. */
  channels: Map<string, NativeDataChannel>;
  /** The peer-connection shim fed by native ICE connection-state events. */
  peerConnection: NativePeerConnection;
  /** Detach the presence listener (see {@link CreateNativeAc2TransportOptions.onPresence}). */
  disposePresence: () => void;
  /** Detach every native listener this transport installed. */
  dispose: () => void;
}

/**
 * Lazily resolve the real `react-native-liquid-auth` module and adapt its
 * named exports to {@link LiquidAuthNativeApi}. Deferred (via `require`) so this
 * file can be imported — and unit-tested with an injected `native` — without
 * the native package being installed/resolvable.
 */
function getDefaultNativeApi(): LiquidAuthNativeApi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('react-native-liquid-auth');
  return {
    start: mod.start,
    connect: mod.connect,
    cancel: mod.cancel,
    sendToChannel: mod.sendToChannel,
    disconnect: mod.disconnect,
    addMessageListener: mod.addMessageListener,
    addStateChangeListener: mod.addStateChangeListener,
    addConnectionStateListener: mod.addConnectionStateListener,
    addPresenceListener: mod.addPresenceListener,
    addLinkErrorListener: mod.addLinkErrorListener,
  };
}

/**
 * Open the AC2 control plane over the native background service. Side-channels
 * (`ac2-stream`, `ac2-heartbeat`) are surfaced via `onSideChannel`. Resolves
 * once `ac2-v1` is `open`; rejects with an `AbortError` if `signal` fires or
 * with the native error (e.g. `E_LINK_ERROR` / `E_ABORTED`) otherwise.
 */
export async function createNativeAc2Transport(
  opts: CreateNativeAc2TransportOptions,
): Promise<NativeAc2TransportSetup> {
  const {
    url,
    requestId,
    onSideChannel,
    onPeerConnection,
    signal,
    onPresence,
    onLinkError,
    iceServers = DEFAULT_ICE_SERVERS,
    dataChannels = DEFAULT_DATA_CHANNELS,
    native = getDefaultNativeApi(),
  } = opts;

  if (signal?.aborted) {
    throw makeAbortError();
  }

  // Build a shim per requested channel and index them so native events (which
  // carry a channel label) can be routed to the right instance.
  const channels = new Map<string, NativeDataChannel>();
  for (const label of Object.keys(dataChannels)) {
    channels.set(label, new NativeDataChannel(label, native.sendToChannel));
  }
  // The control channel must always exist even if a caller passed a custom map
  // that omitted it, since the SDK client binds to it.
  if (!channels.has(AC2_CONTROL_CHANNEL)) {
    channels.set(AC2_CONTROL_CHANNEL, new NativeDataChannel(AC2_CONTROL_CHANNEL, native.sendToChannel));
  }

  const peerConnection = new NativePeerConnection();

  // Subscribe to native events BEFORE connecting so no early open/message is
  // missed. Each subscription is detached by `dispose()` below.
  const subscriptions: NativeSubscription[] = [];
  subscriptions.push(
    native.addMessageListener((e) => channels.get(e.channel)?.dispatchMessage(e.message)),
    native.addStateChangeListener((e) => channels.get(e.channel)?.setState(e.state)),
    native.addConnectionStateListener((e) => peerConnection.setConnectionState(e.state)),
  );

  let disposePresence: () => void = () => {};
  if (onPresence) {
    const sub = native.addPresenceListener((e) =>
      onPresence({ requestId: e.requestId, deviceCount: e.deviceCount, online: e.online }),
    );
    subscriptions.push(sub);
    disposePresence = () => sub.remove();
  }
  if (onLinkError) {
    subscriptions.push(native.addLinkErrorListener((e) => onLinkError(e)));
  }

  const dispose = () => {
    for (const sub of subscriptions) {
      try {
        sub.remove();
      } catch {
        /* best-effort detach */
      }
    }
  };

  // Wire side-channel handlers before negotiation so their onmessage/onopen are
  // attached when the first frames arrive.
  for (const [label, channel] of channels) {
    if (label !== AC2_CONTROL_CHANNEL) onSideChannel(channel);
  }

  const controlChannel = channels.get(AC2_CONTROL_CHANNEL)!;

  try {
    await native.start(url);
    if (signal?.aborted) throw makeAbortError();

    // Race the native negotiation against the abort signal; on abort, ask the
    // native service to cancel the in-flight negotiation.
    let onAbort: (() => void) | undefined;
    const connectPromise = native.connect(requestId, 'answer', iceServers, { dataChannels });

    if (signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => {
          native.cancel().catch(() => {
            /* best-effort; the connect promise will also reject */
          });
          reject(makeAbortError());
        };
        signal.addEventListener('abort', onAbort);
      });
      await Promise.race([connectPromise, abortPromise]).finally(() => {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      });
    } else {
      await connectPromise;
    }

    // Negotiation resolved once a channel opened; block until the control
    // channel specifically is open (fast-fail on a STUN/TURN stall).
    await waitForChannelOpen(controlChannel as any, CHANNEL_OPEN_TIMEOUT_MS, signal);

    // Surface the peer connection now that the channel is live, matching the JS
    // path's timing (the monitor attaches once the channel is usable).
    onPeerConnection?.(peerConnection);

    return { datachannel: controlChannel, channels, peerConnection, disposePresence, dispose };
  } catch (err) {
    // Nothing downstream owns the listeners on a failed negotiation; detach them
    // here so a retry does not accumulate handlers.
    dispose();
    throw err;
  }
}

/** Build a plain `AbortError` (broadest RN/Hermes compatibility). */
function makeAbortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}
