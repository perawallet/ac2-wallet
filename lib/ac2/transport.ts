/**
 * Liquid Auth + WebRTC pairing for the AC2 controller. Negotiates the
 * `ac2-v1` / `ac2-stream` / `ac2-heartbeat` DataChannels that the AC2
 * SDK and the controller UI consume.
 */

import { SignalClient } from '@algorandfoundation/liquid-client';
import { getPairingAuthorizationFailure } from '@/lib/liquid-auth/connection-errors';
import { closeSignalClientWhenSafe } from '@/lib/liquid-auth/signal-client';

/** Default ICE config for the Liquid Auth signaling pair. */
const DEFAULT_ICE_SERVERS = [
  {
    urls: ['stun:geo.turn.algonode.xyz:80', 'stun:global.turn.nodely.io:443'],
  },
  {
    urls: [
      'turn:geo.turn.algonode.xyz:80?transport=tcp',
      'turns:global.turn.nodely.io:443?transport=tcp',
    ],
    username: 'liquid-auth',
    credential: 'sqmcP4MiTKMT4TGEDSk9jgHY',
  },
];

/** DataChannel labels requested on the peer (AC2 spec mandated). */
const DEFAULT_DATA_CHANNELS = {
  'ac2-v1': { ordered: true },
  'ac2-stream': { ordered: true },
  'ac2-heartbeat': { ordered: true },
};

const SIGNALING_TIMEOUT_MS = 30000;
const SOCKET_CONNECT_TIMEOUT_MS = 10000;
// `signalClient.peer()` resolves once the remote description is applied, long
// before the `ac2-v1` channel is actually usable. Bound how long we then wait
// for it to reach `open`, so a peer whose ICE never establishes (a STUN/TURN
// stall) turns into a fast rejection the caller can retry rather than an
// indefinite hang.
const CHANNEL_OPEN_TIMEOUT_MS = 15000;
const SIGNAL_CANDIDATE_NORMALIZER = Symbol('ac2.signalCandidateNormalizer');
const SIGNAL_CANDIDATE_EVENTS = new Set(['offer-candidate', 'answer-candidate']);
type SocketListener = (...args: any[]) => unknown;

export interface Ac2TransportSetup {
  /** Active Liquid Auth `SignalClient` (already authenticated). */
  client: SignalClient;
  /** The control plane DataChannel (`ac2-v1`). */
  datachannel: RTCDataChannel;
}

export interface CreateAc2TransportOptions {
  requestId: string;
  signalClient: SignalClient;
  /** Called for each negotiated side-channel (`ac2-stream`, `ac2-heartbeat`). */
  onSideChannel: (channel: RTCDataChannel) => void;
  /**
   * Called once with the negotiated `RTCPeerConnection` (the SDK's
   * `peerClient`) as soon as negotiation resolves, so the caller can attach a
   * connectivity monitor — the SDK never does. `peerClient` is guaranteed set
   * at this point.
   */
  onPeerConnection?: (peerConnection: RTCPeerConnection) => void;
  /**
   * Optional abort signal. When fired the pending negotiation is torn down
   * immediately and the returned promise rejects with an `AbortError`.
   */
  signal?: AbortSignal;
}

/**
 * Open the AC2 control plane DataChannel against an already-authenticated
 * `SignalClient`. Side-channels (`ac2-stream`, `ac2-heartbeat`) are
 * surfaced via `onSideChannel`.
 */
