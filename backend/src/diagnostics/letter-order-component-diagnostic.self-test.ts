/**
 * DEVELOPMENT ONLY. Tests for the letter-order component follow-up
 * diagnostic (letter-order-component-diagnostic.ts).
 *
 * A. progressConsistencyShadow at the REAL parameters (jumpAllowNumerator=4,
 *    revisitThreshold=0.12) exactly reproduces the real per-letter
 *    monotonicFit/jumpFit/revisitFit (via computeLetterOrderDecomposition,
 *    already parity-verified against production).
 * B. combineProgressFit/combineOrder at real component values exactly
 *    reproduce the real progressFit/order.
 * C. auditFilteredHeadingSegments: gap statistics are internally
 *    consistent (gapCount from the prior task's window-inputs matches the
 *    count of segments with originalIndexGap>1 here).
 * D. computeRealSegmentDirectionFit: every reported segment connects
 *    ORIGINAL-ADJACENT route indices (toOriginalIndex - fromOriginalIndex
 *    === 1) — the defining property that distinguishes it from the
 *    current filtered-array calculation.
 * E. read-only / production isolation.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import {
  progressConsistencyShadow,
  combineProgressFit,
  combineOrder,
  auditFilteredHeadingSegments,
  computeRealSegmentDirectionFit,
  extractLetterOrderInputs,
  computeLetterOrderDecomposition,
} from './letter-order-component-diagnostic';
import { extractLetterRouteWindowInputs } from './per-letter-order-diagnostic';
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

// --- A. progressConsistencyShadow parity at real parameters ---
{
  const orderInputs = extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const decompositions = orderInputs.map(computeLetterOrderDecomposition);
  let allMatch = true;
  const details: string[] = [];
  for (let i = 0; i < orderInputs.length; i += 1) {
    const input = orderInputs[i]!;
    const real = decompositions[i]!;
    if (input.letterRoute.length < 2) continue;
    const shadow = progressConsistencyShadow(input.letterRoute, input.letterTarget, 4, 0.12);
    if (Math.abs(shadow.monotonicFit - real.forward.monotonicFit) > 1e-9 || Math.abs(shadow.jumpFit - real.forward.jumpFit) > 1e-9 || Math.abs(shadow.revisitFit - real.forward.revisitFit) > 1e-9) {
      allMatch = false;
      details.push(`${input.letter}: shadow=${JSON.stringify({m:shadow.monotonicFit,j:shadow.jumpFit,r:shadow.revisitFit})} real=${JSON.stringify({m:real.forward.monotonicFit,j:real.forward.jumpFit,r:real.forward.revisitFit})}`);
    }
  }
  tests.push({
    name: 'A. progressConsistencyShadow(jumpAllowNumerator=4, revisitThreshold=0.12) exactly reproduces real monotonicFit/jumpFit/revisitFit for every letter',
    passed: allMatch,
    detail: allMatch ? 'all letters match exactly' : details.join('; '),
  });
}

// --- B. combineProgressFit/combineOrder parity ---
{
  const orderInputs = extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const decompositions = orderInputs.map(computeLetterOrderDecomposition);
  let allMatch = true;
  for (const real of decompositions) {
    const progressFit = combineProgressFit(real.forward.monotonicFit, real.forward.jumpFit, real.forward.revisitFit);
    const order = combineOrder(real.forward.dtwFit, real.forward.progressFit, real.forward.directionFit);
    if (Math.abs(progressFit - real.forward.progressFit) > 1e-9 || Math.abs(order - real.forward.order) > 1e-9) allMatch = false;
  }
  tests.push({
    name: 'B. combineProgressFit/combineOrder at real component values exactly reproduce real progressFit/order',
    passed: allMatch,
    detail: allMatch ? 'all letters match exactly' : 'mismatch found',
  });
}

// --- C. gap-count consistency between the two diagnostic modules ---
{
  const windowInputs = extractLetterRouteWindowInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  const audited = auditFilteredHeadingSegments('ROBZ', robzShape.points, goodRoute, 'smooth');
  let allMatch = true;
  const details: string[] = [];
  for (let i = 0; i < windowInputs.length; i += 1) {
    const w = windowInputs[i]!;
    const segments = audited[i]!;
    const gapsHere = segments.filter((s) => s.originalIndexGap > 1).length;
    if (gapsHere !== w.gapCount) {
      allMatch = false;
      details.push(`${w.letter}: audited=${gapsHere} windowInputs=${w.gapCount}`);
    }
  }
  tests.push({
    name: 'C. auditFilteredHeadingSegments gap counts exactly match extractLetterRouteWindowInputs gapCount for every letter',
    passed: allMatch,
    detail: allMatch ? 'all letters match' : details.join('; '),
  });
}

// --- D. computeRealSegmentDirectionFit only ever connects original-adjacent indices ---
{
  let allAdjacent = true;
  let totalSegments = 0;
  for (let letterIndex = 0; letterIndex < robzShape.letters.length; letterIndex += 1) {
    const result = computeRealSegmentDirectionFit('ROBZ', robzShape.points, goodRoute, 'smooth', letterIndex);
    totalSegments += result.segmentCount;
    for (const h of result.realHeadings) {
      if (h.toOriginalIndex - h.fromOriginalIndex !== 1) allAdjacent = false;
    }
  }
  tests.push({
    name: 'D. computeRealSegmentDirectionFit never connects two non-adjacent original route indices (the defining fix)',
    passed: allAdjacent && totalSegments > 0,
    detail: `totalSegments=${totalSegments} allAdjacent=${allAdjacent}`,
  });
}

// --- E. read-only / production isolation ---
{
  const targetSnapshot = JSON.stringify(robzShape.points);
  const routeSnapshot = JSON.stringify(goodRoute);
  auditFilteredHeadingSegments('ROBZ', robzShape.points, goodRoute, 'smooth');
  computeRealSegmentDirectionFit('ROBZ', robzShape.points, goodRoute, 'smooth', 0);
  tests.push({
    name: 'E1. read-only: target and route arrays are byte-identical before and after the diagnostic runs',
    passed: JSON.stringify(robzShape.points) === targetSnapshot && JSON.stringify(goodRoute) === routeSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  auditFilteredHeadingSegments('ROBZ', robzShape.points, goodRoute, 'smooth');
  const identityAfter = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'E2. production isolation: running the diagnostic does not change a subsequent real analyzeTargetIdentity() result',
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
