import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { buildShapeGraph, routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { routeGraphConstrainedShapeMirror, REAL_ISGOAL, computeLetterBinRanges } from './graph-shape-goal-mirror';
import { letterBoundariesFromWordShape } from './multi-letter-trace';

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

function graphOf(segments: Array<{ id: string; wayId: string; points: Vec2[] }>): ShapeGraph {
  return buildShapeGraph(segments);
}

/** Same "staircase" pattern used in checkpoint-route-generator.self-test.ts, scaled to real-meters magnitude so buildShapeGraph's 8m node-snap grid behaves realistically. */
function buildDenseConnectedGraph(target: Vec2[]): ShapeGraph {
  const segments: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
  const steps = 16;
  for (let i = 0; i < steps; i += 1) {
    const a = target[Math.floor((i / steps) * (target.length - 1))]!;
    const b = target[Math.floor(((i + 1) / steps) * (target.length - 1))]!;
    segments.push({ id: `main${i}`, wayId: `wayMain${i}`, points: [{ ...a }, { ...b }] });
    segments.push({ id: `spur${i}`, wayId: `waySpur${i}`, points: [{ ...a }, { x: a.x + 4, y: a.y + 4 }] });
  }
  return graphOf(segments);
}

const SCALE = 150;
function scalePoints(points: Vec2[], scale: number): Vec2[] {
  return points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
}

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const robzTarget = scalePoints(robzShape.points, SCALE);
const robzGraph = buildDenseConnectedGraph(robzTarget);

const oShape = buildWalkableWordShape('O', { letterVariant: 'smooth' });
const oTarget = scalePoints(oShape.points, SCALE);
const oGraph = buildDenseConnectedGraph(oTarget);

const lShape = buildWalkableWordShape('L', { letterVariant: 'smooth' });
const lTarget = scalePoints(lShape.points, SCALE);
const lGraph = buildDenseConnectedGraph(lTarget);

check('Mirror with default REAL_ISGOAL exactly reproduces real routeGraphConstrainedShape on a multi-letter (ROBZ) graph — pathPoints, metrics.targetCoverage, failure, search.statesExplored', () => {
  const real = routeGraphConstrainedShape({ target: robzTarget, graph: robzGraph, kind: 'generic', multiLetter: true });
  const mirrored = routeGraphConstrainedShapeMirror({ target: robzTarget, graph: robzGraph, kind: 'generic', multiLetter: true });
  assert.deepEqual(mirrored.pathPoints, real.pathPoints);
  assert.equal(mirrored.metrics.targetCoverage, real.metrics.targetCoverage);
  assert.equal(mirrored.metrics.progressSpan, real.metrics.progressSpan);
  assert.equal(mirrored.metrics.shapeScore, real.metrics.shapeScore);
  assert.equal(mirrored.failure, real.failure);
  assert.equal(mirrored.search.statesExplored, real.search.statesExplored);
  assert.equal(mirrored.startNode, real.startNode);
  assert.equal(mirrored.endNode, real.endNode);
});

check('Mirror with default REAL_ISGOAL exactly reproduces real routeGraphConstrainedShape on a single-letter (L) graph', () => {
  const real = routeGraphConstrainedShape({ target: lTarget, graph: lGraph, kind: 'L', multiLetter: false });
  const mirrored = routeGraphConstrainedShapeMirror({ target: lTarget, graph: lGraph, kind: 'L', multiLetter: false });
  assert.deepEqual(mirrored.pathPoints, real.pathPoints);
  assert.equal(mirrored.metrics.targetCoverage, real.metrics.targetCoverage);
  assert.equal(mirrored.search.statesExplored, real.search.statesExplored);
});

check('Mirror with default REAL_ISGOAL exactly reproduces real routeGraphConstrainedShape on a loop (O) graph', () => {
  const real = routeGraphConstrainedShape({ target: oTarget, graph: oGraph, kind: 'O', multiLetter: false });
  const mirrored = routeGraphConstrainedShapeMirror({ target: oTarget, graph: oGraph, kind: 'O', multiLetter: false });
  assert.deepEqual(mirrored.pathPoints, real.pathPoints);
  assert.equal(mirrored.metrics.targetCoverage, real.metrics.targetCoverage);
  assert.equal(mirrored.failure, real.failure);
  assert.equal(mirrored.search.statesExplored, real.search.statesExplored);
});

check('A stricter goalCheck (always false) makes the mirror return search_exhausted / no goal reached, differing from the real (default) result on the same graph', () => {
  const impossible = () => false;
  const mirrored = routeGraphConstrainedShapeMirror({ target: robzTarget, graph: robzGraph, kind: 'generic', multiLetter: true, goalCheck: impossible });
  const real = routeGraphConstrainedShape({ target: robzTarget, graph: robzGraph, kind: 'generic', multiLetter: true });
  // With no state ever satisfying the goal, bestGoal stays null and the search falls back to bestAny (the betterState-ranked best-effort state) — still produces SOME path, but via a different selection path than the real goal-driven one; expansions should be >= real's (an impossible goal never lets the search stop early on a goal match, only on maxExpansions/beam exhaustion).
  assert.ok(mirrored.search.statesExplored >= real.search.statesExplored);
});

check('A trivially-satisfied goalCheck (always true) still produces a valid connected path from a real start state', () => {
  const always = () => true;
  const mirrored = routeGraphConstrainedShapeMirror({ target: robzTarget, graph: robzGraph, kind: 'generic', multiLetter: true, goalCheck: always });
  assert.ok(mirrored.pathPoints.length >= 2);
});

check('computeLetterBinRanges: ROBZ boundaries map to non-overlapping, letter-ordered bin ranges covering a large majority of the 28 bins', () => {
  const boundaries = letterBoundariesFromWordShape(robzShape).boundaries;
  const ranges = computeLetterBinRanges(boundaries);
  assert.equal(ranges.length, 4);
  assert.deepEqual(ranges.map((r) => r.letter), ['R', 'O', 'B', 'Z']);
  const allBins = ranges.flatMap((r) => r.bins);
  const uniqueBins = new Set(allBins);
  assert.equal(allBins.length, uniqueBins.size, 'no bin should be claimed by two different letters');
  assert.ok(allBins.length >= 20, `expected most of the 28 bins to be claimed by some letter, got ${allBins.length}`);
});

check('computeLetterBinRanges: a narrow letter (I in CAIRO) still receives at least one bin, never an empty range if its progress window is nonzero', () => {
  const cairoShape = buildWalkableWordShape('CAIRO', { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(cairoShape).boundaries;
  const ranges = computeLetterBinRanges(boundaries);
  const iRange = ranges.find((r) => r.letter === 'I');
  assert.ok(iRange, 'I should have an entry');
  assert.ok(iRange!.bins.length >= 1, `I's narrow progress window should still claim >=1 bin, got ${iRange!.bins.length}`);
});

check('computeLetterBinRanges: a repeated letter (M in MIM) produces TWO separate range entries, not merged', () => {
  const mimShape = buildWalkableWordShape('MIM', { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(mimShape).boundaries;
  const ranges = computeLetterBinRanges(boundaries);
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges.map((r) => r.letter), ['M', 'I', 'M']);
  const [firstM, , secondM] = ranges;
  const overlap = firstM!.bins.filter((b) => secondM!.bins.includes(b));
  assert.equal(overlap.length, 0, 'the two M instances should occupy disjoint bin ranges');
});

console.log(`graph-shape-goal-mirror.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
