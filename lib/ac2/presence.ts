/**
 * Liquid Auth presence detection, handled outside the `SignalClient` directly
 * on the signaling socket.
 *
 * The Liquid Auth signaling server exposes a dedicated `presence` websocket
 * event: emitting `{ requestId }` returns an ack `{ requestId, deviceCount,
 * online }`, and the server also broadcasts the same shape to everyone in the
 * `requestId` room whenever a peer joins or leaves. This lets a (potentially
 * offline) wallet detect whether there is anyone connected for a `requestId`
 * before attempting to (re)connect — the "should I even bother reconnecting?"
 * decision.
 *
 * The helpers here are intentionally decoupled from `SignalClient`: they work
 * against any object exposing socket.io's `emit`/`on`/`off`, so they can be
 * driven by `signalClient.socket` in production and by a plain mock in tests.
 */

/** Presence snapshot for a `requestId`, as reported by the signaling server. */
export interface PresenceResult {
  requestId: string;
  /** Number of devices currently connected for the `requestId`. */
  deviceCount: number;
  /** Convenience flag: `deviceCount > 0`. */
  online: boolean;
}

/**
 * Minimal socket surface the presence helpers rely on. Satisfied by a
 * socket.io-client `Socket` (and by `signalClient.socket`).
 */
export interface PresenceSocket {
  emit: (event: string, ...args: any[]) => unknown;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
}

export const PRESENCE_EVENT = 'presence';
const DEFAULT_PRESENCE_TIMEOUT_MS = 10000;

/**
 * Coerce an arbitrary presence payload into a well-formed `PresenceResult`,
 * tolerating a missing/partial ack from an older server. Falls back to the
 * queried `requestId` and derives `online` from `deviceCount` when absent.
 */
export function normalizePresence(requestId: string, data: unknown): PresenceResult {
  const record = (data ?? {}) as Record<string, unknown>;
  const deviceCount =
    typeof record.deviceCount === 'number' && Number.isFinite(record.deviceCount)
      ? record.deviceCount
      : 0;
  const online = typeof record.online === 'boolean' ? record.online : deviceCount > 0;
  const resolvedRequestId =
    typeof record.requestId === 'string' && record.requestId.length > 0
      ? record.requestId
      : requestId;
  return { requestId: resolvedRequestId, deviceCount, online };
}

/**
 * Query how many devices are connected for `requestId` by emitting the
 * `presence` event and awaiting the server ack. Rejects on an empty
 * `requestId` or if no ack arrives within `timeoutMs`.
 */
export function queryPresence(
  socket: PresenceSocket,
  requestId: string,
  opts: { timeoutMs?: number } = {},
): Promise<PresenceResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PRESENCE_TIMEOUT_MS;
  return new Promise<PresenceResult>((resolve, reject) => {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      reject(new Error('presence query requires a non-empty requestId'));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out waiting for presence ack for ${requestId} (${timeoutMs}ms)`));
    }, timeoutMs);

    try {
      socket.emit(PRESENCE_EVENT, { requestId }, (data: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(normalizePresence(requestId, data));
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err as Error);
    }
  });
}

/**
 * Subscribe to server-broadcast `presence` updates. Returns an unsubscribe
 * function. Safe to call against a null/undefined socket, or one that lacks
 * `on`/`off` (no-op) — e.g. a `SignalClient` whose socket has not finished its
 * asynchronous initialization yet.
 */
export function subscribeToPresence(
  socket: PresenceSocket | null | undefined,
  handler: (presence: PresenceResult) => void,
): () => void {
  if (!socket) {
    return () => {};
  }
  const listener = (data: unknown) => {
    const record = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    handler(normalizePresence(requestId, data));
  };
  socket.on?.(PRESENCE_EVENT, listener);
  return () => {
    socket.off?.(PRESENCE_EVENT, listener);
  };
}

/**
 * Decide, from the wallet's own perspective, whether the *peer* (the other
 * party in the `requestId` room) is offline.
 *
 * The signaling server counts the wallet itself once its socket has joined the
 * room, so a broadcast/ack the wallet receives reports `deviceCount` including
 * itself: `deviceCount <= 1` therefore means "nobody but me" — the peer is not
 * there. A missing snapshot is treated as unknown (returns `false`) so the app
 * doesn't cry wolf before the first presence update arrives.
 */
export function isPeerOffline(presence: PresenceResult | null | undefined): boolean {
  if (!presence) return false;
  return presence.deviceCount <= 1;
}

/**
 * Regex for signaling failures that mean the peer never answered — i.e. it is
 * not linked/online for the `requestId`. Matches the transport's answer-
 * description timeout message (see `createAc2Transport`).
 */
const PEER_UNREACHABLE_MESSAGE = /answer-description|Timed out waiting for Liquid Auth/i;

/**
 * Classify a connection failure as "the peer is unreachable/offline" purely
 * from its error message. Used alongside {@link isPeerOffline} so the wallet can
 * surface a clear "peer offline" alert instead of a cryptic timeout when the
 * other device simply isn't available.
 */
export function isPeerUnreachableError(error?: { message?: unknown } | null): boolean {
  const message = error?.message;
  return typeof message === 'string' && PEER_UNREACHABLE_MESSAGE.test(message);
}

/**
 * Convenience wrapper for the reconnect decision: resolves `true` when at
 * least one device is connected for `requestId`. Swallows query errors and
 * timeouts into `false` so an offline client simply declines to reconnect
 * rather than throwing.
 */
export async function hasPeerPresence(
  socket: PresenceSocket,
  requestId: string,
  opts?: { timeoutMs?: number },
): Promise<boolean> {
  try {
    const presence = await queryPresence(socket, requestId, opts);
    return presence.online;
  } catch {
    return false;
  }
}
