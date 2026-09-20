import { useSyncExternalStore } from 'react';

import {
  ensureDistanceUnitHydrated,
  getDistanceUnit,
  setDistanceUnit,
  subscribeToDistanceUnit,
} from '@/lib/distance-unit-preference';
import type { DistanceUnit } from '@/lib/format';

/**
 * The persisted distance-unit preference, live everywhere it's read.
 * Backed by a shared external store (see distance-unit-preference.ts), so
 * calling the returned setter from any screen (e.g. Settings) updates every
 * other mounted consumer (e.g. Home, Results, Run) immediately, without
 * waiting for a navigation focus event.
 */
export function useDistanceUnit(): [DistanceUnit, (unit: DistanceUnit) => void] {
  ensureDistanceUnitHydrated();
  const unit = useSyncExternalStore(subscribeToDistanceUnit, getDistanceUnit, getDistanceUnit);
  return [unit, setDistanceUnit];
}
