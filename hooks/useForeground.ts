import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Invoke `onForeground` whenever the app returns to the foreground via a
 * genuine `(background|inactive) -> active` transition (never `active ->
 * active`). The latest callback is always used, so callers can pass an inline
 * closure without re-subscribing the `AppState` listener on every render.
 */
export function useForeground(onForeground: () => void): void {
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const callbackRef = useRef(onForeground);
  callbackRef.current = onForeground;

  useEffect(() => {
    const handleChange = (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState !== 'active' || prevState === 'active') return;
      callbackRef.current();
    };

    const subscription = AppState.addEventListener('change', handleChange);
    return () => subscription.remove();
  }, []);
}
