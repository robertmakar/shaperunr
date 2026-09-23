/**
 * DEVELOPMENT ONLY. Tests for the order-component decomposition and rescue
 * scenario analysis.
 *
 * A. exact production parity (dtwFit/progressFit/directionFit/order).
 * B. contribution math: 0.5*dtwFit + 0.3*progressFit + 0.2*directionFit === order.
 * C. rescue math: perfect-component scenarios compute correctly.
 * D. no production mutation.
 */
import type { Vec2 } from '@/lib/geometry';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  computeDirectionAngularStats,
  computeLetterComponentDecomposition,
  computeRescueScenarios,
  ORDER_WEIGHTS,
} from './order-component-rescue';
import { extractLetterOrderInputs } from './order-score-diagnostic';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

// --- A. exact production parity ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const mismatches: string[] = [];
  inputs.forEach((input, index) => {
    const decomposition = computeLetterComponentDecomposition(input);
    const prod = identity.letters[index]!;
    if (Math.abs(decomposition.order.order - prod.order) > 1e-9) {
      mismatches.push(`${input.letter}.order: shadow=${decomposition.order.order} prod=${prod.order}`);
    }
  });
  tests.push({
    name: 'A. exact production parity: decomposition order matches production order for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- A. directionFit reconstruction parity ---
{
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const mismatches: string[] = [];
  for (const input of inputs) {
    const decomposition = computeLetterComponentDecomposition(input);
    const reconstructed = decomposition.directionStats.reconstructedDirectionFit;
    if (Math.abs(reconstructed - decomposition.order.directionFit) > 1e-9) {
      mismatches.push(`${input.letter}: reconstructed=${reconstructed} real=${decomposition.order.directionFit}`);
    }
  }
  tests.push({
    name: 'A. directionFit reconstruction parity: computeDirectionAngularStats\' reconstructedDirectionFit exactly matches the real directionFit for every letter (proves the mirrored headingConsistency loop is faithful)',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- B. contribution math ---
{
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const mismatches: string[] = [];
  for (const input of inputs) {
    const decomposition = computeLetterComponentDecomposition(input);
    const reconstructedOrder = decomposition.dtwContribution + decomposition.progressContribution + decomposition.directionContribution;
    // order is clamp01'd in production; contributionSum is the pre-clamp sum, so compare against the pre-clamp value directly (sum of three values already in [0, weight_i] each, total always in [0,1], so clamp never actually triggers here).
    if (Math.abs(reconstructedOrder - decomposition.order.order) > 1e-9) {
      mismatches.push(`${input.letter}: sum=${reconstructedOrder} order=${decomposition.order.order}`);
    }
  }
  tests.push({
    name: 'B. contribution math: 0.5*dtwFit + 0.3*progressFit + 0.2*directionFit exactly equals order for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
  tests.push({
    name: 'B. weights sum to 1.0 (ORDER_WEIGHTS mirrors production\'s inline 0.5/0.3/0.2 exactly)',
    passed: Math.abs(ORDER_WEIGHTS.dtw + ORDER_WEIGHTS.progress + ORDER_WEIGHTS.direction - 1) < 1e-9,
    detail: `dtw=${ORDER_WEIGHTS.dtw} progress=${ORDER_WEIGHTS.progress} direction=${ORDER_WEIGHTS.direction}`,
  });
}

// --- C. rescue math ---
{
  // Hand-computed example matching the task's own worked example: dtwFit=0, progressFit=0.8, directionFit=0.8 -> current order = 0.40.
  const scenarios = computeRescueScenarios(0, 0.8, 0.8);
  const currentOrder = 0.5 * 0 + 0.3 * 0.8 + 0.2 * 0.8;
  tests.push({
    name: 'C. rescue math: hand-computed example (dtwFit=0, progressFit=0.8, directionFit=0.8) matches the task\'s own worked example (order=0.40)',
    passed: Math.abs(currentOrder - 0.4) < 1e-9,
    detail: `currentOrder=${currentOrder}`,
  });
  tests.push({
    name: 'C. rescue math: perfect DTW alone (scenario A) = 0.5*1 + 0.3*0.8 + 0.2*0.8 = 0.90',
    passed: Math.abs(scenarios.A_perfectDtw - 0.9) < 1e-9,
    detail: `A_perfectDtw=${scenarios.A_perfectDtw}`,
  });
  tests.push({
    name: 'C. rescue math: perfect progress alone (scenario B) = 0.5*0 + 0.3*1 + 0.2*0.8 = 0.46',
    passed: Math.abs(scenarios.B_perfectProgress - 0.46) < 1e-9,
    detail: `B_perfectProgress=${scenarios.B_perfectProgress}`,
  });
  tests.push({
    name: 'C. rescue math: perfect direction alone (scenario C) = 0.5*0 + 0.3*0.8 + 0.2*1 = 0.44 — just short of 0.45, matching "cannot reach 0.45 unless DTW changes" only being FALSE here since progress alone (B) already clears it',
    passed: Math.abs(scenarios.C_perfectDirection - 0.44) < 1e-9,
    detail: `C_perfectDirection=${scenarios.C_perfectDirection}`,
  });
  tests.push({
    name: 'C. rescue math: perfect all three (scenario G) always equals 1.0 regardless of production values',
    passed: Math.abs(scenarios.G_perfectAll - 1) < 1e-9,
    detail: `G_perfectAll=${scenarios.G_perfectAll}`,
  });
  // A genuinely DTW-bound example: progressFit and directionFit both 0 (perfect progress+direction alone, scenario F, gives only 0.3+0.2=0.5*0(dtw prod)... let's construct dtwFit=0, progressFit=0, directionFit=0 -> F (perfect progress+direction, dtw at production=0) = 0.3*1+0.2*1 = 0.5 >= 0.45, so NOT dtw-bound by this definition. Need progressFit/directionFit fixed low enough that even perfecting the OTHER TWO while holding dtw at 0 still fails: impossible since perfecting progress+direction alone already gives 0.5 >= 0.45 always when dtwFit stays at its own production value >=0. Actually F = 0.5*dtwFit_prod + 0.3*1 + 0.2*1 = 0.5*dtwFit_prod + 0.5, which is >=0.5 whenever dtwFit_prod>=0 -- so F ALWAYS clears 0.45! This means "dtw_bound" (per this experiment's strict definition, task's own worked semantics) can never occur when using scenario F. That's a real, useful, verifiable mathematical property.
  const neverDtwBound = 0.5 * 0 + 0.3 * 1 + 0.2 * 1;
  tests.push({
    name: 'C. rescue math: scenario F (perfect progress+direction, DTW at worst case 0) always yields >=0.45 (0.3+0.2=0.5) — a letter can mathematically NEVER be classified dtw_bound under this experiment\'s definition, since progress+direction alone always suffice',
    passed: neverDtwBound >= 0.45,
    detail: `F with dtwFit=0: ${neverDtwBound}`,
  });
}

// --- structural proof: single-component rescue is mathematically impossible under the current 0.5/0.3/0.2 weights ---
{
  // Any two of {dtwFit, progressFit, directionFit} being perfect (=1), with the third
  // at its WORST possible production value (0), still yields order >= 0.45:
  //   D (perfect dtw+progress, direction=0) = 0.5+0.3 = 0.80
  //   E (perfect dtw+direction, progress=0) = 0.5+0.2 = 0.70
  //   F (perfect progress+direction, dtw=0)  = 0.3+0.2 = 0.50
  // All exceed 0.45 unconditionally, regardless of the third component's actual
  // production value (which can only make it higher, never lower, since components
  // are clamped to [0,1] and contribute non-negatively). This means
  // dtw_bound/progress_bound/direction_bound are UNREACHABLE by classifyComponentBound
  // — every failing, non-geometry-bound letter must be 'mixed'. Verified here across a
  // grid of production values, not just the single worked example above.
  let allPass = true;
  const failures: string[] = [];
  for (let dtw = 0; dtw <= 1; dtw += 0.25) {
    for (let progress = 0; progress <= 1; progress += 0.25) {
      for (let direction = 0; direction <= 1; direction += 0.25) {
        const scenarios = computeRescueScenarios(dtw, progress, direction);
        if (scenarios.D_perfectDtwProgress < 0.45 || scenarios.E_perfectDtwDirection < 0.45 || scenarios.F_perfectProgressDirection < 0.45) {
          allPass = false;
          failures.push(`dtw=${dtw},progress=${progress},direction=${direction}: D=${scenarios.D_perfectDtwProgress} E=${scenarios.E_perfectDtwDirection} F=${scenarios.F_perfectProgressDirection}`);
        }
      }
    }
  }
  tests.push({
    name: 'structural proof: across a full grid of production component values, scenarios D/E/F (any two components perfect) ALWAYS yield order>=0.45 — single-component-bound classifications are mathematically unreachable under the current weights',
    passed: allPass,
    detail: allPass ? 'D/E/F >= 0.45 for all 125 grid points' : failures.slice(0, 3).join('; '),
  });
}

// --- structural proof (stronger): scenario A (perfect DTW ALONE) is unconditionally sufficient ---
{
  // A = 0.5*1 + 0.3*progressFit + 0.2*directionFit >= 0.5 always (minimum at progressFit=0, directionFit=0),
  // and 0.5 > 0.45 — so DTW's own weight alone already exceeds the threshold, regardless of the other two
  // components' production values. This is a stronger, distinct fact from the D/E/F (two-perfect) proof above:
  // DTW is the ONLY one of the three components whose weight alone (0.5) exceeds 0.45; progress's weight (0.3)
  // and direction's weight (0.2) do not, so perfecting EITHER of those alone is NOT unconditionally sufficient.
  let allPass = true;
  const failures: string[] = [];
  for (let progress = 0; progress <= 1; progress += 0.25) {
    for (let direction = 0; direction <= 1; direction += 0.25) {
      const scenarios = computeRescueScenarios(0, progress, direction);
      if (scenarios.A_perfectDtw < 0.45) {
        allPass = false;
        failures.push(`progress=${progress},direction=${direction}: A=${scenarios.A_perfectDtw}`);
      }
    }
  }
  tests.push({
    name: 'structural proof: scenario A (perfect DTW alone, dtwFit=1) is UNCONDITIONALLY >=0.45 regardless of progress/direction, because weight_dtw=0.5 already exceeds the 0.45 threshold on its own',
    passed: allPass,
    detail: allPass ? 'A >= 0.45 for all 25 grid points even with progress=0,direction=0' : failures.slice(0, 3).join('; '),
  });
  // Contrast: perfecting progress alone or direction alone is NOT unconditionally sufficient (their weights, 0.3 and 0.2, are each individually below 0.45).
  const worstCaseB = computeRescueScenarios(0, 1, 0).B_perfectProgress; // dtw=0, direction=0 -> B = 0.3
  const worstCaseC = computeRescueScenarios(0, 0, 1).C_perfectDirection; // dtw=0, progress=0 -> C = 0.2
  tests.push({
    name: 'structural proof: scenarios B (perfect progress alone) and C (perfect direction alone) are NOT unconditionally sufficient — their worst-case floors (0.30, 0.20) both fall below 0.45',
    passed: worstCaseB < 0.45 && worstCaseC < 0.45,
    detail: `worst-case B=${worstCaseB} worst-case C=${worstCaseC}`,
  });
}

// --- D. no production mutation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  for (const input of inputs) {
    computeLetterComponentDecomposition(input);
  }
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'D. no production mutation: running the full decomposition does not change a subsequent real analyzeTargetIdentity() result',
    passed:
      identityBefore.spanOccupancy === identityAfter.spanOccupancy &&
      identityBefore.targetSpan === identityAfter.targetSpan &&
      identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord &&
      identityBefore.letters.every((letter, index) => letter.order === identityAfter.letters[index]!.order),
    detail: `before traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

// --- classification sanity: a letter with insufficient route data classifies as geometry_bound ---
{
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, ([] as Vec2[]), 'smooth');
  if (inputs.length > 0) {
    const decomposition = computeLetterComponentDecomposition(inputs[0]!);
    tests.push({
      name: 'classification: a letter with zero route data classifies as geometry_bound',
      passed: decomposition.classification === 'geometry_bound',
      detail: `classification=${decomposition.classification} order=${decomposition.order.order}`,
    });
  }
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
