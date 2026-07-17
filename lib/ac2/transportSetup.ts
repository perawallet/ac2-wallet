/**
 * Pure setup helpers for the wallet-side connection lifecycle, factored out of
 * `useConnection` so they can be reasoned about (and unit-tested) in isolation.
 *
 * Neither helper touches React state — they only build values the connection
 * effect consumes.
 */
import { XHR as EngineIoXHR } from 'engine.io-client';
import { NativeModules, Platform } from 'react-native';

export type FetchWithTimeout = (
  input: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

/**
 * Build a `fetch` wrapper that (a) aborts each request after `defaultTimeoutMs`
 * and (b) is chained to a run-scoped `AbortSignal`, so a superseded setup run
 * (or unmount) cancels every in-flight request instead of letting it hang.
 *
 * React Native's `fetch` has NO default timeout, so a request issued while the
 * network is still recovering from a drop can stall forever; bounding it turns
 * a silent hang into a rejection that flows into the retry state machine.
 */
export function createFetchWithTimeout(
  runSignal: AbortSignal,
  defaultTimeoutMs: number,
): FetchWithTimeout {
  return (input, init = {}, timeoutMs = defaultTimeoutMs) => {
    const controller = new AbortController();
    const onRunAbort = () => controller.abort();
    if (runSignal.aborted) controller.abort();
    else runSignal.addEventListener('abort', onRunAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      runSignal.removeEventListener('abort', onRunAbort);
    });
  };
}

export interface SignalClientOptions {
  autoConnect: boolean;
  transportOptions: Record<string, unknown>;
  withCredentials: boolean;
  transports?: unknown[];
  extraHeaders?: Record<string, string>;
}

/**
 * Assemble the `SignalClient` options for `origin`, applying the
 * platform-specific transport/cookie handling:
 *
 * - iOS uses the engine.io XHR transport explicitly.
 * - Android forwards the persisted auth cookie (when present) via
 *   `NativeModules.CookieModule`, pinning the socket to long-polling so the
 *   header is honored.
 */
export async function buildSignalClientOptions(origin: string): Promise<SignalClientOptions> {
  const options: SignalClientOptions = {
    autoConnect: true,
    transportOptions: {},
    withCredentials: true,
  };

  if (Platform.OS === 'ios') {
    options.transports = [EngineIoXHR];
  } else if (NativeModules.CookieModule) {
    const cookie = await NativeModules.CookieModule.getCookie(origin);
    if (cookie) {
      options.extraHeaders = { Cookie: cookie };
      options.transports = ['polling'];
      options.transportOptions = {
        polling: { extraHeaders: { Cookie: cookie } },
      };
    }
  }

  return options;
}
