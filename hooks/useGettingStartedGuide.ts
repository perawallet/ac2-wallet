import { localStorage } from '@/stores/mmkv-local';
import { useCallback } from 'react';

const STORAGE_KEY = 'gettingStartedGuideSeen';

// Flip to false (or remove) once testing is done; the MMKV value takes over.
const ALWAYS_SHOW_FOR_TESTING = true;

export function useGettingStartedGuide() {
  const hasSeen = ALWAYS_SHOW_FOR_TESTING ? false : (localStorage.getBoolean(STORAGE_KEY) ?? false);

  const markAsSeen = useCallback(() => {
    localStorage.set(STORAGE_KEY, true);
  }, []);

  return { shouldShowGuide: !hasSeen, markAsSeen };
}
