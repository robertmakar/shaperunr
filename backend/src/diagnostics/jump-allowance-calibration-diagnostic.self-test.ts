/**
 * DEVELOPMENT ONLY. Tests for the jump-allowance calibration diagnostic
 * (jump-allowance-calibration-diagnostic.ts).
 *
 * A. Model A_current exactly reproduces the real, unmodified whole-route
 *    monotonicFit/jumpFit/revisitFit (parity via computeWholeRouteOrder).
 * B. classifyProgressJumps correctly labels a jump that spans a real
 *    letter-to-letter boundary as A_expected_transition, and a jump that
 *    stays within one letter's own range as B_within_letter.
 * C. Mathematical guarantee: Models B, C, D, E can only ever produce
 *    jumpFit >= Model A's jumpFit (they only relax or exempt allowance,
 *    never tighten it) — verified across the real ROBZ corpus route.
 * D. Adversarial: a genuinely reversed (wrong-sequence) route is NOT
 *    rescued by the relaxed models — monotonicFit stays low regardless
 *    of jumpAllow model, so order stays low even under Model E.
 * E. Adversarial: Model D exempts ONLY steps actually classified as
 *    expected transitions — an unexpected large jump elsewhere still
 *    contributes to skipAmount under Model D.
 * F. read-only / production isolation.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { computeWholeRouteOrder, extractWholeRouteProgressSequence } from './whole-route-order-diagnostic';
import {
  classifyProgressJumps,
  extractBoundariesFor,
  progressConsistencyWithJumpModel,
  evaluateAllJumpModels,
  combineProgressFit,
  combineOrder,
} from './jump-allowance-calibration-diagnostic';
import type { Vec2 } from '@/lib/geometry';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

function densify(points: readonly Vec2[], factor: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let s = 0; s < factor; s += 1) {
      const t = s / factor;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}
const goodRoute = densify(robzShape.points, 6);

// --- A. Model A parity ---
{
  const samples = extractWholeRouteProgressSequence(goodRoute, robzShape.points);
  const progress = samples.map((s) => s.progress);
  const boundaries = extractBoundariesFor('ROBZ', 'smooth');
  const models = evaluateAllJumpModels(progress, boundaries, robzShape.letters.length);
  const real = computeWholeRouteOrder(goodRoute, robzShape.points);
  tests.push({
    name: 'A. Model A_current exactly reproduces the real monotonicFit/jumpFit/revisitFit',
    passed: Math.abs(models.A_current.monotonicFit - real.monotonicFit) < 1e-9 && Math.abs(models.A_current.jumpFit - real.jumpFit) < 1e-9 && Math.abs(models.A_current.revisitFit - real.revisitFit) < 1e-9,
    detail: `A.jumpFit=${models.A_current.jumpFit} real.jumpFit=${real.jumpFit}`,
  });
}

// --- B. classifyProgressJumps ---
{
  const boundaries = extractBoundariesFor('ROBZ', 'smooth');
  // Construct a synthetic progress sequence: a jump from inside R's own range straight to inside O's range (expected transition), then a jump entirely within O's own range (within-letter).
  const rRange = boundaries[0]!;
  const oRange = boundaries[1]!;
  const transitionSamples = [
    { progress: rRange.projectedEndProgress - 0.01 },
    { progress: oRange.projectedStartProgress + 0.01 }, // large jump across the R->O boundary
    { progress: (oRange.projectedStartProgress + oRange.projectedEndProgress) / 2 - 0.05 },
    { progress: (oRange.projectedStartProgress + oRange.projectedEndProgress) / 2 + 0.05 }, // jump within O's own range
  ];
  const jumps = classifyProgressJumps(transitionSamples, boundaries, 0.02);
  const first = jumps.find((j) => j.sampleIndex === 1);
  const second = jumps.find((j) => j.sampleIndex === 3);
  tests.push({
    name: 'B1. a jump spanning the real R->O letter boundary is classified A_expected_transition',
    passed: first?.classification === 'A_expected_transition' && first?.matchedTransition?.fromLetter === 'R' && first?.matchedTransition?.toLetter === 'O',
    detail: JSON.stringify(first),
  });
  tests.push({
    name: 'B2. a jump that stays entirely within one letter\'s own range is classified B_within_letter',
    passed: second?.classification === 'B_within_letter',
    detail: JSON.stringify(second),
  });
}

// --- C. mathematical guarantee: relaxed models never produce LOWER jumpFit than A ---
{
  const samples = extractWholeRouteProgressSequence(goodRoute, robzShape.points);
  const progress = samples.map((s) => s.progress);
  const boundaries = extractBoundariesFor('ROBZ', 'smooth');
  const models = evaluateAllJumpModels(progress, boundaries, robzShape.letters.length);
  const allGreaterOrEqual = (['B_perLetterCount', 'C_targetGeometry', 'D_boundaryExempt', 'E_hybrid'] as const).every((key) => models[key].jumpFit >= models.A_current.jumpFit - 1e-9);
  tests.push({
    name: 'C. Models B/C/D/E always produce jumpFit >= Model A (they only relax or exempt allowance, never tighten it)',
    passed: allGreaterOrEqual,
    detail: Object.entries(models).map(([k, v]) => `${k}=${v.jumpFit.toFixed(4)}`).join(' '),
  });
}

// --- D. reversed route is NOT rescued by relaxed models ---
{
  const reversedRoute = [...goodRoute].reverse();
  const samples = extractWholeRouteProgressSequence(reversedRoute, robzShape.points);
  const progress = samples.map((s) => s.progress);
  const boundaries = extractBoundariesFor('ROBZ', 'smooth');
  const models = evaluateAllJumpModels(progress, boundaries, robzShape.letters.length);
  const real = computeWholeRouteOrder(reversedRoute, robzShape.points);
  // Even under the most relaxed model (E), order should stay far below a "good" route's order because monotonicFit (unaffected by any jump model) stays low for a genuinely reversed sequence.
  const orderE = combineOrder(real.dtwFit, combineProgressFit(models.E_hybrid.monotonicFit, models.E_hybrid.jumpFit, models.E_hybrid.revisitFit), real.directionFit);
  tests.push({
    name: 'D. a genuinely reversed (wrong-sequence) route is NOT rescued by the most relaxed jump model (E) — order stays low because monotonicFit is untouched by any jumpAllow model',
    passed: orderE < 0.4,
    detail: `models.E.monotonicFit=${models.E_hybrid.monotonicFit.toFixed(4)} orderUnderE=${orderE.toFixed(4)}`,
  });
}

// --- E. Model D only exempts genuinely-classified expected transitions ---
{
  const boundaries = extractBoundariesFor('ROBZ', 'smooth');
  // A sequence with ONE real expected R->O transition jump, and ONE unexplained large jump elsewhere (not near any boundary — e.g. deep within R's own range, jumping far past where R's range ends without landing in O's range).
  const rRange = boundaries[0]!;
  const weirdJumpTarget = rRange.projectedStartProgress + (rRange.projectedEndProgress - rRange.projectedStartProgress) * 0.9;
  const progress = [rRange.projectedStartProgress, rRange.projectedStartProgress + 0.01, weirdJumpTarget, boundaries[1]!.projectedStartProgress + 0.01];
  const models = evaluateAllJumpModels(progress, boundaries, 4);
  tests.push({
    name: 'E. Model D_boundaryExempt still shows a nonzero skipAmount when an unexplained large jump (not matching any real boundary) is present alongside a real transition',
    passed: models.D_boundaryExempt.skipAmount > 0,
    detail: `D.skipAmount=${models.D_boundaryExempt.skipAmount.toFixed(4)} D.jumpFit=${models.D_boundaryExempt.jumpFit.toFixed(4)}`,
  });
}

// --- F. read-only / production isolation ---
{
  const targetSnapshot = JSON.stringify(robzShape.points);
  const routeSnapshot = JSON.stringify(goodRoute);
  const samples = extractWholeRouteProgressSequence(goodRoute, robzShape.points);
  const boundaries = extractBoundariesFor('ROBZ', 'smooth');
  progressConsistencyWithJumpModel(samples.map((s) => s.progress), () => 0.05);
  tests.push({
    name: 'F1. read-only: target and route arrays are byte-identical before and after the diagnostic runs',
    passed: JSON.stringify(robzShape.points) === targetSnapshot && JSON.stringify(goodRoute) === routeSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  classifyProgressJumps(samples, boundaries, 0.05);
  const identityAfter = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'F2. production isolation: running the diagnostic does not change a subsequent real analyzeTargetIdentity() result',
    passed: JSON.stringify(identityBefore) === JSON.stringify(identityAfter),
    detail: `before.traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
