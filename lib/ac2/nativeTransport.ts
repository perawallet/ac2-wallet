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

/** A single notification template (mirrors the module's `NotificationTemplate`). */
export interface NativeNotificationTemplate {
  title?: string;
  body?: string;
}

/**
 * Per-message-type notification config passed to the native service (mirrors
 * the module's `NotificationConfig`). The native service renders these while
 * the app is backgrounded — even when the JS runtime is suspended/killed — so
 * the copy must live here (wallet-owned), not in the shared library.
 */
export interface NativeNotificationConfig {
  /** Channel labels to never notify for (control traffic). */
  suppressChannels?: string[];
  /** JSON field in the message used to select a template (default `type`). */
  typeKey?: string;
  /** Per-message-type templates, keyed by the message's `type`. */
  templates?: Record<string, NativeNotificationTemplate>;
  /** Fallback template used when no `type` matches; omit to suppress. */
  fallback?: NativeNotificationTemplate;
}

/**
 * The wallet's default per-message-type notifications for the background
 * service. Heartbeat/stream control channels never notify; AC2 signing/key
 * requests get tailored copy; anything else (chat, unknown) falls back to a
 * generic "new message" banner. The type keys are the AC2 message-type URIs
 * (`AC2MessageTypes` in `@ac2/ac2-sdk`).
 */
export const DEFAULT_AC2_NOTIFICATIONS: NativeNotificationConfig = {
  suppressChannels: ['ac2-heartbeat', 'ac2-stream'],
  typeKey: 'type',
  templates: {
    'ac2/SigningRequest': {
      title: 'Signature request',
      body: 'A request is waiting for your approval. Tap to review.',
    },
    'ac2/KeyRequest': {
      title: 'Key request',
      body: 'A request for account access is waiting. Tap to review.',
    },
  },
  fallback: {
    title: 'AC2 Wallet',
    body: 'You have a new message. Tap to open.',
  },
};

/**
 * The wallet's default set of channels the native service buffers while the
 * app is offline (and replays via `onMessage` once it comes back online). The
 * deliverable channels carry app requests: `ac2-v1` (the SDK control plane)
 * and `ac2-stream` (control frames / messages to deliver). `ac2-heartbeat` is
 * intentionally excluded — it is pure liveness ping/pong, not a deliverable
 * request. Any inbound activity on ANY channel still counts as liveness.
 */
export const DEFAULT_AC2_QUEUE_CHANNELS: string[] = ['ac2-v1', 'ac2-stream'];

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
    options?: {
      dataChannels?: Record<string, NativeDataChannelInit>;
      notifications?: NativeNotificationConfig;
      queueChannels?: string[];
    },
  ): Promise<void>;
  cancel(): Promise<void>;
  setActive(active: boolean): void;
  sendToChannel(channel: string, message: string): void;
  disconnect(): Promise<void>;
  addMessageListener(
    listener: (e: { channel: string; message: string }) => void,
  ): NativeSubscription;
  addStateChangeListener(
    listener: (e: { channel: string; state: string | null }) => void,
  ): NativeSubscription;
  addConnectionStateListener(listener: (e: { state: string }) => void): NativeSubscription;
  addPresenceListener(listener: (e: NativePresenceEvent) => void): NativeSubscription;
  addLinkErrorListener(listener: (e: NativeLinkErrorEvent) => void): NativeSubscription;
  request(
    url: string,
    method: string,
    headers?: Record<string, string>,
    body?: string,
  ): Promise<{ ok: boolean; status: number; statusText: string; body: string }>;
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
  /**
   * Per-message-type notification content the native service shows while the
   * app is backgrounded; defaults to {@link DEFAULT_AC2_NOTIFICATIONS}.
   */
  notifications?: NativeNotificationConfig;
  /**
   * Channels the native service buffers while the app is offline (replayed via
   * `onMessage` once online); defaults to {@link DEFAULT_AC2_QUEUE_CHANNELS}.
   */
  queueChannels?: string[];
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
    request: mod.request,
    setActive: mod.setActive,
  };
}

/** Flatten a `HeadersInit` into the plain string map the native `request` takes. */
function normalizeHeaders(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers as [string, string][]);
  }
  return { ...(headers as Record<string, string>) };
}

/**
 * `fetch`-shaped wrapper that routes an HTTP request through the native
 * module's shared cookie-jar client, so the Liquid Auth session cookie
 * (`connect.sid`) is captured natively and rides the background signaling
 * socket (D9). Returns a standard {@link Response} so existing consumers
 * (`.ok`/`.status`/`.json()`) are unchanged. The native module is injectable
 * for tests.
 */
export async function nativeAuthFetch(
  input: string,
  init: RequestInit = {},
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): Promise<Response> {
  const method = (init.method ?? 'GET').toString().toUpperCase();
  const headers = normalizeHeaders(init.headers);
  const body =
    init.body == null ? undefined : typeof init.body === 'string' ? init.body : String(init.body);
  const res = await native.request(input, method, headers, body);
  return new Response(res.body, { status: res.status, statusText: res.statusText });
}

/**
 * Start the native foreground signaling service and connect its signaling
 * socket. Idempotent on the native side (a running foreground service is
 * reused), so it is safe to call once when the persistent service comes up and
 * again per negotiation. The native module is injectable for tests.
 */
export async function startNativeService(
  url: string,
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): Promise<void> {
  await native.start(url);
}

/**
 * Fully tear down the native foreground service (disconnects the signaling
 * socket and the WebRTC peer). The native analog of dropping the persistent
 * `SignalClient` socket — use it only on an explicit disconnect / unmount.
 */
export async function stopNativeService(
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): Promise<void> {
  await native.disconnect();
}

/**
 * Cancel the in-flight (or established) native peer negotiation without
 * tearing the service down, so the persistent signaling socket survives a p2p
 * drop and the next negotiation can reuse it. Best-effort.
 */
export async function cancelNativeNegotiation(
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): Promise<void> {
  await native.cancel();
}

/**
 * Tell the native background service whether the app is currently online
 * (foregrounded, with its JS listeners attached). When set active, any
 * messages the service buffered while the app was offline are replayed through
 * the `onMessage` event in arrival order. Drive this from the app's
 * foreground/background lifecycle so the app owns the signaling delivery state.
 */
export function setNativeActive(
  active: boolean,
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): void {
  native.setActive(active);
}

/**
 * Subscribe to server-broadcast presence for the connected `requestId`. Lives
 * with the persistent service (not a single negotiation), mirroring how the JS
 * path subscribed presence on the long-lived signaling socket.
 */
export function addNativePresenceListener(
  listener: (e: NativePresenceEvent) => void,
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): NativeSubscription {
  return native.addPresenceListener(listener);
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
    notifications = DEFAULT_AC2_NOTIFICATIONS,
    queueChannels = DEFAULT_AC2_QUEUE_CHANNELS,
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
    channels.set(
      AC2_CONTROL_CHANNEL,
      new NativeDataChannel(AC2_CONTROL_CHANNEL, native.sendToChannel),
    );
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
    const connectPromise = native.connect(requestId, 'answer', iceServers, {
      dataChannels,
      notifications,
      queueChannels,
    });

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
