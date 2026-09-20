/**
 * DEVELOPMENT ONLY one-shot: deeper feasibility pools for Alexandria vs Zamalek L.
 * Does not change generation.
 */
import { ZAMALEK_CONTROL } from './experimental-diagnostics';
import {
  evaluateFeasibilityPools,
  formatFeasibilityPoolReport,
} from './feasibility-pool-diagnostic';
import { snapSearchOrigin, searchOriginFromSnap } from './snap-search-origin';

const ALEXANDRIA_SEARCH_ORIGIN = { latitude: 31.227553, longitude: 29.949661 };

const zamalekSnap = await snapSearchOrigin(ZAMALEK_CONTROL);
const zamalekOrigin = searchOriginFromSnap(zamalekSnap);

console.log('DEVELOPMENT / feasibility-pool experiment');
console.log('Generator feasibilityTop is 96. Diagnostic still compares 32/64/96/128/256.');
console.log(
  `Zamalek snap ${zamalekSnap.snapped} ${zamalekOrigin.latitude}, ${zamalekOrigin.longitude} d=${zamalekSnap.snapDistanceMeters.toFixed(1)} m`,
);

const alexandria = await evaluateFeasibilityPools({
  name: 'Alexandria L 2000 snapped origin',
  word: 'L',
  searchOrigin: ALEXANDRIA_SEARCH_ORIGIN,
  targetDistanceMeters: 2000,
});
console.log(`\n######## ${alexandria.name} ########`);
console.log(formatFeasibilityPoolReport(alexandria));

const zamalek = await evaluateFeasibilityPools({
  name: 'Zamalek L 2000 street-locked origin',
  word: 'L',
  searchOrigin: zamalekOrigin,
  targetDistanceMeters: 2000,
});
console.log(`\n######## ${zamalek.name} ########`);
console.log(formatFeasibilityPoolReport(zamalek));

function productBeyond(report: typeof alexandria): number {
  return report.scoredFeasible.filter((item) => item.beyondCurrentPool && item.wouldPassProduct).length;
}

console.log('\n======== SUMMARY ========');
console.log(
  `Alexandria feasible 32/64/96/128/256 = ${alexandria.slices.map((item) => item.graphFeasible).join('/')}`,
);
console.log(
  `Zamalek feasible 32/64/96/128/256 = ${zamalek.slices.map((item) => item.graphFeasible).join('/')}`,
);
console.log(`Alexandria product-valid beyond rank ${alexandria.currentPool}: ${productBeyond(alexandria)}`);
console.log(`Zamalek product-valid beyond rank ${zamalek.currentPool}: ${productBeyond(zamalek)}`);
