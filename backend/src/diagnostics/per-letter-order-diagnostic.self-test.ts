/**
 * DEVELOPMENT ONLY. Tests for the per-letter order root-cause diagnostic
 * (per-letter-order-diagnostic.ts).
 *
 * A. extractLetterRouteWindowInputs at the current (pad=0.03) setting
 *    matches order-score-diagnostic.ts's already-proven extractLetterOrderInputs
 *    exactly (same letterRoute point count, same progress range).
 * B. evaluateShadowWindow at variant A_pad03_current reproduces the REAL
 *    production per-letter order exactly (parity through the real
 *    scoreOrderedPath, only the window construction is mirrored).
 * C. gap detection: a synthetic route with a deliberate detour produces a
 *    detectable gap in the selected original-index sequence.
 * D. traceDirectionConsistency's aggregate directionFit matches the real
 *    headingConsistency's output (via computeLetterOrderDecomposition parity).
 * E. composeShadowOrder arithmetic correctness.
 * F. pearsonCorrelation correctness on known cases.
 * G. read-only / production isolation.
 */
import type { Vec2 } from '@/lib/geometry';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { extractLetterOrderInputs, computeLetterOrderDecomposition } from './order-score-diagnostic';
import {
  extractLetterRouteWindowInputs,
  evaluateShadowWindow,
  traceDirectionConsistency,
  composeShadowOrder,
  pearsonCorrelation,
  WINDOW_VARIANTS,
} from './per-letter-order-diagnostic';

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

// --- A. parity: window-inputs point count matches order-score-diagnostic's own extraction ---
{
  const windowInputs = extractLetterRouteWindowInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const orderInputs = extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  let allMatch = true;
  const details: string[] = [];
  for (let i = 0; i < windowInputs.length; i += 1) {
    const w = windowInputs[i]!;
    const o = orderInputs[i]!;
    if (w.letterRoutePointCount !== o.letterRoute.length || w.targetStartProgress !== o.startProgress || w.targetEndProgress !== o.endProgress) {
      allMatch = false;
      details.push(`${w.letter}: w.count=${w.letterRoutePointCount} o.count=${o.letterRoute.length}`);
    }
  }
  tests.push({
    name: 'A. extractLetterRouteWindowInputs at default settings matches extractLetterOrderInputs exactly (point count, progress range)',
    passed: allMatch,
    detail: allMatch ? `all ${windowInputs.length} letters match` : details.join('; '),
  });
}

// --- B. evaluateShadowWindow at A_pad03_current reproduces the real production order exactly ---
{
  const identity = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const shadowResults = evaluateShadowWindow('ROBZ', robzShape.points, goodRoute, 'smooth', 'A_pad03_current');
  let allMatch = true;
  const details: string[] = [];
  for (let i = 0; i < shadowResults.length; i += 1) {
    const real = identity.letters[i]!;
    const shadow = shadowResults[i]!;
    if (Math.abs(real.order - shadow.order.order) > 1e-9) {
      allMatch = false;
      details.push(`${shadow.letter}: real.order=${real.order} shadow.order=${shadow.order.order}`);
    }
  }
  tests.push({
    name: 'B. evaluateShadowWindow(A_pad03_current) exactly reproduces the real per-letter order for every letter',
    passed: allMatch,
    detail: allMatch ? `all ${shadowResults.length} letters match exactly` : details.join('; '),
  });
  tests.push({
    name: 'B2. WINDOW_VARIANTS.A_pad03_current matches the real production window (progressPad=0.03, distanceMultiplier=2)',
    passed: WINDOW_VARIANTS.A_pad03_current.progressPad === 0.03 && WINDOW_VARIANTS.A_pad03_current.distanceMultiplier === 2,
    detail: JSON.stringify(WINDOW_VARIANTS.A_pad03_current),
  });
}

// --- C. gap detection ---
{
  // Build a route that traces R closely, then detours FAR away (outside the distance threshold) for a stretch while still within R's OWN progress range, then returns — this should create a gap in the selected original-index sequence.
  const rLetter = robzShape.letters[0]!;
  const rPoints = densify(rLetter.points, 8);
  const midpoint = Math.floor(rPoints.length / 2);
  const detourRoute: Vec2[] = rPoints.map((point, i) => {
    if (i > midpoint - 4 && i < midpoint + 4) {
      return { x: point.x + 5, y: point.y + 5 }; // far detour, well outside coverage threshold
    }
    return point;
  });
  const windowInputs = extractLetterRouteWindowInputs('ROBZ', robzShape.points, detourRoute, 'smooth');
  const rInput = windowInputs[0]!;
  tests.push({
    name: 'C. a route with a deliberate mid-letter detour (far from target) produces a detectable gap in the selected original-index sequence',
    passed: rInput.gapCount > 0,
    detail: `gapCount=${rInput.gapCount} maxGapSize=${rInput.maxGapSize} selectedPointCount=${rInput.letterRoutePointCount}`,
  });
}

