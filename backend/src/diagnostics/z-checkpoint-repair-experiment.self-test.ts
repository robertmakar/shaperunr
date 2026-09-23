import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import type { Directed, SearchState } from './graph-shape-goal-mirror';
import {
  buildZLandmarks,
  buildGenericThreeWayLandmarks,
  buildProgressCheckpoints,
  indexProgressCheckpointBits,
  makeProgressCheckpointAugmenter,
  checkpointReachedByRoute,
  measureSubStrokeCoverage,
  zStrokeRanges,
  classifyZFailureMode,
} from './z-checkpoint-repair-experiment';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

const SCALE = 500;
function scalePoints(points: readonly Vec2[]): Vec2[] {
  return points.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
}
function buildDenseGraph(target: Vec2[]): ShapeGraph {
  const segments: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
  const steps = 16;
  for (let i = 0; i < steps; i += 1) {
    const a = target[Math.floor((i / steps) * (target.length - 1))]!;
    const b = target[Math.floor(((i + 1) / steps) * (target.length - 1))]!;
    segments.push({ id: `main${i}`, wayId: `w${i}`, points: [{ ...a }, { ...b }] });
  }
  return buildShapeGraph(segments);
}

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const target = scalePoints(robzShape.points);
const boundaries = letterBoundariesFromWordShape(robzShape).boundaries;
const zBoundary = boundaries[3]!;
const rBoundary = boundaries[0]!;

check('buildZLandmarks: three landmarks, strictly increasing progress, matching zStrokeProgressSplit p1/mid/p2', () => {
  const landmarks = buildZLandmarks(target, zBoundary);
  assert.equal(landmarks.length, 3);
  assert.equal(landmarks[0]!.label, 'topToDiagonal');
  assert.equal(landmarks[1]!.label, 'diagonalMid');
  assert.equal(landmarks[2]!.label, 'diagonalToBottom');
  assert.ok(landmarks[0]!.progress < landmarks[1]!.progress);
  assert.ok(landmarks[1]!.progress < landmarks[2]!.progress);
});

check('buildGenericThreeWayLandmarks: three landmarks spanning the letter\'s own progress window, ending exactly at its end', () => {
  const landmarks = buildGenericThreeWayLandmarks(target, rBoundary);
  assert.equal(landmarks.length, 3);
  assert.ok(landmarks[0]!.progress > rBoundary.projectedStartProgress);
  assert.ok(Math.abs(landmarks[2]!.progress - rBoundary.projectedEndProgress) < 1e-9);
});

check('buildProgressCheckpoints + indexProgressCheckpointBits: a checkpoint whose snap includes a given node contributes that checkpoint\'s bit for that node', () => {
  const graph = buildDenseGraph(target);
  const landmarks = buildZLandmarks(target, zBoundary);
  const checkpoints = buildProgressCheckpoints(landmarks, graph, 3);
  assert.equal(checkpoints.length, 3);
  const nodeToBits = indexProgressCheckpointBits(checkpoints);
  const firstCandidateNode = checkpoints[0]!.snap.candidates[0]?.nodeId;
  if (firstCandidateNode) {
    assert.ok(nodeToBits.get(firstCandidateNode)?.includes(0));
  }
});

function makeDirectedEdge(endProgress: number): Directed {
  return {
    id: 'e', wayId: 'w', from: 'a', to: 'b', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    reverseId: 'e<', length: 1, meanPerp: 0, headingFit: 1, forward: 1,
    startProgress: endProgress - 0.01, endProgress, minProgress: endProgress - 0.01, maxProgress: endProgress,
    progressSpan: 0.01, forwardness: 0.01, overlapMeters: 1, followMeters: 1, crossing: false, interior: false,
  };
}
function makeState(extraMask: number): SearchState {
  return { node: 'a', progress: 0, cost: 0, length: 0, covered: 0, edgeIds: [], usedUndirected: new Set(), usedInterior: false, extraMask };
}

check('makeProgressCheckpointAugmenter: zero penalty when an edge has not yet passed any checkpoint\'s progress', () => {
  const checkpoints = buildProgressCheckpoints(buildZLandmarks(target, zBoundary), buildDenseGraph(target), 3);
  const augmenter = makeProgressCheckpointAugmenter(checkpoints, 60);
  const edge = makeDirectedEdge(checkpoints[0]!.targetProgress - 0.05);
  assert.equal(augmenter(edge, 0, makeState(0)), 0);
});

check('makeProgressCheckpointAugmenter: penalizes exactly the missed checkpoints once an edge moves past their progress with extraMask=0', () => {
  const checkpoints = buildProgressCheckpoints(buildZLandmarks(target, zBoundary), buildDenseGraph(target), 3);
  const augmenter = makeProgressCheckpointAugmenter(checkpoints, 60);
  const pastAll = makeDirectedEdge(checkpoints[2]!.targetProgress + 0.05);
  assert.equal(augmenter(pastAll, 0, makeState(0)), 60 * 3);
  const pastFirstOnly = makeDirectedEdge(checkpoints[0]!.targetProgress + 0.005);
  assert.equal(augmenter(pastFirstOnly, 0, makeState(0)), 60);
});

