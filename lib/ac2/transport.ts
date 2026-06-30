/**
 * Liquid Auth + WebRTC pairing for the AC2 controller. Negotiates the
 * `ac2-v1` / `ac2-stream` / `ac2-heartbeat` DataChannels that the AC2
 * SDK and the controller UI consume.
 */

import { SignalClient } from '@algorandfoundation/liquid-client';
import Constants from 'expo-constants';

// TURN credentials are injected at build time via `app.config.js` `extra.turn`
// (sourced from env vars / CI secrets). Nodely falls back to the
// previously-shipped credential so local/dev builds keep working; metered.ca
// has no fallback.
interface TurnCredential {
  username: string;
  credential: string;
}

const turnConfig = (Constants.expoConfig?.extra?.turn ?? {}) as {
  nodely?: Partial<TurnCredential>;
  metered?: Partial<TurnCredential>;
};

const NODELY_TURN: TurnCredential = {
  username: turnConfig.nodely?.username || 'liquid-auth',
  credential: turnConfig.nodely?.credential || 'sqmcP4MiTKMT4TGEDSk9jgHY',
};

// Only used when both values are present — an unauthenticated TURN entry is
// worse than omitting the provider.
const METERED_TURN: TurnCredential | null =
  turnConfig.metered?.username && turnConfig.metered?.credential
    ? { username: turnConfig.metered.username, credential: turnConfig.metered.credential }
    : null;

/**
 * Default ICE config for the Liquid Auth signaling pair. Mirrors the native
 * liquid-auth-android `AnswerActivity` server list so restrictive-network /
 * relay-dependent users have the same fallbacks the native client does.
 */
const DEFAULT_ICE_SERVERS = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
    ],
  },
  {
    // Nodely TURN — global + regional (eu/us), TCP and TLS variants.
    urls: [
      'turn:global.turn.nodely.network:80?transport=tcp',
      'turns:global.turn.nodely.network:443?transport=tcp',
      'turn:eu.turn.nodely.io:80?transport=tcp',
      'turns:eu.turn.nodely.io:443?transport=tcp',
      'turn:us.turn.nodely.io:80?transport=tcp',
      'turns:us.turn.nodely.io:443?transport=tcp',
    ],
    ...NODELY_TURN,
  },
  // metered.ca fallback — the native list's only UDP relay (ports 80/443 with
  // no `?transport` default to UDP) plus an independent provider. Added only
  // when METERED_TURN credentials are configured.
  ...(METERED_TURN
    ? [
        {
          urls: [
            'turn:global.relay.metered.ca:80',
            'turn:global.relay.metered.ca:80?transport=tcp',
            'turn:global.relay.metered.ca:443',
            'turns:global.relay.metered.ca:443?transport=tcp',
          ],
          ...METERED_TURN,
        },
      ]
    : []),
];

/** DataChannel labels requested on the peer (AC2 spec mandated). */
const DEFAULT_DATA_CHANNELS = {
  'ac2-v1': { ordered: true },
  'ac2-stream': { ordered: true },
  'ac2-heartbeat': { ordered: true },
};

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

  const datachannel = await signalClient.peer(
    requestId,
    'answer',
    {
      iceServers: DEFAULT_ICE_SERVERS,
    },
    {
      dataChannels: DEFAULT_DATA_CHANNELS,
    },
  );

  return { client: signalClient, datachannel };
}
