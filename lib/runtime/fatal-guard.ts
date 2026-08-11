/**
 * Black-box recorder and crash-loop breaker for fatal JS errors.
 *
 * On iOS a fatal JS error is a hard native crash in release builds: the
 * global handler forwards it to `RCTFatal`, whose NSException aborts the
 * process (or, during the launch window, becomes expo-updates' ErrorRecovery
 * crash). Render errors are caught by `RootErrorBoundary`, but module-scope
 * evaluation errors and errors thrown in timers/event callbacks never reach a
 * boundary. This module:
 *
 *  1. Records every fatal error to MMKV *before* the process dies, so the
 *     next launch can report what actually crashed (`consumeLastFatal`).
 *  2. Tracks whether the previous launch died inside its startup window
 *     (`didLastLaunchCrashDuringStartup`), so startup code can quarantine
 *     whatever it was about to replay (e.g. auto-reconnecting a persisted
 *     session) instead of crash-looping.
 *
 * Must be installed from the entry point (`index.js`) before
 * `expo-router/entry`, so it also observes route-module evaluation errors.
 */
import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV({ id: 'fatal-guard' });

const LAST_FATAL_KEY = 'lastFatalError';
const LAUNCH_PENDING_KEY = 'launchPending';

/** How long after install a crash still counts as a "startup" crash. */
const STARTUP_WINDOW_MS = 15_000;

export interface RecordedFatal {
  message: string;
  stack?: string;
  /** Epoch ms when the error was recorded. */
  at: number;
  /** True when the fatal happened inside the startup window. */
  duringStartup: boolean;
}

let previousLaunchDiedEarly = false;
let previousFatal: RecordedFatal | null = null;
let installed = false;

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
}

export function installFatalGuard() {
  if (installed) return;
  installed = true;

  try {
    previousLaunchDiedEarly = storage.getBoolean(LAUNCH_PENDING_KEY) === true;
    const stored = storage.getString(LAST_FATAL_KEY);
    if (stored) previousFatal = JSON.parse(stored) as RecordedFatal;
  } catch {
    // Never let the guard itself break startup.
  }

  // Mark this launch as in-flight; cleared once the startup window elapses.
  // If the process dies before the timer fires, the flag survives and the
  // next launch knows startup never completed.
  try {
    storage.set(LAUNCH_PENDING_KEY, true);
  } catch {
    /* ignore */
  }
  const installedAt = Date.now();
  setTimeout(() => {
    try {
      storage.set(LAUNCH_PENDING_KEY, false);
    } catch {
      /* ignore */
    }
  }, STARTUP_WINDOW_MS);

  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils) return;

  const previousHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    if (isFatal) {
      try {
        const err = error as { message?: unknown; stack?: unknown };
        const record: RecordedFatal = {
          message: typeof err?.message === 'string' ? err.message : String(error),
          ...(typeof err?.stack === 'string' ? { stack: err.stack } : {}),
          at: Date.now(),
          duringStartup: Date.now() - installedAt < STARTUP_WINDOW_MS,
        };
        storage.set(LAST_FATAL_KEY, JSON.stringify(record));
      } catch {
        /* recording must never mask the original error */
      }
    }
    previousHandler(error, isFatal);
  });
}

/** True when the previous launch never made it past its startup window. */
export function didLastLaunchCrashDuringStartup(): boolean {
  return previousLaunchDiedEarly;
}

/** The fatal error recorded by the previous launch (if any), cleared on read. */
export function consumeLastFatal(): RecordedFatal | null {
  const fatal = previousFatal;
  previousFatal = null;
  if (fatal) {
    try {
      storage.remove(LAST_FATAL_KEY);
    } catch {
      /* ignore */
    }
  }
  return fatal;
}
