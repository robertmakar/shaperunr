import {
  APPEARANCES,
  DEFAULT_APPEARANCE,
  appearanceName,
  getAppearance,
  setAppearance,
  subscribeToAppearance,
} from './appearance-preference';
import { getAutoPauseSetting } from './auto-pause-preference';
import { getDistanceUnit } from './distance-unit-preference';
import { getPaceUnit } from './pace-unit-preference';

type SelfTest = { name: string; passed: boolean; detail: string };

/**
 * Exercises the in-memory contract of the Appearance store directly (same
 * approach as the other preference stores would use, were they tested):
 * AsyncStorage itself is a native module and isn't available outside the
 * app, but `setPreference`/`getPreference` swallow that failure by design
 * (see preferences-storage.ts), so the synchronous get/set/notify contract
 * these tests check runs identically with or without a real device.
 */
export function runAppearanceSelfTests(): SelfTest[] {
  const tests: SelfTest[] = [];
  const startingValue = getAppearance();

  tests.push({
    name: 'DEFAULT_APPEARANCE is system',
    passed: DEFAULT_APPEARANCE === 'system',
    detail: `default=${DEFAULT_APPEARANCE}`,
  });

  tests.push({
    name: 'APPEARANCES lists all three options',
    passed:
      APPEARANCES.length === 3 &&
      APPEARANCES.includes('system') &&
      APPEARANCES.includes('light') &&
      APPEARANCES.includes('dark'),
    detail: APPEARANCES.join(', '),
  });

  tests.push({
    name: 'appearanceName gives clean labels',
    passed:
      appearanceName('system') === 'System' &&
      appearanceName('light') === 'Light' &&
      appearanceName('dark') === 'Dark',
    detail: `${appearanceName('system')}/${appearanceName('light')}/${appearanceName('dark')}`,
  });

  setAppearance('light');
  tests.push({
    name: 'setAppearance(light) persists in-memory',
    passed: getAppearance() === 'light',
    detail: `getAppearance()=${getAppearance()}`,
  });

  setAppearance('dark');
  tests.push({
    name: 'setAppearance(dark) persists in-memory',
    passed: getAppearance() === 'dark',
    detail: `getAppearance()=${getAppearance()}`,
  });

  setAppearance('system');
  tests.push({
    name: 'setAppearance(system) persists in-memory',
    passed: getAppearance() === 'system',
    detail: `getAppearance()=${getAppearance()}`,
  });

  let notified = 0;
  const unsubscribe = subscribeToAppearance(() => {
    notified += 1;
  });
  setAppearance('dark');
  setAppearance('dark'); // no-op: same value must not notify again
  unsubscribe();
  tests.push({
    name: 'subscribeToAppearance notifies once per actual change',
    passed: notified === 1,
    detail: `notified=${notified}`,
  });

  const distanceBefore = getDistanceUnit();
  const paceBefore = getPaceUnit();
  const autoPauseBefore = getAutoPauseSetting();
  setAppearance(getAppearance() === 'light' ? 'dark' : 'light');
  tests.push({
    name: 'Appearance is independent from Distance/Pace/Auto-pause',
    passed:
      getDistanceUnit() === distanceBefore &&
      getPaceUnit() === paceBefore &&
      getAutoPauseSetting() === autoPauseBefore,
    detail: `distance=${getDistanceUnit()} pace=${getPaceUnit()} autoPause=${getAutoPauseSetting()}`,
  });

  setAppearance(startingValue);

  return tests;
}