export async function createAc2Transport(
  opts: CreateAc2TransportOptions,
): Promise<Ac2TransportSetup> {
  const { requestId, signalClient, onSideChannel, onPeerConnection, signal } = opts;

  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }

  signalClient.on('data-channel', (channel: RTCDataChannel) => {
    if (channel.label === 'ac2-v1') return; // owned by datachannel below
    onSideChannel(channel);
  });

  await waitForSignalSocketConnected(signalClient, signal);
  installSignalCandidateNormalizer(signalClient);

  const peerPromise = signalClient.peer(
    requestId,
    'answer',
    {
      iceServers: DEFAULT_ICE_SERVERS,
    },
    {
      dataChannels: DEFAULT_DATA_CHANNELS,
      // The controller owns the bounded timeout/abort races below. Disable the
      // client's flat peer timeout so both layers cannot race independent
      // cleanup paths, while still letting newer clients cancel their listeners.
      timeoutMs: 0,
      ...(signal ? { signal } : {}),
    } as any,
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RTCDataChannel>((_, reject) => {
    timeoutId = setTimeout(() => {
      // Cancel and detach signaling without hard-closing a native peer that may
      // still be inside react-native-webrtc's asynchronous SDP bridge.
      void closeSignalClientWhenSafe(signalClient);
      reject(
        new Error(
          'Timed out waiting for Liquid Auth answer-description. Check that the signaling socket is authenticated and the OpenClaw peer is still linked to this requestId.',
        ),
      );
    }, SIGNALING_TIMEOUT_MS);
  });

  const racers: Promise<RTCDataChannel>[] = [peerPromise, timeoutPromise];

  // Track the abort listener so it can be removed in `finally` regardless of
  // which racer wins — prevents a dangling listener from firing later and
  // inadvertently closing a healthy peer connection.
  let onAbort: (() => void) | undefined;

  if (signal) {
    const abortPromise = new Promise<RTCDataChannel>((_, reject) => {
      const abort = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        // Do NOT hard-close the native peer on abort. On Android,
        // `react-native-webrtc` can still be asynchronously applying the
        // remote description when a superseded run is cancelled; tearing the
        // peer down here races that in-flight work and can crash with
        // `peerConnectionSetRemoteDescription(...getPeerConnection() == null)`.
        // Detach the obsolete SignalClient/socket without forcing this unsafe
        // native transition. The caller may still run its normal idempotent
        // transport cleanup afterward.
        void closeSignalClientWhenSafe(signalClient);
        // Use a plain Error with name 'AbortError' rather than DOMException
        // for broadest compatibility across Hermes versions.
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) {
        abort();
        return;
      }
      onAbort = abort;
      signal.addEventListener('abort', onAbort);
    });
    racers.push(abortPromise);
  }

  const datachannel = await Promise.race(racers).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });

  // Surface the negotiated peer connection so the caller can watch it for
  // connectivity loss. The SDK attaches no ICE/connection state handlers, so
  // this is the only seam for detecting a post-negotiation drop.
  if (signalClient.peerClient) onPeerConnection?.(signalClient.peerClient);

  // The negotiation above resolves once the remote description is applied, but
  // the `ac2-v1` channel is still `connecting` at that point. Block until it
  // actually opens so a peer whose ICE never completes (STUN/TURN stall) fails
  // fast into the caller's retry path instead of hanging forever waiting for an
  // `onOpen` that never arrives.
  try {
    await waitForChannelOpen(datachannel, CHANNEL_OPEN_TIMEOUT_MS, signal);
  } catch (err: any) {
    // A non-abort failure (open timeout / early close) leaves a half-open peer
    // whose ICE machinery would otherwise keep running; close it promptly,
    // mirroring the signaling-timeout cleanup above. An abort intentionally
    // does NOT hard-close the native peer here (see the abort handler's note
    // about Android's in-flight setRemoteDescription).
    if (err?.name !== 'AbortError') {
      try {
        signalClient.peerClient?.close();
      } catch {
        /* noop */
      }
    }
    throw err;
  }

  return { client: signalClient, datachannel };
}

/**
 * Resolve once `channel` reaches the `open` state. Rejects if it does not open
 * within `timeoutMs`, if it closes/errors first, or if `signal` aborts (with an
 * `AbortError`). All listeners and the timer are detached on settle.
 */
