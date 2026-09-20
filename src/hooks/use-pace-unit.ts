import { useSyncExternalStore } from 'react';

import type { DistanceUnit } from '@/lib/format';
import {
  ensurePaceUnitHydrated,
  getPaceUnit,
  setPaceUnit,
  subscribeToPaceUnit,
} from '@/lib/pace-unit-preference';

/** The persisted pace-unit preference, live everywhere it's read — same shared-store pattern as useDistanceUnit and useAutoPause, but an independent preference/key. */
export function usePaceUnit(): [DistanceUnit, (unit: DistanceUnit) => void] {
  ensurePaceUnitHydrated();
  const unit = useSyncExternalStore(subscribeToPaceUnit, getPaceUnit, getPaceUnit);
  return [unit, setPaceUnit];
}
