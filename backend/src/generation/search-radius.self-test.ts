/**
 * DEVELOPMENT ONLY. Search-radius scaling for experimental graph collection.
 */
import { NEIGHBORHOOD_COLLECT } from './graph-shape-router';
import {
  getPlacementRadiusForTargetDistance,
  getPlacementRingsForTargetDistance,
  getSearchRadiusForTargetDistance,
} from './search-radius';
import { STREET_FIT_SEARCH } from './street-fit-search';

type SelfTest = { name: string; passed: boolean; detail: string };

const CASES = [2000, 2500, 4000, 6000, 8000] as const;

function snapshot(target: number) {
  return {
    target,
    neighborhood: getSearchRadiusForTargetDistance(target),
    placement: getPlacementRadiusForTargetDistance(target),
    rings: getPlacementRingsForTargetDistance(target),
  };
}

const byTarget = Object.fromEntries(CASES.map((target) => [target, snapshot(target)])) as Record<
  (typeof CASES)[number],
  ReturnType<typeof snapshot>
>;

const tests: SelfTest[] = [
  {
    name: '2000 m keeps the proven 2400 / 800 floors',
    passed:
      byTarget[2000].neighborhood === NEIGHBORHOOD_COLLECT.radiusMeters &&
      byTarget[2000].placement === STREET_FIT_SEARCH.translationRadiusMeters &&
      byTarget[2000].rings.join(',') === STREET_FIT_SEARCH.translationRingsMeters.join(','),
    detail: `${byTarget[2000].neighborhood} / ${byTarget[2000].placement} rings=${byTarget[2000].rings.join(',')}`,
  },
  {
    name: '2500 m keeps the proven 2400 / 800 floors',
    passed:
      byTarget[2500].neighborhood === NEIGHBORHOOD_COLLECT.radiusMeters &&
      byTarget[2500].placement === STREET_FIT_SEARCH.translationRadiusMeters,
    detail: `${byTarget[2500].neighborhood} / ${byTarget[2500].placement}`,
  },
  {
    name: '4000 m is materially larger than 2500 m',
    passed:
      byTarget[4000].neighborhood === 3840 &&
      byTarget[4000].placement === 1280 &&
      byTarget[4000].neighborhood > byTarget[2500].neighborhood &&
      byTarget[4000].placement > byTarget[2500].placement,
    detail: `${byTarget[4000].neighborhood} / ${byTarget[4000].placement}`,
  },
  {
    name: '6000 m and 8000 m are capped at 2×',
    passed:
      byTarget[6000].neighborhood === 4800 &&
      byTarget[6000].placement === 1600 &&
      byTarget[8000].neighborhood === byTarget[6000].neighborhood &&
      byTarget[8000].placement === byTarget[6000].placement,
    detail: `6000=${byTarget[6000].neighborhood}/${byTarget[6000].placement} 8000=${byTarget[8000].neighborhood}/${byTarget[8000].placement}`,
  },
  {
    name: 'placement rings stay 0 / half / full',
    passed:
      byTarget[4000].rings.join(',') === '0,640,1280' &&
      byTarget[4000].rings[0] === 0 &&
      byTarget[4000].rings[2] === byTarget[4000].placement,
    detail: byTarget[4000].rings.join(','),
  },
  {
    name: 'placement and neighborhood share the same scale factor',
    passed: byTarget[4000].neighborhood / byTarget[2500].neighborhood === byTarget[4000].placement / byTarget[2500].placement,
    detail: `neighborhood×${byTarget[4000].neighborhood / byTarget[2500].neighborhood} placement×${byTarget[4000].placement / byTarget[2500].placement}`,
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
