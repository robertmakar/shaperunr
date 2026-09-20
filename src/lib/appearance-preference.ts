import { getPreference, setPreference } from '@/lib/preferences-storage';

export type Appearance = 'system' | 'light' | 'dark';

export const APPEARANCES: Appearance[] = ['system', 'light', 'dark'];
export const DEFAULT_APPEARANCE: Appearance = 'system';

const PREFERENCE_KEY = 'appearance';

export function appearanceName(appearance: Appearance): string {
  switch (appearance) {
    case 'light':
      return 'Light';
    case 'dark':
      return 'Dark';
    default:
      return 'System';
  }
}

function parseAppearance(value: string | null): Appearance {
  return value === 'light' || value === 'dark' ? value : DEFAULT_APPEARANCE;
}

/**
 * Same reactive-store shape as distance-unit-preference.ts and the other
 * preference stores: in-memory first (defaulting to 'system'), hydrated
 * from AsyncStorage once, shared by every consumer so a change in Settings
 * reaches every mounted screen immediately. A wholly separate store/key
 * from Distance, Pace, and Auto-pause — changing Appearance must never
 * touch them, and vice versa.
 */
let currentAppearance: Appearance = DEFAULT_APPEARANCE;
let hydrationStarted = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function ensureAppearanceHydrated(): void {
  if (hydrationStarted) {
    return;
  }
  hydrationStarted = true;
  void getPreference(PREFERENCE_KEY).then((stored) => {
    const parsed = parseAppearance(stored);
    if (parsed !== currentAppearance) {
      currentAppearance = parsed;
      notify();
    }
  });
}

export function getAppearance(): Appearance {
  return currentAppearance;
}

export function setAppearance(appearance: Appearance): void {
  if (appearance === currentAppearance) {
    return;
  }
  currentAppearance = appearance;
  notify();
  void setPreference(PREFERENCE_KEY, appearance);
}

export function subscribeToAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
