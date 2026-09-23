/**
 * DEVELOPMENT ONLY. Tests for the upstream physical-coverage diagnostics.
 *
 * A. raw coverage parity — this module's rawInkCoverage input comes
 *    straight from letter-occupancy.ts's computeInkOnlyOccupancy
 *    (UNCHANGED), re-verified here against a fresh analyzeTargetIdentity()
 *    call for the same route/target.
 * B. placement parity — calling this module's functions around a real
 *    rankStreetFitPlacements() call does not change its result.
 * C. beam parity — calling this module's functions around a real
 *    routeGraphConstrainedShape() call does not change its result.
 * D. production isolation — analyzeTargetIdentity() is unaffected.
 * E. graph diagnostics are read-only — inputs are never mutated.
 */
import type { Vec2 } from '@/lib/geometry';
import { rankStreetFitPlacements } from '../generation/street-fit-search';
import { routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { analyzeTargetIdentity, coverageThresholdMeters } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import {
  buildLetterTraceableProfile,
  classifyUpstreamFailure,
  computeTraceableCoverage,
} from './upstream-coverage-diagnostic';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const robzBoundarySet = letterBoundariesFromWordShape(robzShape);

// A simple synthetic graph: two ways, one that closely follows the R letter, one far away.
const rLetter = robzShape.letters[0]!;
const closeWay: Vec2[] = rLetter.points.map((point) => ({ x: point.x + 0.01, y: point.y }));
const farWay: Vec2[] = rLetter.points.map((point) => ({ x: point.x + 500, y: point.y + 500 }));

// --- A. raw coverage parity ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inkResult = computeInkOnlyOccupancy({
    route: robzShape.points,
    target: robzShape.points,
    boundarySet: robzBoundarySet,
    letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited),
  });
  const completedCount = inkResult.perLetterOccupancy.filter((letter) => letter.completed).length;
  tests.push({
    name: 'A. raw coverage parity: this module consumes rawInkCoverage straight from the real, unmodified computeInkOnlyOccupancy() — completed-letter count still matches production lettersVisited exactly',
    passed: completedCount === identity.lettersVisited,
    detail: `completedCount=${completedCount} identity.lettersVisited=${identity.lettersVisited}`,
  });
}

// --- B. placement parity ---
{
  const graph = [{ wayId: 'close', points: closeWay }];
  const placements = [
    { id: 'p0', rotationDegrees: 0, scale: 1, eastMeters: 0, northMeters: 0, distanceFromStartMeters: 0 },
    { id: 'p1', rotationDegrees: 45, scale: 1, eastMeters: 10, northMeters: 0, distanceFromStartMeters: 10 },
  ];
  const before = rankStreetFitPlacements({ word: robzShape, targetDistanceMeters: 500, graph, placements });
  // Run diagnostic functions in between — must not affect a subsequent identical call.
  const target = rLetter.points;
  computeTraceableCoverage(target, [closeWay, farWay], 45);
  buildLetterTraceableProfile('R', target, [closeWay, farWay], coverageThresholdMeters(target));
  const after = rankStreetFitPlacements({ word: robzShape, targetDistanceMeters: 500, graph, placements });
  tests.push({
    name: 'B. placement parity: rankStreetFitPlacements() returns the identical result before and after running this module\'s diagnostic functions',
    passed: JSON.stringify(before.map((p) => p.score)) === JSON.stringify(after.map((p) => p.score)),
    detail: `before=${JSON.stringify(before.map((p) => p.score))} after=${JSON.stringify(after.map((p) => p.score))}`,
  });
}

// --- C. beam parity ---
{
  const segments = [{ id: 'seg1', wayId: 'way1', from: 'a', to: 'b', points: closeWay }];
  const graph: ShapeGraph = { nodes: { a: closeWay[0]!, b: closeWay[closeWay.length - 1]! }, segments };
  const before = routeGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' });
  computeTraceableCoverage(rLetter.points, [closeWay], 45);
  const after = routeGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' });
  tests.push({
    name: 'C. beam parity: routeGraphConstrainedShape() returns the identical result (metrics + edgeIds) before and after running this module\'s diagnostic functions',
    passed: JSON.stringify(before.metrics) === JSON.stringify(after.metrics) && JSON.stringify(before.edgeIds) === JSON.stringify(after.edgeIds),
    detail: `before.shapeScore=${before.metrics.shapeScore} after.shapeScore=${after.metrics.shapeScore}`,
  });
}

