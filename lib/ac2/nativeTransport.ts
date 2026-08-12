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
  /**
   * Creation-order rank (lower first). Channel maps cross the iOS bridge as
   * unordered dictionaries, but the remote peer sees channels in creation
   * order and the AC2 agent requires `ac2-v1` to arrive first.
   */
  order?: number;
}

/** A single notification template (mirrors the module's `NotificationTemplate`). */
export interface NativeNotificationTemplate {
  title?: string;
  body?: string;
}

/**
 * Status copy for the single ongoing foreground-service notification (mirrors
 * the module's `NotificationStatus`). The native service renders these while
 * the app is backgrounded — even when the JS runtime is suspended/killed — so
 * the copy must live here (wallet-owned), not in the shared library. The
 * notification text reflects the service state:
 *  - `connected`: the app is foreground / attached.
 *  - `idle`: the app is closed with nothing waiting ("tap to open").
 *  - `messages`: message(s) arrived while the app was closed.
 */
export interface NativeNotificationConfig {
  /**
   * Channel labels whose inbound messages do NOT flip the notification into
   * the `messages` state (control traffic). They are still buffered/replayed,
   * just not announced.
   */
  suppressChannels?: string[];
  /** Ongoing notification while the app is foreground/connected. */
  connected?: NativeNotificationTemplate;
  /** Ongoing notification while the app is closed with no pending messages. */
  idle?: NativeNotificationTemplate;
  /** Ongoing notification while the app is closed with pending messages. */
  messages?: NativeNotificationTemplate;
}

/**
 * The wallet's default notification copy for the background service. The
 * ongoing notification reflects the service state: connected (app open),
 * "Tap to open the app" (closed, idle), or "You have new messages" (closed,
 * message[s] arrived). Only `ac2-heartbeat` is suppressed (it is pure liveness
 * ping/pong); inbound traffic on ANY other channel (`ac2-v1`, `ac2-stream`, …)
 * flips the notification into the "new messages" state.
 */
