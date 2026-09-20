import { getPreference, setPreference } from '@/lib/preferences-storage';

export type AutoPauseSetting = 'off' | 'on';

export const AUTO_PAUSE_SETTINGS: AutoPauseSetting[] = ['off', 'on'];
export const DEFAULT_AUTO_PAUSE_SETTING: AutoPauseSetting = 'off';

const PREFERENCE_KEY = 'autoPause';

export function autoPauseSettingName(setting: AutoPauseSetting): string {
  return setting === 'on' ? 'On' : 'Off';
}

function parseAutoPauseSetting(value: string | null): AutoPauseSetting {
  return value === 'on' ? 'on' : DEFAULT_AUTO_PAUSE_SETTING;
}

/**
 * Same reactive-store shape as distance-unit-preference.ts: in-memory
 * first (defaulting OFF, so an in-progress run never silently gains
 * automatic pausing before storage resolves), hydrated from AsyncStorage
 * once, shared by every consumer. Run reads this via the plain getter
 * (not the React hook) inside its AppState listener, so a change made in
 * Settings takes effect for an in-progress run immediately, without any
 * focus/polling logic.
 */
let currentSetting: AutoPauseSetting = DEFAULT_AUTO_PAUSE_SETTING;
let hydrationStarted = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function ensureAutoPauseHydrated(): void {
  if (hydrationStarted) {
    return;
  }
  hydrationStarted = true;
  void getPreference(PREFERENCE_KEY).then((stored) => {
    const parsed = parseAutoPauseSetting(stored);
    if (parsed !== currentSetting) {
      currentSetting = parsed;
      notify();
    }
  });
}

export function getAutoPauseSetting(): AutoPauseSetting {
  return currentSetting;
}

export function setAutoPauseSetting(setting: AutoPauseSetting): void {
  if (setting === currentSetting) {
    return;
  }
  currentSetting = setting;
  notify();
  void setPreference(PREFERENCE_KEY, setting);
}

export function subscribeToAutoPauseSetting(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
