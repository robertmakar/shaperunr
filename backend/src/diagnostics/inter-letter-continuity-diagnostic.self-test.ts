/**
 * DEVELOPMENT ONLY. Tests for the inter-letter route continuity
 * diagnostic (inter-letter-continuity-diagnostic.ts).
 *
 * A. extractLetterRouteSpans parity: assignedOriginalIndices for each
 *    letter has the same COUNT as order-score-diagnostic.ts's own
 *    extractLetterOrderInputs letterRoute (same filter formula).
 * B. routeDistanceAlongPolyline: sums real consecutive segment lengths,
 *    never a shortcut/straight-line jump — verified on a synthetic
 *    zig-zag route where the along-route distance is provably larger
 *    than the straight-line distance between the same two indices.
 * C. computeTransitionRecord on adjacent, densely-covered letters
 *    produces a small routeToStraightRatio (near 1) — a genuinely
 *    continuous transition.
 * D. computeTransitionRecord on a letter with NO assigned points
 *    (missing) returns null routeDistance/straightLineDistance, not a
 *    fabricated number.
 * E. computeRoutePointContinuity: unassignedFraction/gap stats are
 *    internally consistent (assigned+unassigned=total, largest gap is
 *    actually the max of the consecutiveGaps array).
 * F. classifyTransition: a short/direct case classifies DIRECT; a
 *    long-ratio, low-unassigned case classifies LONG_BUT_CONNECTED; a
 *    null-distance (missing letter) case classifies DISCONNECTED.
 * G. read-only / production isolation.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { extractLetterOrderInputs } from './order-score-diagnostic';
import {
  extractLetterRouteSpans,
  routeDistanceAlongPolyline,
  computeTransitionRecord,
  computeRoutePointContinuity,
  classifyTransition,
  type TransitionClassificationThresholds,
} from './inter-letter-continuity-diagnostic';
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

// --- A. parity with order-score-diagnostic's own filter ---
{
  const { spans } = extractLetterRouteSpans('ROBZ', robzShape.points, goodRoute, 'smooth');
  const orderInputs = extractLetterOrderInputs('ROBZ', robzShape.points, goodRoute, 'smooth');
  let allMatch = true;
  const details: string[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    if (spans[i]!.assignedOriginalIndices.length !== orderInputs[i]!.letterRoute.length) {
      allMatch = false;
      details.push(`${spans[i]!.letter}: spanCount=${spans[i]!.assignedOriginalIndices.length} orderInputCount=${orderInputs[i]!.letterRoute.length}`);
    }
  }
  tests.push({ name: 'A. extractLetterRouteSpans assignedOriginalIndices count exactly matches extractLetterOrderInputs letterRoute count for every letter', passed: allMatch, detail: allMatch ? 'all letters match' : details.join('; ') });
}

// --- B. routeDistanceAlongPolyline sums real segments, never shortcuts ---
{
  const zigzag: Vec2[] = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
  const along = routeDistanceAlongPolyline(zigzag, 0, 4);
  const straight = Math.hypot(zigzag[4]!.x - zigzag[0]!.x, zigzag[4]!.y - zigzag[0]!.y);
  tests.push({
    name: 'B. routeDistanceAlongPolyline on a zig-zag route sums the REAL path length (40), far exceeding the straight-line distance (0) between the same start/end indices',
    passed: Math.abs(along - 40) < 1e-9 && straight === 0,
    detail: `along=${along} straight=${straight}`,
  });
}

// --- C. continuous transition -> small ratio ---
{
  const { spans, sampledRoute } = extractLetterRouteSpans('ROBZ', robzShape.points, goodRoute, 'smooth');
  const record = computeTransitionRecord(spans[0]!, spans[1]!, sampledRoute);
  tests.push({
    name: 'C. R->O transition on a dense, closely-following route has a finite, reasonably small routeToStraightRatio (genuinely continuous, not a teleport)',
    passed: record.routeDistance !== null && record.routeToStraightRatio !== null && record.routeToStraightRatio < 5,
    detail: `routeDistance=${record.routeDistance?.toFixed(3)} straightLineDistance=${record.straightLineDistance?.toFixed(3)} ratio=${record.routeToStraightRatio?.toFixed(3)}`,
  });
}

// --- D. missing letter -> null, not fabricated ---
{
  // A route that never comes near Z's own corridor (only trace R/O/B).
  const partialRoute = densify(robzShape.letters.slice(0, 3).flatMap((l) => l.points), 4);
  const { spans, sampledRoute } = extractLetterRouteSpans('ROBZ', robzShape.points, partialRoute, 'smooth');
  const zSpan = spans[3]!;
  const record = computeTransitionRecord(spans[2]!, zSpan, sampledRoute);
  tests.push({
    name: 'D. a letter with zero assigned route points (Z, never visited) produces a null routeDistance/straightLineDistance transition record, not a fabricated number',
    passed: zSpan.assignedOriginalIndices.length === 0 && record.routeDistance === null && record.straightLineDistance === null,
    detail: `zAssignedCount=${zSpan.assignedOriginalIndices.length} routeDistance=${record.routeDistance} straightLineDistance=${record.straightLineDistance}`,
  });
}

// --- E. route-point continuity internal consistency ---
{
  const { spans, sampledRoute } = extractLetterRouteSpans('ROBZ', robzShape.points, goodRoute, 'smooth');
  const stats = computeRoutePointContinuity(sampledRoute, spans);
  const maxOfArray = stats.consecutiveGaps.length ? Math.max(...stats.consecutiveGaps) : 0;
  tests.push({
    name: 'E. computeRoutePointContinuity: assigned+unassigned=total, and largestConsecutiveGap exactly equals max(consecutiveGaps)',
    passed: stats.assignedRoutePoints + stats.unassignedRoutePoints === stats.totalRoutePoints && Math.abs(stats.largestConsecutiveGap - maxOfArray) < 1e-9,
    detail: `assigned=${stats.assignedRoutePoints} unassigned=${stats.unassignedRoutePoints} total=${stats.totalRoutePoints} largestGap=${stats.largestConsecutiveGap} maxOfArray=${maxOfArray}`,
  });
}

// --- F. classifyTransition ---
{
  const thresholds: TransitionClassificationThresholds = { directRatioMax: 1.5, shortDistanceMax: 0.05, disconnectedRatioMin: 5, disconnectedUnassignedFractionMin: 0.3 };
  const direct = classifyTransition({ fromLetter: 'A', toLetter: 'B', fromLastProgress: 0.1, toFirstProgress: 0.15, routeDistance: 0.01, straightLineDistance: 0.01, routeToStraightRatio: 1.0, targetProgressGap: 0.05, numberOfRoutePointsBetween: 1 }, 80, thresholds);
  const longConnected = classifyTransition({ fromLetter: 'A', toLetter: 'B', fromLastProgress: 0.1, toFirstProgress: 0.3, routeDistance: 0.5, straightLineDistance: 0.2, routeToStraightRatio: 2.5, targetProgressGap: 0.2, numberOfRoutePointsBetween: 3 }, 80, thresholds);
  const disconnected = classifyTransition({ fromLetter: 'A', toLetter: 'B', fromLastProgress: null, toFirstProgress: 0.3, routeDistance: null, straightLineDistance: null, routeToStraightRatio: null, targetProgressGap: null, numberOfRoutePointsBetween: null }, 80, thresholds);
  tests.push({ name: 'F1. classifyTransition: a short, low-ratio transition classifies DIRECT', passed: direct === 'DIRECT', detail: `actual=${direct}` });
  tests.push({ name: 'F2. classifyTransition: a longer, moderate-ratio, low-unassigned transition classifies LONG_BUT_CONNECTED', passed: longConnected === 'LONG_BUT_CONNECTED', detail: `actual=${longConnected}` });
  tests.push({ name: 'F3. classifyTransition: a null-distance (missing letter) transition classifies DISCONNECTED', passed: disconnected === 'DISCONNECTED', detail: `actual=${disconnected}` });
}

// --- G. read-only / production isolation ---
{
  const targetSnapshot = JSON.stringify(robzShape.points);
  const routeSnapshot = JSON.stringify(goodRoute);
  extractLetterRouteSpans('ROBZ', robzShape.points, goodRoute, 'smooth');
  tests.push({
    name: 'G1. read-only: target and route arrays are byte-identical before and after the diagnostic runs',
    passed: JSON.stringify(robzShape.points) === targetSnapshot && JSON.stringify(goodRoute) === routeSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  extractLetterRouteSpans('ROBZ', robzShape.points, goodRoute, 'smooth');
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