export const DEFAULT_AC2_NOTIFICATIONS: NativeNotificationConfig = {
  suppressChannels: ['ac2-heartbeat'],
  connected: {
    title: 'AC2 Wallet',
    body: 'Connected to the signaling service',
  },
  idle: {
    title: 'AC2 Wallet',
    body: 'Tap to open the app.',
  },
  messages: {
    title: 'AC2 Wallet',
    body: 'You have new messages.',
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

/** Heartbeat keep-alive configuration (mirrors the native `HeartbeatConfig`). */
export interface NativeHeartbeatConfig {
  channel: string;
  ping?: string;
  pong?: string;
}

/**
 * The wallet's heartbeat keep-alive. While the app is offline (backgrounded /
 * closed) the JS ping/pong reply in `attachHeartbeatChannel` is dead, so the
 * native background service itself answers the agent's `ping` on the
 * `ac2-heartbeat` channel with a `pong`. This keeps the agent's liveness
 * watchdog satisfied so it does not close the p2p connection while the app is
 * away — the whole point of the survive-app-close service. The JS path still
 * handles ping/pong (and interval pinging) while the app is foregrounded.
 */
export const DEFAULT_AC2_HEARTBEAT: NativeHeartbeatConfig = {
  channel: 'ac2-heartbeat',
  ping: 'ping',
  pong: 'pong',
};

/** Native-broadcast presence payload (mirrors {@link PresenceResult}). */
export interface NativePresenceEvent {
  requestId: string;
  deviceCount: number;
  online: boolean;
}

/**
 * Native signaling-socket connectivity payload (`connected`/`disconnected`),
 * including socket.io auto-reconnects. Independent of the p2p connection —
 * data channels deliberately survive signaling disruptions — so the app can
 * show a dedicated "signaling server offline" state.
 */
export interface NativeSignalingStateEvent {
  state: 'connected' | 'disconnected';
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
 * A snapshot of the background service's CURRENT connection (mirrors the
 * module's `LiquidAuthConnectionState`), so a re-attaching app can hydrate
 * instead of assuming a fresh start / renegotiating.
 */
export interface NativeConnectionStateSnapshot {
  connected: boolean;
  requestId: string | null;
  iceConnectionState: string | null;
  channels: Record<string, string>;
  /**
   * Whether the persistent signaling socket is currently connected. Optional
   * so older native binaries / test fakes without the field keep working
   * (treat `undefined` as unknown).
   */
  signalingConnected?: boolean;
  /**
   * The last server `presence` broadcast the persistent socket received, or
   * `null` before the first one. Optional so older native binaries / test
   * fakes without the field keep working (treat `undefined` as unknown). The
   * server broadcasts presence when the socket joins the `requestId` room —
   * typically during service start, BEFORE the JS presence listener is
   * attached — so this is the only way a launching app can learn its peer is
   * offline (see {@link presenceFromSnapshot}).
   */
  lastPresence?: NativePresenceEvent | null;
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
      heartbeat?: NativeHeartbeatConfig;
    },
  ): Promise<void>;
  cancel(): Promise<void>;
  getConnectionState(): NativeConnectionStateSnapshot;
  attach(options?: {
    dataChannels?: Record<string, NativeDataChannelInit>;
    notifications?: NativeNotificationConfig;
    queueChannels?: string[];
    heartbeat?: NativeHeartbeatConfig;
  }): Promise<void>;
  setActive(active: boolean): void;
  /**
   * Explicitly replay the service's offline message queue through `onMessage`
   * (in arrival order). Optional so older native binaries / test fakes without
   * the method keep working.
   */
  flushQueue?(): void;
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
  /**
   * Subscribe to signaling-socket connectivity changes. Optional so older
   * native binaries / test fakes without the event keep working.
   */
  addSignalingStateListener?(listener: (e: NativeSignalingStateEvent) => void): NativeSubscription;
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
  /**
   * How this attempt must reach the peer, as decided by the connection
   * machine. `attach` (the default, and what a hydrating relaunch wants) may
   * re-bind to a live native peer the background service kept alive; `connect`
   * REQUIRES a fresh negotiation and force-cancels any peer the service still
   * holds for this `requestId`. Honouring the mode matters because a peer that
   * survived a long background can be a zombie whose control channel still
   * reads OPEN — silently attaching to it is exactly the "reconnect that never
   * reconnects" the machine asked us to escape.
   */
  mode?: 'connect' | 'attach';
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
  /**
   * Heartbeat keep-alive the native service performs while the app is offline
   * (answers the peer's `ping` with a `pong`); defaults to
   * {@link DEFAULT_AC2_HEARTBEAT}. Pass `null` to disable.
   */
  heartbeat?: NativeHeartbeatConfig | null;
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
    getConnectionState: mod.getConnectionState,
    attach: mod.attach,
    sendToChannel: mod.sendToChannel,
    disconnect: mod.disconnect,
    addMessageListener: mod.addMessageListener,
    addStateChangeListener: mod.addStateChangeListener,
    addConnectionStateListener: mod.addConnectionStateListener,
    addPresenceListener: mod.addPresenceListener,
    addLinkErrorListener: mod.addLinkErrorListener,
    addSignalingStateListener: mod.addSignalingStateListener,
    request: mod.request,
    setActive: mod.setActive,
    flushQueue: mod.flushQueue,
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
 * (foregrounded, with its JS listeners attached). Drive this from the app's
 * foreground/background lifecycle so the app owns the signaling delivery
 * state. Deliberately does NOT replay the offline queue — a relaunching app
 * flips active before its listeners are rewired, so an automatic replay here
 * would hand the buffered messages to the previous (stale) session's handlers
 * and lose them. The replay happens when a fresh sink attaches (`connect` /
 * `attach` inside {@link createNativeAc2Transport}) or when the app explicitly
 * calls {@link flushNativeQueue} once its listeners are wired.
 */
export function setNativeActive(
  active: boolean,
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): void {
  native.setActive(active);
}

/**
 * Explicitly replay any messages the native background service buffered while
 * the app was offline, through the `onMessage` event in arrival order. Call it
 * only once the message consumers are wired (a live transport's channel
 * handlers), so the replay can't race the listener setup — e.g. on a plain
 * background -> foreground transition with a still-live transport, or right
 * after a negotiation completes. No-op when nothing is buffered or the native
 * module doesn't implement it.
 */
export function flushNativeQueue(native: LiquidAuthNativeApi = getDefaultNativeApi()): void {
  native.flushQueue?.();
}

/**
 * Query the background service's CURRENT connection so the app can hydrate its
 * UI on reconnect/relaunch (whether a peer is live, which channels are open,
 * and the bound `requestId`) instead of assuming a fresh start. Safe to call
 * before the service is started (returns `connected: false`).
 */
export function getNativeConnectionState(
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): NativeConnectionStateSnapshot {
  return native.getConnectionState();
}

/**
 * Whether a {@link getNativeConnectionState} snapshot reports the given data
 * channel as open. The raw snapshot carries the native WebRTC enum strings
 * verbatim (UPPERCASE, e.g. `"OPEN"`) — unlike the channel shims, which
 * lowercase them into `readyState` — so the comparison is case-insensitive.
 */
export function isSnapshotChannelOpen(
  snapshot: NativeConnectionStateSnapshot,
  channel: string = AC2_CONTROL_CHANNEL,
): boolean {
  return snapshot.channels?.[channel]?.toLowerCase() === 'open';
}

/**
 * Whether a {@link getNativeConnectionState} snapshot describes an ICE session
 * nothing can travel through any more. `disconnected` is deliberately absent:
 * ICE recovers from it on its own, and treating it as dead would tear down
 * connections that are merely on a flaky network.
 */
function isDeadIce(snapshot: NativeConnectionStateSnapshot): boolean {
  const state = snapshot.iceConnectionState?.toLowerCase();
  return state === 'failed' || state === 'closed';
}

/**
 * Extract the cached last `presence` broadcast from a
 * {@link getNativeConnectionState} snapshot, normalized and scoped to
 * `requestId`. Returns `null` when the native side has no cached presence
 * (older binary, no broadcast yet) or when it belongs to a DIFFERENT
 * `requestId` (a stale cache from a previous session must not gate this one).
 *
 * Why this exists: the server broadcasts presence when the wallet's socket
 * joins the `requestId` room — during native service start, before the JS
 * presence listener is attached — and then stays silent until a device joins
 * or leaves. At a cold launch against an offline peer that one broadcast is
 * the ONLY presence signal, so without reading it back from the snapshot the
 * connection machine's presence gate stays "unknown" and the wallet
 * negotiates forever into a peer that is not there (instead of parking in
 * `waiting` and showing the peer-offline notice).
 */
export function presenceFromSnapshot(
  snapshot: NativeConnectionStateSnapshot,
  requestId: string,
): NativePresenceEvent | null {
  const presence = snapshot.lastPresence;
  if (!presence) return null;
  if (typeof presence.requestId !== 'string' || presence.requestId !== requestId) return null;
  const deviceCount =
    typeof presence.deviceCount === 'number' && Number.isFinite(presence.deviceCount)
      ? presence.deviceCount
      : 0;
  const online = typeof presence.online === 'boolean' ? presence.online : deviceCount > 0;
  return { requestId: presence.requestId, deviceCount, online };
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
 * Subscribe to signaling-socket connectivity changes (`connected` /
 * `disconnected`, including socket.io auto-reconnects) from the persistent
 * native service. Independent of the p2p connection — data channels
 * deliberately survive signaling disruptions — so the app can surface a
 * dedicated "signaling server offline" state. Returns a no-op subscription
 * when the native module predates the event.
 */
export function addNativeSignalingStateListener(
  listener: (e: NativeSignalingStateEvent) => void,
  native: LiquidAuthNativeApi = getDefaultNativeApi(),
): NativeSubscription {
  if (!native.addSignalingStateListener) {
    return { remove: () => {} };
  }
  return native.addSignalingStateListener(listener);
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
    mode = 'attach',
    signal,
    onPresence,
    onLinkError,
    iceServers = DEFAULT_ICE_SERVERS,
    dataChannels = DEFAULT_DATA_CHANNELS,
    notifications = DEFAULT_AC2_NOTIFICATIONS,
    queueChannels = DEFAULT_AC2_QUEUE_CHANNELS,
    heartbeat = DEFAULT_AC2_HEARTBEAT,
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
    native.addMessageListener((e) => {
      const channel = channels.get(e.channel);
      console.log(
        `[ac2-native] onMessage received channel=${e.channel} hasShim=${channel != null}`,
      );
      channel?.dispatchMessage(e.message);
    }),
    native.addStateChangeListener((e) => {
      console.log(`[ac2-native] onStateChange channel=${e.channel} state=${e.state}`);
      channels.get(e.channel)?.setState(e.state);
    }),
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

    // If the background service is ALREADY connected to this `requestId` (it
    // kept the peer alive across a relaunch / foreground transition), re-attach
    // to the live connection instead of renegotiating — this is what "the
    // service stays connected and the frontend just connects when it's up"
    // means. `attach()` rebinds the native event listeners to this fresh JS
    // runtime and re-emits the current channel + ICE state, which the
    // subscriptions above route into the shims so the control channel is seen
    // as already open (hydration). No SDP/ICE renegotiation, so the live p2p
    // connection is never torn down.
    const existing = native.getConnectionState();
    const holdsPeer = existing.connected && existing.requestId === requestId;
    // Only hydrate off a peer that is BOTH the one the machine wants and
    // demonstrably usable: the control channel open and ICE not failed/closed.
    // A snapshot that merely says `connected` is not enough — the native side
    // reports the last state it saw, which after a long background can describe
    // a peer nothing can travel through any more.
    if (
      holdsPeer &&
      mode !== 'connect' &&
      isSnapshotChannelOpen(existing) &&
      !isDeadIce(existing)
    ) {
      await native.attach({
        dataChannels,
        notifications,
        queueChannels,
        ...(heartbeat ? { heartbeat } : {}),
      });
      if (signal?.aborted) throw makeAbortError();
      await waitForChannelOpen(controlChannel as any, CHANNEL_OPEN_TIMEOUT_MS, signal);
      onPeerConnection?.(peerConnection);
      return { datachannel: controlChannel, channels, peerConnection, disposePresence, dispose };
    }

    // ANY peer the service still holds — usable-looking or zombie — must go
    // before a fresh offer: leaving it in place keeps its ICE session alive,
    // so the agent ignores the new offer and the reconnect silently goes
    // nowhere, while its dying transitions later fire label-keyed events into
    // THIS session's shims. Deliberately unconditional (not gated on the
    // snapshot's `connected`): the strict native snapshot reports ICE
    // DISCONNECTED/FAILED/CLOSED peers as not-connected even while the service
    // still holds the peer object — exactly the zombies that most need
    // destroying. `cancel()` is a no-op when no peer is held.
    await native.cancel().catch(() => {
      /* best-effort; the fresh negotiation supersedes any lingering peer */
    });
    if (signal?.aborted) throw makeAbortError();

    // Race the native negotiation against the abort signal; on abort, ask the
    // native service to cancel the in-flight negotiation.
    let onAbort: (() => void) | undefined;
    const connectPromise = native.connect(requestId, 'answer', iceServers, {
      dataChannels,
      notifications,
      queueChannels,
      ...(heartbeat ? { heartbeat } : {}),
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
