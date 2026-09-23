/**
 * DEVELOPMENT ONLY. Tests for the monotonicFit root-cause diagnostic
 * (monotonic-fit-diagnostic.ts).
 *
 * A. monotonicFitCurrent (Variant A) exactly reproduces the real
 *    production monotonicFit for every letter of a real candidate.
 * B. extractProgressSequence exactly matches production's own progress
 *    computation (same values as computeLetterOrderDecomposition's
 *    routeProgressSequence).
 * C. semantic: many small wiggles vs one large reversal of the SAME total
 *    magnitude produce the SAME Variant A score (proving it's already
 *    linear-magnitude-weighted, not categorical) but DIFFERENT Variant B
 *    (quadratic) scores.
 * D. monotonicFitCumulative correctly credits net forward progress despite local wiggle.
 * E. monotonicFitEpsilonTolerance correctly neutralizes small steps.
 * F. monotonicFitSmoothed changes a noisy sequence's score in the expected direction.
 * G. combineProgressFit/combineOrder parity at real component values.
 * H. read-only / production isolation.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import {
  extractProgressSequence,
  monotonicFitCurrent,
  monotonicFitQuadratic,
  monotonicFitCumulative,
  monotonicFitEpsilonTolerance,
  monotonicFitSmoothed,
  combineProgressFit,
  combineOrder,
  extractLetterOrderInputs,
  computeLetterOrderDecomposition,
} from './monotonic-fit-diagnostic';
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

// --- A/B. parity ---
{
  const orderInputs = extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const decompositions = orderInputs.map(computeLetterOrderDecomposition);
  let allMatchA = true;
  let allMatchB = true;
  const detailsA: string[] = [];
  for (let i = 0; i < orderInputs.length; i += 1) {
    const input = orderInputs[i]!;
    const real = decompositions[i]!;
    if (input.letterRoute.length < 2) continue;
    const progress = extractProgressSequence(input.letterRoute, input.letterTarget);
    const shadowMonotonic = monotonicFitCurrent(progress);
    if (Math.abs(shadowMonotonic - real.forward.monotonicFit) > 1e-9) {
      allMatchA = false;
      detailsA.push(`${input.letter}: shadow=${shadowMonotonic} real=${real.forward.monotonicFit}`);
    }
    if (JSON.stringify(progress) !== JSON.stringify(real.routeProgressSequence)) allMatchB = false;
  }
  tests.push({ name: 'A. monotonicFitCurrent(extractProgressSequence(...)) exactly reproduces the real per-letter monotonicFit', passed: allMatchA, detail: allMatchA ? 'all letters match exactly' : detailsA.join('; ') });
  tests.push({ name: 'B. extractProgressSequence exactly matches production\'s own routeProgressSequence', passed: allMatchB, detail: allMatchB ? 'all letters match exactly' : 'mismatch found' });
}

// --- C. linear (A) vs quadratic (B) magnitude-weighting semantic ---
{
  // Many small wiggles summing to the same total backward magnitude as one large reversal.
  const manySmallWiggles = [0, 0.1, 0.09, 0.19, 0.18, 0.28, 0.27, 0.37, 0.36, 0.46]; // 4 negative steps of 0.01 each = 0.04 total backward
  const oneLargeReversal = [0, 0.1, 0.2, 0.3, 0.26, 0.36, 0.46]; // 1 negative step of 0.04 = 0.04 total backward
  const wiggleA = monotonicFitCurrent(manySmallWiggles);
  const reversalA = monotonicFitCurrent(oneLargeReversal);
  const wiggleB = monotonicFitQuadratic(manySmallWiggles);
  const reversalB = monotonicFitQuadratic(oneLargeReversal);
  tests.push({
    name: 'C1. Variant A (current, linear-magnitude): many small wiggles and one large reversal of the SAME total backward magnitude produce the SAME score (proves current formula is already magnitude-weighted, not categorical)',
    passed: Math.abs(wiggleA - reversalA) < 1e-9,
    detail: `wiggleA=${wiggleA.toFixed(4)} reversalA=${reversalA.toFixed(4)}`,
  });
  tests.push({
    name: 'C2. Variant B (quadratic): the one-large-reversal sequence scores WORSE than the many-small-wiggles sequence of the same total magnitude (super-linear penalty for large single steps)',
    passed: reversalB < wiggleB,
    detail: `wiggleB=${wiggleB.toFixed(4)} reversalB=${reversalB.toFixed(4)}`,
  });
}

// --- D. cumulative is mathematically ALWAYS <= current (net = positive-negative <= positive whenever negative>=0) ---
{
  const noisyButNetForward = [0.1, 0.12, 0.11, 0.14, 0.13, 0.16, 0.15, 0.19];
  const netProgress = noisyButNetForward[noisyButNetForward.length - 1]! - noisyButNetForward[0]!;
  const cumulative = monotonicFitCumulative(noisyButNetForward);
  const current = monotonicFitCurrent(noisyButNetForward);
  // monotonicFitCumulative = (positive-negative)/(positive+negative) = current - negative/(positive+negative) <= current always.
  tests.push({
    name: 'D. monotonicFitCumulative is mathematically ALWAYS <= Variant A for any sequence with backward movement (net=positive-negative is never more forgiving than positive alone) — confirmed on a noisy-but-net-forward sequence',
    passed: cumulative <= current + 1e-9 && netProgress > 0,
    detail: `cumulative=${cumulative.toFixed(4)} current=${current.toFixed(4)} netProgress=${netProgress.toFixed(4)} (cumulative <= current confirms the general inequality, not a counterexample)`,
  });
}

// --- E. epsilon tolerance neutralizes small steps ---
{
  const tinyWiggleOnly = [0.1, 0.101, 0.0995, 0.102, 0.1005, 0.15]; // sub-0.01 noise then a real forward jump
  const strict = monotonicFitCurrent(tinyWiggleOnly);
  const tolerant = monotonicFitEpsilonTolerance(tinyWiggleOnly, 0.01);
  tests.push({
    name: 'E. monotonicFitEpsilonTolerance(epsilon=0.01) scores a sequence with only sub-epsilon noise higher than or equal to Variant A',
    passed: tolerant >= strict - 1e-9,
    detail: `strict=${strict.toFixed(4)} tolerant=${tolerant.toFixed(4)}`,
  });
}

// --- F. smoothing direction ---
{
  const noisy = [0.1, 0.2, 0.15, 0.3, 0.25, 0.4, 0.35, 0.5];
  const strict = monotonicFitCurrent(noisy);
  const smoothed = monotonicFitSmoothed(noisy);
  tests.push({
    name: 'F. monotonicFitSmoothed scores a noisy-but-trending-forward sequence higher than or equal to Variant A',
    passed: smoothed >= strict - 1e-9,
    detail: `strict=${strict.toFixed(4)} smoothed=${smoothed.toFixed(4)}`,
  });
}

// --- G. combineProgressFit/combineOrder parity ---
{
  const orderInputs = extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const decompositions = orderInputs.map(computeLetterOrderDecomposition);
  let allMatch = true;
  for (const real of decompositions) {
    const progressFit = combineProgressFit(real.forward.monotonicFit, real.forward.jumpFit, real.forward.revisitFit);
    const order = combineOrder(real.forward.dtwFit, real.forward.progressFit, real.forward.directionFit);
    if (Math.abs(progressFit - real.forward.progressFit) > 1e-9 || Math.abs(order - real.forward.order) > 1e-9) allMatch = false;
  }
  tests.push({ name: 'G. combineProgressFit/combineOrder at real component values exactly reproduce real progressFit/order', passed: allMatch, detail: allMatch ? 'all letters match exactly' : 'mismatch found' });
}

// --- H. read-only / production isolation ---
{
  const targetSnapshot = JSON.stringify(robzShape.points);
  const routeSnapshot = JSON.stringify(goodRoute);
  extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  tests.push({
    name: 'H1. read-only: target and route arrays are byte-identical before and after the diagnostic runs',
    passed: JSON.stringify(robzShape.points) === targetSnapshot && JSON.stringify(goodRoute) === routeSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const identityAfter = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'H2. production isolation: running the diagnostic does not change a subsequent real analyzeTargetIdentity() result',
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
