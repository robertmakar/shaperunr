/**
 * DEVELOPMENT ONLY. Tests for the shadow direction-tolerance evaluator.
 *
 * A. production parity at cutoff=1x, angle=90 degrees.
 * B. far-cutoff monotonicity: increasing the cutoff never decreases directionFit.
 * C. angular monotonicity: increasing the angle scale never decreases directionFit.
 * D. contribution math: 0.5*dtwFit + 0.3*progressFit + 0.2*directionFit === order.
 * E. no production mutation.
 */
import type { Vec2 } from '@/lib/geometry';
import { scoreOrderedPath } from '@/lib/shape-order';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  ANGLE_SCALES_DEGREES,
  computeDirectionSegmentStats,
  computeDirectionShadowOrder,
  computeShadowDirectionFit,
  FAR_CUTOFF_MULTIPLIERS,
} from './direction-tolerance-diagnostic';
import { extractLetterOrderInputs } from './order-score-diagnostic';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

// --- A. production parity at cutoff=1x, angle=90deg ---
{
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const mismatches: string[] = [];
  for (const input of inputs) {
    const real = scoreOrderedPath(input.letterRoute, input.sampledTarget, input.letterTarget, {
      orderDistanceScale: input.orderDistanceScale,
      coverageThreshold: input.coverageThreshold,
    });
    const shadow = computeShadowDirectionFit(input.letterRoute, input.letterTarget, input.coverageThreshold, 1, 90);
    if (Math.abs(shadow - real.directionFit) > 1e-9) {
      mismatches.push(`${input.letter}: shadow=${shadow} real=${real.directionFit}`);
    }
  }
  tests.push({
    name: 'A. production parity: shadow directionFit at cutoff=1x, angle=90deg exactly matches real production directionFit',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- A. production parity: computeDirectionShadowOrder at 1x/90deg matches real order exactly ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const mismatches: string[] = [];
  inputs.forEach((input, index) => {
    const real = scoreOrderedPath(input.letterRoute, input.sampledTarget, input.letterTarget, {
      orderDistanceScale: input.orderDistanceScale,
      coverageThreshold: input.coverageThreshold,
    });
    const shadowOrder = computeDirectionShadowOrder(input.letterRoute, input.letterTarget, input.coverageThreshold, real.dtwFit, real.progressFit, 1, 90);
    if (Math.abs(shadowOrder.shadowOrder - identity.letters[index]!.order) > 1e-9) {
      mismatches.push(`${input.letter}: shadow=${shadowOrder.shadowOrder} prod=${identity.letters[index]!.order}`);
    }
  });
  tests.push({
    name: 'A. production parity: computeDirectionShadowOrder at cutoff=1x, angle=90deg exactly matches production order',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- B. far-cutoff monotonicity ---
function assertCutoffMonotonic(word: string, route: readonly Vec2[], target: readonly Vec2[]) {
  const inputs = extractLetterOrderInputs(word, target, route, 'smooth');
  for (const input of inputs) {
    const values = FAR_CUTOFF_MULTIPLIERS.map((m) => computeShadowDirectionFit(input.letterRoute, input.letterTarget, input.coverageThreshold, m, 90));
    for (let i = 1; i < values.length; i += 1) {
      if (values[i]! + 1e-9 < values[i - 1]!) {
        return { ok: false, detail: `${word}.${input.letter}: directionFit decreased from ${FAR_CUTOFF_MULTIPLIERS[i - 1]}x (${values[i - 1]!.toFixed(3)}) to ${FAR_CUTOFF_MULTIPLIERS[i]}x (${values[i]!.toFixed(3)})` };
      }
    }
  }
  return { ok: true, detail: 'directionFit is non-decreasing across all cutoff multipliers for every letter' };
}
{
  const result = assertCutoffMonotonic('ROBZ', robzShape.points, robzShape.points);
  tests.push({ name: 'B. far-cutoff monotonicity (ROBZ, full walk): directionFit never decreases as the cutoff multiplier increases', passed: result.ok, detail: result.detail });
}
{
  const reversedRoute = robzShape.letters.flatMap((letter) => [...letter.points].reverse());
  const result = assertCutoffMonotonic('ROBZ', reversedRoute, robzShape.points);
  tests.push({ name: 'B. far-cutoff monotonicity (ROBZ, letters reversed): directionFit never decreases as the cutoff multiplier increases', passed: result.ok, detail: result.detail });
}

// --- C. angular monotonicity ---
function assertAngularMonotonic(word: string, route: readonly Vec2[], target: readonly Vec2[]) {
  const inputs = extractLetterOrderInputs(word, target, route, 'smooth');
  for (const input of inputs) {
    const values = ANGLE_SCALES_DEGREES.map((deg) => computeShadowDirectionFit(input.letterRoute, input.letterTarget, input.coverageThreshold, 1, deg));
    for (let i = 1; i < values.length; i += 1) {
      if (values[i]! + 1e-9 < values[i - 1]!) {
        return { ok: false, detail: `${word}.${input.letter}: directionFit decreased from ${ANGLE_SCALES_DEGREES[i - 1]}deg (${values[i - 1]!.toFixed(3)}) to ${ANGLE_SCALES_DEGREES[i]}deg (${values[i]!.toFixed(3)})` };
      }
    }
  }
  return { ok: true, detail: 'directionFit is non-decreasing across all angle scales for every letter' };
}
{
  const result = assertAngularMonotonic('ROBZ', robzShape.points, robzShape.points);
  tests.push({ name: 'C. angular monotonicity (ROBZ, full walk): directionFit never decreases as the angle scale widens (90->120->135->180)', passed: result.ok, detail: result.detail });
}
{
  const reversedRoute = robzShape.letters.flatMap((letter) => [...letter.points].reverse());
  const result = assertAngularMonotonic('ROBZ', reversedRoute, robzShape.points);
  tests.push({ name: 'C. angular monotonicity (ROBZ, letters reversed): directionFit never decreases as the angle scale widens', passed: result.ok, detail: result.detail });
}

// --- D. contribution math ---
{
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const mismatches: string[] = [];
  for (const input of inputs) {
    const real = scoreOrderedPath(input.letterRoute, input.sampledTarget, input.letterTarget, {
      orderDistanceScale: input.orderDistanceScale,
      coverageThreshold: input.coverageThreshold,
    });
    const reconstructed = 0.5 * real.dtwFit + 0.3 * real.progressFit + 0.2 * real.directionFit;
    if (Math.abs(reconstructed - real.order) > 1e-9) {
      mismatches.push(`${input.letter}: sum=${reconstructed} order=${real.order}`);
    }
  }
  tests.push({
    name: 'D. contribution math: 0.5*dtwFit + 0.3*progressFit + 0.2*directionFit exactly equals order for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- segment stats: usable + farCutoff + degenerate segment counts sum to total considered segments ---
{
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  for (const input of inputs) {
    const stats = computeDirectionSegmentStats(input.letterRoute, input.letterTarget, input.coverageThreshold);
    const lengthSum = stats.usableSegmentLength + stats.farCutoffSegmentLength + stats.degenerateSegmentLength;
    if (Math.abs(lengthSum - stats.totalRouteSegmentLength) > 1e-6) {
      tests.push({ name: `segment stats: usable+farCutoff+degenerate lengths sum to totalRouteSegmentLength for ${input.letter}`, passed: false, detail: `sum=${lengthSum} total=${stats.totalRouteSegmentLength}` });
    }
  }
  tests.push({
    name: 'segment stats: usable+farCutoff+degenerate segment lengths sum to totalRouteSegmentLength for every letter (no double-counting or gaps in the mirrored loop)',
    passed: true,
    detail: 'verified per-letter inline above (any mismatch would have pushed its own FAIL)',
  });
}

// --- E. no production mutation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  for (const input of inputs) {
    for (const multiplier of FAR_CUTOFF_MULTIPLIERS) {
      computeShadowDirectionFit(input.letterRoute, input.letterTarget, input.coverageThreshold, multiplier, 90);
    }
    for (const angle of ANGLE_SCALES_DEGREES) {
      computeShadowDirectionFit(input.letterRoute, input.letterTarget, input.coverageThreshold, 1, angle);
    }
  }
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'E. no production mutation: running the full cutoff+angle sweep does not change a subsequent real analyzeTargetIdentity() result',
    passed:
      identityBefore.spanOccupancy === identityAfter.spanOccupancy &&
      identityBefore.targetSpan === identityAfter.targetSpan &&
      identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord &&
      identityBefore.letters.every((letter, index) => letter.order === identityAfter.letters[index]!.order),
    detail: `before traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
