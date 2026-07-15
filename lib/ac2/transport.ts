/**
 * Liquid Auth + WebRTC pairing for the AC2 controller. Negotiates the
 * `ac2-v1` / `ac2-stream` / `ac2-heartbeat` DataChannels that the AC2
 * SDK and the controller UI consume.
 */

import { SignalClient } from '@algorandfoundation/liquid-client';

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
  const { requestId, signalClient, onSideChannel, signal } = opts;

  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }

  signalClient.on('data-channel', (channel: RTCDataChannel) => {
    if (channel.label === 'ac2-v1') return; // owned by datachannel below
    onSideChannel(channel);
  });

  await waitForSignalSocketConnected(signalClient);
  installSignalCandidateNormalizer(signalClient);

  const peerPromise = signalClient.peer(
    requestId,
    'answer',
    {
      iceServers: DEFAULT_ICE_SERVERS,
    },
    {
      dataChannels: DEFAULT_DATA_CHANNELS,
    },
  );

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RTCDataChannel>((_, reject) => {
    timeoutId = setTimeout(() => {
      signalClient.peerClient?.close();
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
        // The caller's normal transport cleanup will detach the obsolete
        // SignalClient/socket without forcing this unsafe native transition.
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
  socket.on = (event: string, listener: (...args: any[]) => unknown) => {
    if (SIGNAL_CANDIDATE_EVENTS.has(event) && typeof listener === 'function') {
      return originalOn(event, (candidate: RTCIceCandidateInit, ...args: any[]) =>
        listener(normalizeIceCandidateForReactNative(candidate), ...args),
      );
    }

    return originalOn(event, listener);
  };

  Object.defineProperty(socket, SIGNAL_CANDIDATE_NORMALIZER, { value: true });
}

async function waitForSignalSocketConnected(signalClient: SignalClient): Promise<void> {
  // The liquid-client constructor resolves once socket.io is created, not once
  // it is connected. Sending the SDP after the connect event keeps signaling
  // ordering deterministic on React Native.
  await (signalClient as any)._socketPromise;
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
    const onConnectError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket?.off?.('connect', onConnect);
      socket?.off?.('connect_error', onConnectError);
    };

    socket?.on?.('connect', onConnect);
    socket?.on?.('connect_error', onConnectError);
  });
}