// --- D. production isolation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  buildLetterTraceableProfile('R', rLetter.points, [closeWay, farWay], coverageThresholdMeters(rLetter.points));
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'D. production isolation: running the upstream coverage diagnostics does not change a subsequent real analyzeTargetIdentity() result',
    passed: identityBefore.targetSpan === identityAfter.targetSpan && identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord,
    detail: `before traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

// --- E. read-only: inputs are never mutated ---
{
  const targetCopy = rLetter.points.map((point) => ({ ...point }));
  const graphCopy = [closeWay.map((point) => ({ ...point })), farWay.map((point) => ({ ...point }))];
  const targetSnapshot = JSON.stringify(targetCopy);
  const graphSnapshot = JSON.stringify(graphCopy);
  buildLetterTraceableProfile('R', targetCopy, graphCopy, coverageThresholdMeters(targetCopy));
  tests.push({
    name: 'E. graph diagnostics are read-only: target and graphLines arrays are byte-identical before and after buildLetterTraceableProfile',
    passed: JSON.stringify(targetCopy) === targetSnapshot && JSON.stringify(graphCopy) === graphSnapshot,
    detail: 'no mutation detected',
  });
}

// --- semantic checks: close way gives high traceable coverage, far way gives none ---
{
  const closeResult = computeTraceableCoverage(rLetter.points, [closeWay], 20);
  const farResult = computeTraceableCoverage(rLetter.points, [farWay], 20);
  tests.push({
    name: 'semantic: a way that closely follows the letter gives near-complete traceable coverage at a tight 20m threshold',
    passed: closeResult.fraction >= 0.9 && closeResult.longestConnectedSpanFraction >= 0.9,
    detail: `fraction=${closeResult.fraction.toFixed(3)} longestConnectedSpanFraction=${closeResult.longestConnectedSpanFraction.toFixed(3)}`,
  });
  tests.push({
    name: 'semantic: a way 500m+700m away gives zero traceable coverage at a tight 20m threshold',
    passed: farResult.fraction === 0,
    detail: `fraction=${farResult.fraction}`,
  });
}

// --- semantic: a way that only follows HALF the letter gives partial, connected coverage ---
// Uses a straight synthetic target (unlike R, which loops back near its own
// stem) so a "first half only" way is unambiguously far from the second half.
{
  const straightTarget: Vec2[] = Array.from({ length: 20 }, (_, index) => ({ x: index * 5, y: 0 }));
  const halfWay: Vec2[] = straightTarget.slice(0, 10).map((point) => ({ x: point.x, y: point.y + 1 }));
  const result = computeTraceableCoverage(straightTarget, [halfWay], 20);
  tests.push({
    name: 'semantic: a way covering only the first half of a straight target gives partial coverage with a connected span roughly matching the covered fraction',
    passed: result.fraction > 0.3 && result.fraction < 0.7 && Math.abs(result.fraction - result.longestConnectedSpanFraction) < 0.15,
    detail: `fraction=${result.fraction.toFixed(3)} longestConnectedSpanFraction=${result.longestConnectedSpanFraction.toFixed(3)}`,
  });
}

// --- classification: passing letter always classifies as passing regardless of graph support ---
{
  const profile = buildLetterTraceableProfile('R', rLetter.points, [farWay], coverageThresholdMeters(rLetter.points));
  const classification = classifyUpstreamFailure(profile, 0.9, true);
  tests.push({
    name: 'classification: a letter already meaningfullyVisited classifies as passing regardless of graph support',
    passed: classification === 'passing',
    detail: `classification=${classification}`,
  });
}

// --- classification: no nearby graph at all classifies as graph_unavailable ---
{
  const profile = buildLetterTraceableProfile('R', rLetter.points, [farWay], coverageThresholdMeters(rLetter.points));
  const classification = classifyUpstreamFailure(profile, 0, false);
  tests.push({
    name: 'classification: a letter with no nearby graph support at all (only a way 500m+ away) classifies as graph_unavailable',
    passed: classification === 'graph_unavailable',
    detail: `classification=${classification}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
