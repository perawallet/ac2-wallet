import { localStorage } from '@/stores/mmkv-local';
import { useCallback } from 'react';

const STORAGE_KEY = 'gettingStartedGuideSeen';

export function useGettingStartedGuide() {
  const hasSeen = localStorage.getBoolean(STORAGE_KEY) ?? false;

  const markAsSeen = useCallback(() => {
    localStorage.set(STORAGE_KEY, true);
  }, []);

  return { shouldShowGuide: !hasSeen, markAsSeen };
}
