import { useSyncExternalStore } from 'react';

import type { AutoPauseSetting } from '@/lib/auto-pause-preference';
import {
  ensureAutoPauseHydrated,
  getAutoPauseSetting,
  setAutoPauseSetting,
  subscribeToAutoPauseSetting,
} from '@/lib/auto-pause-preference';

/** The persisted auto-pause preference, live everywhere it's read — same shared-store pattern as useDistanceUnit. */
export function useAutoPause(): [AutoPauseSetting, (setting: AutoPauseSetting) => void] {
  ensureAutoPauseHydrated();
  const setting = useSyncExternalStore(
    subscribeToAutoPauseSetting,
    getAutoPauseSetting,
    getAutoPauseSetting,
  );
  return [setting, setAutoPauseSetting];
}
