import { DEFAULT_DISTANCE_UNIT, type DistanceUnit } from '@/lib/format';
import { getPreference, setPreference } from '@/lib/preferences-storage';

const PREFERENCE_KEY = 'paceUnit';

function parsePaceUnit(value: string | null): DistanceUnit {
  return value === 'mi' ? 'mi' : DEFAULT_DISTANCE_UNIT;
}

/**
 * Same reactive-store shape as distance-unit-preference.ts and
 * auto-pause-preference.ts, but a wholly separate store/key — pace unit
 * and distance unit share the same 'km' | 'mi' type (see format.ts) but
 * are independently selectable, so changing one must never change the
 * other. In-memory first (default 'km'), hydrated from AsyncStorage once,
 * shared by every consumer so a change in Settings reaches an in-progress
 * Run screen immediately.
 */
let currentUnit: DistanceUnit = DEFAULT_DISTANCE_UNIT;
let hydrationStarted = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function ensurePaceUnitHydrated(): void {
  if (hydrationStarted) {
    return;
  }
  hydrationStarted = true;
  void getPreference(PREFERENCE_KEY).then((stored) => {
    const parsed = parsePaceUnit(stored);
    if (parsed !== currentUnit) {
      currentUnit = parsed;
      notify();
    }
  });
}

export function getPaceUnit(): DistanceUnit {
  return currentUnit;
}

export function setPaceUnit(unit: DistanceUnit): void {
  if (unit === currentUnit) {
    return;
  }
  currentUnit = unit;
  notify();
  void setPreference(PREFERENCE_KEY, unit);
}

export function subscribeToPaceUnit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
