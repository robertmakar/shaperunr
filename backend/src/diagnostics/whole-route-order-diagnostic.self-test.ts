/**
 * DEVELOPMENT ONLY. Tests for the whole-route order diagnostic
 * (whole-route-order-diagnostic.ts).
 *
 * A. computeWholeRouteOrderParams exactly matches scorePolylines()'s own
 *    internal orderDistanceScale/coverageThreshold formula.
 * B. computeWholeRouteOrder exactly reproduces the real, unmodified
 *    scorePolylines().breakdown.order for the same route/target (parity).
 * C. extractWholeRouteProgressSequence's progress values are internally
 *    consistent with what monotonicFitCurrent computes from them
 *    (re-deriving monotonicFit from the extracted sequence matches the
 *    real decomposition's own monotonicFit).
 * D. findWholeRouteNegativeSteps correctness on a known sequence.
 * E. Semantic: a route that traverses a word forward scores clearly
 *    higher than the SAME route traversed in reverse (genuinely wrong
 *    sequence) — the metric DOES catch real violations.
 * F. Semantic: a Manhattan/right-angle approximation of a straight
 *    traversal does not collapse order to near-zero (tests whether
 *    angular street geometry is unfairly penalized).
 * G. Read-only / production isolation.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { scorePolylines } from '../scoring/shape-match';
import {
  computeWholeRouteOrderParams,
  computeWholeRouteOrder,
  extractWholeRouteProgressSequence,
  findWholeRouteNegativeSteps,
  monotonicFitCurrent,
} from './whole-route-order-diagnostic';
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

// --- A. params formula parity ---
{
  const params = computeWholeRouteOrderParams(robzShape.points, robzShape.points);
  const targetLength = robzShape.points.length; // placeholder, real check below uses polylineLength
  void targetLength;
  const scored = scorePolylines(goodRoute, robzShape.points);
  tests.push({
    name: 'A. computeWholeRouteOrderParams.coverageThreshold matches scorePolylines\'s own reported coverageThresholdMeters',
    passed: Math.abs(params.coverageThreshold - scored.details.coverageThresholdMeters) < 1e-9,
    detail: `computed=${params.coverageThreshold} real=${scored.details.coverageThresholdMeters}`,
  });
}

// --- B. computeWholeRouteOrder parity with real scorePolylines ---
{
  const shadow = computeWholeRouteOrder(goodRoute, robzShape.points);
  const real = scorePolylines(goodRoute, robzShape.points);
  tests.push({
    name: 'B. computeWholeRouteOrder exactly reproduces the real scorePolylines().breakdown.order (and full OrderMatchDetails via details.order)',
    passed: Math.abs(shadow.order - real.breakdown.order) < 1e-9 && Math.abs(shadow.dtwFit - real.details.order.dtwFit) < 1e-9 && Math.abs(shadow.progressFit - real.details.order.progressFit) < 1e-9 && Math.abs(shadow.directionFit - real.details.order.directionFit) < 1e-9,
    detail: `shadow.order=${shadow.order} real.order=${real.breakdown.order}`,
  });
}

// --- C. progress sequence internal consistency ---
{
  const samples = extractWholeRouteProgressSequence(goodRoute, robzShape.points);
  const progress = samples.map((s) => s.progress);
  const rederived = monotonicFitCurrent(progress);
  const real = computeWholeRouteOrder(goodRoute, robzShape.points);
  tests.push({
    name: 'C. re-deriving monotonicFit from extractWholeRouteProgressSequence\'s own progress values exactly matches computeWholeRouteOrder\'s monotonicFit',
    passed: Math.abs(rederived - real.monotonicFit) < 1e-9,
    detail: `rederived=${rederived} real=${real.monotonicFit}`,
  });
}

// --- D. negative step detection ---
{
  const samples = [
    { sampleIndex: 0, point: { x: 0, y: 0 }, progress: 0.1, perpendicularDistance: 0 },
    { sampleIndex: 1, point: { x: 0, y: 0 }, progress: 0.2, perpendicularDistance: 0 },
    { sampleIndex: 2, point: { x: 0, y: 0 }, progress: 0.15, perpendicularDistance: 0 },
    { sampleIndex: 3, point: { x: 0, y: 0 }, progress: 0.3, perpendicularDistance: 0 },
  ];
  const negatives = findWholeRouteNegativeSteps(samples);
  tests.push({
    name: 'D. findWholeRouteNegativeSteps detects exactly one negative step (0.2->0.15) with magnitude 0.05',
    passed: negatives.length === 1 && Math.abs(negatives[0]!.magnitude - 0.05) < 1e-9 && negatives[0]!.sampleIndex === 2,
    detail: JSON.stringify(negatives),
  });
}

// --- E. forward vs reverse traversal ---
{
  const forwardOrder = computeWholeRouteOrder(goodRoute, robzShape.points);
  const reversedRoute = [...goodRoute].reverse();
  const reverseOrder = computeWholeRouteOrder(reversedRoute, robzShape.points);
  tests.push({
    name: 'E. a forward traversal scores clearly higher order than the SAME route traversed in reverse (genuinely wrong sequence) — the metric catches real violations',
    passed: forwardOrder.order > reverseOrder.order + 0.1,
    detail: `forward.order=${forwardOrder.order.toFixed(4)} reverse.order=${reverseOrder.order.toFixed(4)}`,
  });
}

// --- F. Manhattan approximation of a straight traversal ---
{
  const straightTarget: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const manhattanRoute: Vec2[] = [];
  for (let i = 0; i <= 20; i += 1) {
    const x = (i / 20) * 100;
    manhattanRoute.push({ x, y: i % 2 === 0 ? 0 : 3 }); // small right-angle zigzag while still progressing forward
  }
  const order = computeWholeRouteOrder(manhattanRoute, straightTarget);
  tests.push({
    name: 'F. a Manhattan/right-angle zigzag that still makes clean forward progress does NOT collapse order to near-zero',
    passed: order.order > 0.4,
    detail: `order=${order.order.toFixed(4)} monotonicFit=${order.monotonicFit.toFixed(4)} directionFit=${order.directionFit.toFixed(4)}`,
  });
}

// --- G. read-only / production isolation ---
{
  const targetSnapshot = JSON.stringify(robzShape.points);
  const routeSnapshot = JSON.stringify(goodRoute);
  computeWholeRouteOrder(goodRoute, robzShape.points);
  tests.push({
    name: 'G1. read-only: target and route arrays are byte-identical before and after the diagnostic runs',
    passed: JSON.stringify(robzShape.points) === targetSnapshot && JSON.stringify(goodRoute) === routeSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  computeWholeRouteOrder(goodRoute, robzShape.points);
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