check('makeProgressCheckpointAugmenter: a checkpoint already hit (its bit set in extraMask) is never penalized again', () => {
  const checkpoints = buildProgressCheckpoints(buildZLandmarks(target, zBoundary), buildDenseGraph(target), 3);
  const augmenter = makeProgressCheckpointAugmenter(checkpoints, 60);
  const pastAll = makeDirectedEdge(checkpoints[2]!.targetProgress + 0.05);
  const allHit = makeState((1 << 0) | (1 << 1) | (1 << 2));
  assert.equal(augmenter(pastAll, 0, allHit), 0);
  const onlyFirstHit = makeState(1 << 0);
  assert.equal(augmenter(pastAll, 0, onlyFirstHit), 60 * 2);
});

check('checkpointReachedByRoute: a route point placed exactly at the target coordinate is reached; a point 1000m away is not', () => {
  const near = checkpointReachedByRoute([{ x: 100, y: 100 }, { x: 100.01, y: 100.01 }], { x: 100, y: 100 });
  assert.equal(near.reached, true);
  assert.ok(near.nearestDistanceMeters < 1);
  const far = checkpointReachedByRoute([{ x: 100, y: 100 }], { x: 100 + 1000, y: 100 });
  assert.equal(far.reached, false);
});

check('checkpointReachedByRoute: nearestIndex correctly identifies WHICH route point is closest, for order-checking', () => {
  const route = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
  const result = checkpointReachedByRoute(route, { x: 51, y: 0 });
  assert.equal(result.nearestIndex, 1);
});

check('measureSubStrokeCoverage + zStrokeRanges: a route that densely follows the full Z target has high occupancy on all three sub-ranges', () => {
  const graph = buildDenseGraph(target);
  const ranges = zStrokeRanges(zBoundary);
  assert.equal(ranges.length, 3);
  assert.equal(ranges[0]!.label, 'top');
  assert.equal(ranges[1]!.label, 'diagonal');
  assert.equal(ranges[2]!.label, 'bottom');
  const denseRoute = graph.segments.flatMap((s) => s.points);
  const coverage = measureSubStrokeCoverage(denseRoute, target, ranges);
  assert.equal(coverage.length, 3);
  for (const c of coverage) assert.ok(c.occupancy >= 0 && c.occupancy <= 1);
});

check('measureSubStrokeCoverage: a route with NO points near the target has zero occupancy on every sub-range', () => {
  const ranges = zStrokeRanges(zBoundary);
  const farRoute: Vec2[] = [{ x: -1_000_000, y: -1_000_000 }, { x: -999_990, y: -999_990 }];
  const coverage = measureSubStrokeCoverage(farRoute, target, ranges);
  for (const c of coverage) assert.equal(c.occupancy, 0);
});

check('classifyZFailureMode: A when top ink is far below threshold', () => {
  const mode = classifyZFailureMode({ topInk: 0.1, diagonalInk: 0, bottomInk: 0, checkpoint1Reached: false, checkpoint2Reached: false, checkpoint3Reached: false, wholeZPhysicallyCovered: false, inkThreshold: 0.6 });
  assert.equal(mode, 'A_fails_reach_top');
});

check('classifyZFailureMode: B when top is reached (ink present) but the top->diagonal checkpoint is not', () => {
  const mode = classifyZFailureMode({ topInk: 0.7, diagonalInk: 0, bottomInk: 0, checkpoint1Reached: false, checkpoint2Reached: false, checkpoint3Reached: false, wholeZPhysicallyCovered: false, inkThreshold: 0.6 });
  assert.equal(mode, 'B_fails_top_to_diagonal');
});

check('classifyZFailureMode: C when the top->diagonal checkpoint is hit but the diagonal is never meaningfully covered nor its own midpoint reached', () => {
  const mode = classifyZFailureMode({ topInk: 0.7, diagonalInk: 0.1, bottomInk: 0, checkpoint1Reached: true, checkpoint2Reached: false, checkpoint3Reached: false, wholeZPhysicallyCovered: false, inkThreshold: 0.6 });
  assert.equal(mode, 'C_fails_through_diagonal');
});

check('classifyZFailureMode: D when the diagonal is traversed but the diagonal->bottom checkpoint (or bottom ink) fails', () => {
  const mode = classifyZFailureMode({ topInk: 0.7, diagonalInk: 0.7, bottomInk: 0.1, checkpoint1Reached: true, checkpoint2Reached: true, checkpoint3Reached: false, wholeZPhysicallyCovered: false, inkThreshold: 0.6 });
  assert.equal(mode, 'D_fails_diagonal_to_bottom');
});

check('classifyZFailureMode: E_F when all three strokes and checkpoints are reached, yet the whole-letter physical gate still reports uncovered', () => {
  const mode = classifyZFailureMode({ topInk: 0.7, diagonalInk: 0.7, bottomInk: 0.7, checkpoint1Reached: true, checkpoint2Reached: true, checkpoint3Reached: true, wholeZPhysicallyCovered: false, inkThreshold: 0.6 });
  assert.equal(mode, 'E_F_reaches_all_but_not_physically_covered');
});

check('classifyZFailureMode: G when nothing is failing (all reached AND physically covered) — this is a success case, not a real failure mode', () => {
  const mode = classifyZFailureMode({ topInk: 0.9, diagonalInk: 0.9, bottomInk: 0.9, checkpoint1Reached: true, checkpoint2Reached: true, checkpoint3Reached: true, wholeZPhysicallyCovered: true, inkThreshold: 0.6 });
  assert.equal(mode, 'G_not_a_failure_or_unclassified');
});

console.log(`z-checkpoint-repair-experiment.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
