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
}

/**
 * Open the AC2 control plane DataChannel against an already-authenticated
 * `SignalClient`. Side-channels (`ac2-stream`, `ac2-heartbeat`) are
 * surfaced via `onSideChannel`.
 */
export async function createAc2Transport(
  opts: CreateAc2TransportOptions,
): Promise<Ac2TransportSetup> {
  const { requestId, signalClient, onSideChannel } = opts;

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

  const datachannel = await Promise.race([peerPromise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });

  return { client: signalClient, datachannel };
}

export function normalizeIceCandidateForReactNative(
  candidate: RTCIceCandidateInit,
): RTCIceCandidateInit {
  if (!candidate || typeof candidate.candidate !== 'string') return candidate;

  const normalizedCandidate = candidate.candidate.trim().replace(/^a=/, '');
  if (normalizedCandidate === candidate.candidate) return candidate;

  return { ...candidate, candidate: normalizedCandidate };
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
