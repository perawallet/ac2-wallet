import type { SignalClient } from '@algorandfoundation/liquid-client';

type SignalClientCloseWithPeerOption = (disconnect?: boolean, closePeer?: boolean) => void;
type SignalClientWithDeferredPeerClose = SignalClient & {
  closePeerWhenSafe?: (timeoutMs?: number) => Promise<void>;
};

const deferredPeerCloses = new WeakMap<SignalClient, Promise<void>>();

/**
 * Disconnect a Liquid Auth signaling client with explicit peer ownership.
 *
 * Published liquid-client versions only accept `disconnect`; the upcoming
 * close API also accepts `closePeer`. Passing the extra argument is safe in
 * JavaScript, while the fallback peer close below keeps established transports
 * working with the currently installed client.
 */
export function closeSignalClient(client: SignalClient, closePeer: boolean): void {
  try {
    (client.close as SignalClientCloseWithPeerOption).call(client, true, closePeer);
  } finally {
    // A current-version client leaves the peer open. A future client clears
    // `peerClient` after closing it, so this is not a second native close there.
    if (closePeer) client.peerClient?.close();
  }
}

/**
 * Stop signaling immediately, then release an in-flight native peer only after
 * its WebRTC bridge work has had time to settle. New liquid-client versions
 * provide precise promise tracking; the timer fallback keeps currently
 * published clients bounded without reintroducing the Android SDP close race.
 */
export function closeSignalClientWhenSafe(client: SignalClient, timeoutMs = 10_000): Promise<void> {
  const existing = deferredPeerCloses.get(client);
  if (existing) return existing;

  const peer = client.peerClient;
  closeSignalClient(client, false);
  if (!peer) return Promise.resolve();

  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
  const deferredClient = client as SignalClientWithDeferredPeerClose;
  let cleanup: Promise<void>;
  if (typeof deferredClient.closePeerWhenSafe === 'function') {
    cleanup = deferredClient.closePeerWhenSafe(waitMs);
  } else {
    cleanup = new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          peer.close();
        } catch {
          // The native peer may already have closed during the grace period.
        }
        if (client.peerClient === peer) client.peerClient = undefined;
        resolve();
      }, waitMs);
    });
  }

  const tracked = cleanup.finally(() => {
    if (deferredPeerCloses.get(client) === tracked) deferredPeerCloses.delete(client);
  });
  deferredPeerCloses.set(client, tracked);
  return tracked;
}
