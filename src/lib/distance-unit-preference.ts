import { DEFAULT_DISTANCE_UNIT, type DistanceUnit } from '@/lib/format';
import { getPreference, setPreference } from '@/lib/preferences-storage';

const PREFERENCE_KEY = 'distanceUnit';

function parseDistanceUnit(value: string | null): DistanceUnit {
  return value === 'mi' ? 'mi' : DEFAULT_DISTANCE_UNIT;
}

/**
 * A tiny in-memory store, reactive via `subscribeToDistanceUnit`, hydrated
 * from AsyncStorage once on first use. In-memory first (defaulting to
 * `DEFAULT_DISTANCE_UNIT`) so every consumer renders synchronously without
 * waiting on the async read, then corrects itself the moment hydration
 * resolves if the stored value differs. Every consumer (Home, Settings,
 * Results, Run) shares this one instance, so changing the unit anywhere
 * updates every mounted screen immediately, not just the one that changed it.
 */
let currentUnit: DistanceUnit = DEFAULT_DISTANCE_UNIT;
let hydrationStarted = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function ensureDistanceUnitHydrated(): void {
  if (hydrationStarted) {
    return;
  }
  hydrationStarted = true;
  void getPreference(PREFERENCE_KEY).then((stored) => {
    const parsed = parseDistanceUnit(stored);
    if (parsed !== currentUnit) {
      currentUnit = parsed;
      notify();
    }
  });
}

export function getDistanceUnit(): DistanceUnit {
  return currentUnit;
}

export function setDistanceUnit(unit: DistanceUnit): void {
  if (unit === currentUnit) {
    return;
  }
  currentUnit = unit;
  notify();
  void setPreference(PREFERENCE_KEY, unit);
}

export function subscribeToDistanceUnit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