// --- D. traceDirectionConsistency parity ---
{
  const orderInputs = extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const decompositions = orderInputs.map(computeLetterOrderDecomposition);
  let allMatch = true;
  const details: string[] = [];
  for (let i = 0; i < orderInputs.length; i += 1) {
    const input = orderInputs[i]!;
    const real = decompositions[i]!;
    if (input.letterRoute.length < 2) continue;
    const traced = traceDirectionConsistency(input.letterRoute, input.letterTarget, input.coverageThreshold);
    if (Math.abs(traced.directionFit - real.forward.directionFit) > 1e-9) {
      allMatch = false;
      details.push(`${input.letter}: traced=${traced.directionFit} real=${real.forward.directionFit}`);
    }
  }
  tests.push({
    name: 'D. traceDirectionConsistency aggregate directionFit exactly matches the real per-letter directionFit for every letter',
    passed: allMatch,
    detail: allMatch ? 'all letters match exactly' : details.join('; '),
  });
}

// --- E. composeShadowOrder arithmetic ---
{
  const real = { dtwFit: 0.6, dtwMeanDistanceMeters: 10, warpFit: 0.5, monotonicFit: 0.4, jumpFit: 0.3, revisitFit: 0.2, directionFit: 0.25, progressFit: 0.35, order: 0.5 * 0.6 + 0.3 * 0.35 + 0.2 * 0.25 };
  const actual = composeShadowOrder(real, 'A_actual');
  const perfectProgress = composeShadowOrder(real, 'B_perfectProgress');
  const perfectDirection = composeShadowOrder(real, 'C_perfectDirection');
  const perfectBoth = composeShadowOrder(real, 'D_perfectBoth');
  tests.push({
    name: 'E1. composeShadowOrder A_actual matches 0.5*dtwFit+0.3*progressFit+0.2*directionFit exactly',
    passed: Math.abs(actual - real.order) < 1e-9,
    detail: `actual=${actual} expected=${real.order}`,
  });
  tests.push({
    name: 'E2. composeShadowOrder B_perfectProgress = 0.5*dtwFit + 0.3*1 + 0.2*directionFit',
    passed: Math.abs(perfectProgress - (0.5 * real.dtwFit + 0.3 * 1 + 0.2 * real.directionFit)) < 1e-9,
    detail: `perfectProgress=${perfectProgress}`,
  });
  tests.push({
    name: 'E3. composeShadowOrder C_perfectDirection = 0.5*dtwFit + 0.3*progressFit + 0.2*1',
    passed: Math.abs(perfectDirection - (0.5 * real.dtwFit + 0.3 * real.progressFit + 0.2 * 1)) < 1e-9,
    detail: `perfectDirection=${perfectDirection}`,
  });
  tests.push({
    name: 'E4. composeShadowOrder D_perfectBoth = 0.5*dtwFit + 0.5 (0.3+0.2 at max)',
    passed: Math.abs(perfectBoth - (0.5 * real.dtwFit + 0.5)) < 1e-9,
    detail: `perfectBoth=${perfectBoth} expected=${0.5 * real.dtwFit + 0.5}`,
  });
}

// --- F. pearsonCorrelation ---
{
  const perfect = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  const inverse = pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  const none = pearsonCorrelation([1, 2, 3, 4, 5], [3, 3, 3, 3, 3]);
  tests.push({ name: 'F1. pearsonCorrelation of perfectly linearly related data is ~1', passed: Math.abs(perfect - 1) < 1e-9, detail: `r=${perfect}` });
  tests.push({ name: 'F2. pearsonCorrelation of perfectly inversely related data is ~-1', passed: Math.abs(inverse + 1) < 1e-9, detail: `r=${inverse}` });
  tests.push({ name: 'F3. pearsonCorrelation of constant y (zero variance) is 0 (guarded, not NaN)', passed: none === 0, detail: `r=${none}` });
}

// --- G. read-only / production isolation ---
{
  const targetSnapshot = JSON.stringify(robzShape.points);
  const routeSnapshot = JSON.stringify(goodRoute);
  extractLetterRouteWindowInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  evaluateShadowWindow('ROBZ', robzShape.points, goodRoute, 'smooth', 'E_pad05');
  tests.push({
    name: 'G1. read-only: target and route arrays are byte-identical before and after the diagnostic runs',
    passed: JSON.stringify(robzShape.points) === targetSnapshot && JSON.stringify(goodRoute) === routeSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  extractLetterRouteWindowInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const identityAfter = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'G2. production isolation: running the diagnostic does not change a subsequent real analyzeTargetIdentity() result',
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
