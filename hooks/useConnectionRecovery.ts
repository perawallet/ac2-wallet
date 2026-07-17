import { useCallback, useRef } from 'react';

export type ConnectionFailureReason = 'channel' | 'setup' | 'ice' | 'heartbeat' | 'send' | 'open';

export type ConnectionPhase = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface ConnectionRecoveryUiPatch {
  phase?: ConnectionPhase;
  reconnectAttempt?: number;
  error?: Error | null;
}

export interface UseConnectionRecoveryOptions {
  autoReconnectDelayMs: number;
  maxReconnectAttempts: number;
  patchUi: (patch: ConnectionRecoveryUiPatch) => void;
  clearTransport: () => void;
  prepareReconnect: () => void;
  requestReconnect: () => void;
  logFailure: (reason: ConnectionFailureReason) => void;
  onRecoveryExhausted?: (error?: Error) => void;
}

export interface UseConnectionRecoveryResult {
  autoReconnectTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  userStoppedRef: React.MutableRefObject<boolean>;
  clearPendingAutoReconnect: () => void;
  resetRecovery: (userStopped?: boolean) => void;
  reconnect: () => void;
  reconnectRef: React.MutableRefObject<() => void>;
  failConnectionRef: React.MutableRefObject<
    (reason: ConnectionFailureReason, isCurrent: () => boolean, error?: Error) => void
  >;
  markConnected: () => void;
}

export function useConnectionRecovery(
  options: UseConnectionRecoveryOptions,
): UseConnectionRecoveryResult {
  const {
    autoReconnectDelayMs,
    maxReconnectAttempts,
    patchUi,
    clearTransport,
    prepareReconnect,
    requestReconnect,
    logFailure,
    onRecoveryExhausted,
  } = options;

  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const userStoppedRef = useRef(false);

  const clearPendingAutoReconnect = useCallback(() => {
    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }
  }, []);

  // Tear down any stale transport and re-run setup. Deliberately does NOT set
  // the phase: an auto-retry stays `reconnecting` for the whole in-flight
  // attempt (so the UI keeps showing "Reconnecting (n/max)…"), while a manual
  // reconnect sets `connecting` itself before calling this.
  const performReconnect = useCallback(() => {
    prepareReconnect();
    clearPendingAutoReconnect();
    clearTransport();
    patchUi({ error: null });
    requestReconnect();
  }, [clearPendingAutoReconnect, clearTransport, patchUi, prepareReconnect, requestReconnect]);
  const performReconnectRef = useRef(performReconnect);
  performReconnectRef.current = performReconnect;

  const reconnect = useCallback(() => {
    userStoppedRef.current = false;
    reconnectAttemptRef.current = 0;
    patchUi({ reconnectAttempt: 0, phase: 'connecting' });
    performReconnect();
  }, [patchUi, performReconnect]);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  const scheduleAutoReconnect = useCallback((): boolean => {
    if (userStoppedRef.current) return false;
    if (autoReconnectTimerRef.current) return true;
    if (reconnectAttemptRef.current >= maxReconnectAttempts) return false;

    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    patchUi({ reconnectAttempt: attempt, phase: 'reconnecting' });
    autoReconnectTimerRef.current = setTimeout(() => {
      autoReconnectTimerRef.current = null;
      performReconnectRef.current();
    }, autoReconnectDelayMs);
    return true;
  }, [autoReconnectDelayMs, maxReconnectAttempts, patchUi]);
  const scheduleAutoReconnectRef = useRef(scheduleAutoReconnect);
  scheduleAutoReconnectRef.current = scheduleAutoReconnect;

  const failConnection = useCallback(
    (reason: ConnectionFailureReason, isCurrent: () => boolean, error?: Error) => {
      if (!isCurrent()) return;
      if (!error) console.log(`Connection lost (${reason})`);
      logFailure(reason);
      clearTransport();
      if (!scheduleAutoReconnectRef.current()) {
        patchUi({ phase: error ? 'failed' : 'closed' });
        if (error) patchUi({ error });
        onRecoveryExhausted?.(error);
      }
    },
    [clearTransport, logFailure, onRecoveryExhausted, patchUi],
  );
  const failConnectionRef = useRef(failConnection);
  failConnectionRef.current = failConnection;

  const resetRecovery = useCallback(
    (userStopped = true) => {
      userStoppedRef.current = userStopped;
      reconnectAttemptRef.current = 0;
      clearPendingAutoReconnect();
      patchUi({ reconnectAttempt: 0 });
    },
    [clearPendingAutoReconnect, patchUi],
  );

  const markConnected = useCallback(() => {
    clearPendingAutoReconnect();
    reconnectAttemptRef.current = 0;
    patchUi({ phase: 'connected', reconnectAttempt: 0 });
  }, [clearPendingAutoReconnect, patchUi]);

  return {
    autoReconnectTimerRef,
    userStoppedRef,
    clearPendingAutoReconnect,
    resetRecovery,
    reconnect,
    reconnectRef,
    failConnectionRef,
    markConnected,
  };
}
