import { useSyncExternalStore } from 'react';

import type { Appearance } from '@/lib/appearance-preference';
import {
  ensureAppearanceHydrated,
  getAppearance,
  setAppearance,
  subscribeToAppearance,
} from '@/lib/appearance-preference';

/** The persisted Appearance preference ('system' | 'light' | 'dark'), live everywhere it's read — same shared-store pattern as useDistanceUnit. */
export function useAppearance(): [Appearance, (appearance: Appearance) => void] {
  ensureAppearanceHydrated();
  const appearance = useSyncExternalStore(subscribeToAppearance, getAppearance, getAppearance);
  return [appearance, setAppearance];
}