export function waitForChannelOpen(
  channel: RTCDataChannel,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve();
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function finish(err?: Error) {
      if (timer !== undefined) clearTimeout(timer);
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    }

    const onOpen = () => finish();
    const onClose = () => finish(new Error('ac2-v1 DataChannel closed before it opened'));
    const onError = () => finish(new Error('ac2-v1 DataChannel errored before it opened'));
    const onAbort = () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      finish(err);
    };

    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);

    timer = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out waiting for the ac2-v1 DataChannel to open (${timeoutMs}ms). ` +
              'ICE likely failed to establish a path to the peer (STUN/TURN).',
          ),
        ),
      timeoutMs,
    );

    // Guard against the channel opening between the initial check and listener
    // attachment.
    if (channel.readyState === 'open') finish();
  });
}

export function normalizeIceCandidateForReactNative(
  candidate: RTCIceCandidateInit,
): RTCIceCandidateInit {
  if (!candidate || typeof candidate.candidate !== 'string') return candidate;

  const normalizedCandidate = candidate.candidate.trim().replace(/^a=/, '');
  const normalized = { ...candidate, candidate: normalizedCandidate };

  if (normalized.sdpMLineIndex === null && typeof normalized.sdpMid === 'string') {
    const parsedMid = Number.parseInt(normalized.sdpMid, 10);
    if (Number.isFinite(parsedMid)) normalized.sdpMLineIndex = parsedMid;
  }

  for (const key of Object.keys(normalized) as (keyof RTCIceCandidateInit)[]) {
    if (normalized[key] === null) delete normalized[key];
  }

  return normalized;
}

export function installSignalCandidateNormalizer(signalClient: SignalClient): void {
  const socket = signalClient.socket as any;
  if (!socket || socket[SIGNAL_CANDIDATE_NORMALIZER] || typeof socket.on !== 'function') {
    return;
  }

  const originalOn = socket.on.bind(socket);
  const originalOff = typeof socket.off === 'function' ? socket.off.bind(socket) : undefined;
  const originalRemoveListener =
    typeof socket.removeListener === 'function' ? socket.removeListener.bind(socket) : undefined;
  const originalOnce = typeof socket.once === 'function' ? socket.once.bind(socket) : undefined;
  const registrations = new Map<string, Map<SocketListener, SocketListener[]>>();

  const remember = (event: string, listener: SocketListener, wrapped: SocketListener) => {
    let eventRegistrations = registrations.get(event);
    if (!eventRegistrations) {
      eventRegistrations = new Map();
      registrations.set(event, eventRegistrations);
    }
    const wrappedListeners = eventRegistrations.get(listener) ?? [];
    wrappedListeners.push(wrapped);
    eventRegistrations.set(listener, wrappedListeners);
  };

  const forget = (event: string, listener: SocketListener): SocketListener | undefined => {
    const eventRegistrations = registrations.get(event);
    const wrappedListeners = eventRegistrations?.get(listener);
    const wrapped = wrappedListeners?.shift();
    if (wrappedListeners?.length === 0) eventRegistrations?.delete(listener);
    if (eventRegistrations?.size === 0) registrations.delete(event);
    return wrapped;
  };

  const forgetWrapped = (event: string, listener: SocketListener, wrapped: SocketListener) => {
    const eventRegistrations = registrations.get(event);
    const wrappedListeners = eventRegistrations?.get(listener);
    const index = wrappedListeners?.indexOf(wrapped) ?? -1;
    if (index >= 0) wrappedListeners?.splice(index, 1);
    if (wrappedListeners?.length === 0) eventRegistrations?.delete(listener);
    if (eventRegistrations?.size === 0) registrations.delete(event);
  };

  const wrap = (event: string, listener: SocketListener): SocketListener => {
    const wrapped = (candidate: RTCIceCandidateInit, ...args: any[]) =>
      listener(normalizeIceCandidateForReactNative(candidate), ...args);
    // component-emitter uses `.fn` to let `off(event, original)` remove a
    // once-wrapper. Keeping it here also preserves that convention for callers
    // which bypass our patched removal methods.
    Object.defineProperty(wrapped, 'fn', { value: listener });
    remember(event, listener, wrapped);
    return wrapped;
  };

  socket.on = (event: string, listener: SocketListener) => {
    if (SIGNAL_CANDIDATE_EVENTS.has(event) && typeof listener === 'function') {
      return originalOn(event, wrap(event, listener));
    }

    return originalOn(event, listener);
  };

  const installRemoval = (
    methodName: 'off' | 'removeListener',
    originalRemoval: ((event: string, listener?: SocketListener) => unknown) | undefined,
  ) => {
    if (!originalRemoval) return;
    socket[methodName] = (event: string, listener?: SocketListener) => {
      if (SIGNAL_CANDIDATE_EVENTS.has(event)) {
        if (typeof listener === 'function') {
          const wrapped = forget(event, listener);
          if (wrapped) return originalRemoval(event, wrapped);
        } else {
          registrations.delete(event);
        }
      }
      return originalRemoval(event, listener);
    };
  };

  installRemoval('off', originalOff);
  installRemoval('removeListener', originalRemoveListener);

  if (originalOnce) {
    socket.once = (event: string, listener: SocketListener) => {
      if (!SIGNAL_CANDIDATE_EVENTS.has(event) || typeof listener !== 'function') {
        return originalOnce(event, listener);
      }

      let wrapped: SocketListener;
      wrapped = (candidate: RTCIceCandidateInit, ...args: any[]) => {
        forgetWrapped(event, listener, wrapped);
        (originalOff ?? originalRemoveListener)?.(event, wrapped);
        return listener(normalizeIceCandidateForReactNative(candidate), ...args);
      };
      Object.defineProperty(wrapped, 'fn', { value: listener });
      remember(event, listener, wrapped);
      return originalOn(event, wrapped);
    };
  }

  Object.defineProperty(socket, SIGNAL_CANDIDATE_NORMALIZER, { value: true });
}

export async function waitForSignalSocketConnected(
  signalClient: SignalClient,
  signal?: AbortSignal,
): Promise<void> {
  // The liquid-client constructor resolves once socket.io is created, not once
  // it is connected. Sending the SDP after the connect event keeps signaling
  // ordering deterministic on React Native.
  const abortError = () => {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
  };
  if (signal?.aborted) throw abortError();

  const socketReady = Promise.resolve((signalClient as any)._socketPromise);
  if (signal) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onAbort = () => finish(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      socketReady.then(
        () => finish(),
        (error) => finish(error),
      );
      if (signal.aborted) onAbort();
    });
  } else {
    await socketReady;
  }
  const socket = signalClient.socket as any;
  if (socket?.connected) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Liquid Auth signal socket to connect'));
    }, SOCKET_CONNECT_TIMEOUT_MS);

    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onConnectError = (err: Error & { code?: unknown; data?: unknown }) => {
      // Socket.IO emits `connect_error` for transient transport failures too
      // (offline transitions, proxy resets, failed polling probes). Let the
      // manager keep trying until our timeout instead of tearing down the whole
      // WebRTC setup on the first recoverable error. Explicit authorization
      // failures are terminal for this attempt; the connection supervisor
      // separately decides whether to revoke or refresh the local credential.
      if (!getPairingAuthorizationFailure(err)) return;
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket?.off?.('connect', onConnect);
      socket?.off?.('connect_error', onConnectError);
      signal?.removeEventListener('abort', onAbort);
    };

    socket?.on?.('connect', onConnect);
    socket?.on?.('connect_error', onConnectError);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the tiny race between the initial `connected` check and listener
    // registration. Socket.IO may complete synchronously from a warm manager.
    if (socket?.connected) onConnect();
    else if (signal?.aborted) onAbort();
  });
}
