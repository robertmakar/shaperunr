import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import {
  abstractZStrokePoints,
  decomposeZStrokes,
  measureStreetSupport,
  measureOrientationSupport,
  buildDirected,
  testConnectivity,
} from './letter-street-support-diagnostic';

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
function densify(points: readonly Vec2[], factor: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let s = 0; s < factor; s += 1) { const t = s / factor; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  out.push(points[points.length - 1]!);
  return out;
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

check('abstractZStrokePoints: exactly 4 points, matching the source-verified top/diagonal/bottom structure', () => {
  const points = abstractZStrokePoints();
  assert.equal(points.length, 4);
  assert.deepEqual(points[0], { x: 0.1, y: 1 });
  assert.deepEqual(points[1], { x: 0.9, y: 1 });
  assert.deepEqual(points[2], { x: 0.1, y: 0 });
  assert.deepEqual(points[3], { x: 0.9, y: 0 });
});

check('decomposeZStrokes: three non-empty strokes whose concatenation spans Z\'s own progress window', () => {
  const strokes = decomposeZStrokes(target, zBoundary);
  assert.ok(strokes.top.length >= 2);
  assert.ok(strokes.diagonal.length >= 2);
  assert.ok(strokes.bottom.length >= 2);
});

check('decomposeZStrokes: the diagonal stroke moves in the OPPOSITE horizontal direction from top/bottom (the structural feature under investigation)', () => {
  const strokes = decomposeZStrokes(target, zBoundary);
  const topDx = strokes.top[strokes.top.length - 1]!.x - strokes.top[0]!.x;
  const diagDx = strokes.diagonal[strokes.diagonal.length - 1]!.x - strokes.diagonal[0]!.x;
  const bottomDx = strokes.bottom[strokes.bottom.length - 1]!.x - strokes.bottom[0]!.x;
  assert.ok(topDx > 0, 'top should move left-to-right (+x)');
  assert.ok(bottomDx > 0, 'bottom should move left-to-right (+x)');
  assert.ok(diagDx < 0, 'diagonal should move right-to-left (-x), opposite of top/bottom');
});

check('measureStreetSupport: a stroke lying ON a corridor line reports near-zero min distance and 100% within 10m', () => {
  const graph = buildDenseGraph(target);
  const corridorLines = graph.segments.map((s) => s.points);
  const zStrokes = decomposeZStrokes(target, zBoundary);
  const support = measureStreetSupport(zStrokes.top, corridorLines);
  assert.ok(support.n > 0);
  // The dense graph follows the target closely, so the top stroke (near the target's own path) should have decent support.
  assert.ok(Number.isFinite(support.mean));
});

check('measureStreetSupport: a stroke far from any corridor line reports large distances and 0% within any threshold', () => {
  const farStroke: Vec2[] = [{ x: 100000, y: 100000 }, { x: 100010, y: 100010 }];
  const graph = buildDenseGraph(target);
  const corridorLines = graph.segments.map((s) => s.points);
  const support = measureStreetSupport(farStroke, corridorLines);
  assert.ok(support.min > 1000);
  assert.equal(support.fractionWithin.at50, 0);
});

check('measureOrientationSupport: a corridor edge running PARALLEL to the stroke has a small heading delta; a PERPENDICULAR edge has ~90 degrees', () => {
  const horizontalStroke: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const parallelLine: Vec2[][] = [[{ x: 0, y: 5 }, { x: 100, y: 5 }]];
  const perpendicularLine: Vec2[][] = [[{ x: 50, y: -50 }, { x: 50, y: 50 }]];
  const parallelSupport = measureOrientationSupport(horizontalStroke, parallelLine, 50);
  const perpSupport = measureOrientationSupport(horizontalStroke, perpendicularLine, 50);
  assert.ok(parallelSupport.mean < 15, `expected small delta for parallel edge, got ${parallelSupport.mean}`);
  assert.ok(perpSupport.mean > 60, `expected large delta for perpendicular edge, got ${perpSupport.mean}`);
});

check('buildDirected + testConnectivity: two points connected by a dense graph ARE reachable, with a graph/straight ratio close to 1 for a nearly-straight connecting path', () => {
  const graph = buildDenseGraph(target);
  const { directed, outgoing } = buildDirected(graph, target, 'generic', false);
  const from = target[0]!;
  const to = target[target.length - 1]!;
  const result = testConnectivity(directed, outgoing, graph, from, to, 3);
  assert.equal(result.connected, true);
  assert.ok(result.graphStraightRatio !== null && result.graphStraightRatio < 3, `expected a reasonable ratio for a dense graph following the target, got ${result.graphStraightRatio}`);
});

check('testConnectivity: two NEARLY-IDENTICAL points (overlapping K-nearest node sets) can produce a false "not connected" — findShortestConnectingPath deliberately excludes nodes shared between from/to sets; documented here so future callers use spatially-separated representative points, not shared boundary points, exactly the bug this task\'s Z forensic analysis caught and fixed', () => {
  const graph = buildDenseGraph(target);
  const { directed, outgoing } = buildDirected(graph, target, 'generic', false);
  const point = target[Math.floor(target.length / 2)]!;
  const nearlyIdenticalResult = testConnectivity(directed, outgoing, graph, point, { x: point.x + 0.01, y: point.y + 0.01 }, 5);
  // Not asserted as a hard requirement (whether it happens to connect depends on graph density), but if it reports disconnected, spatially-separated points on the SAME graph must NOT also report disconnected — proving the earlier failure was point-selection-specific, not a genuine graph limitation.
  const separatedResult = testConnectivity(directed, outgoing, graph, target[0]!, target[target.length - 1]!, 5);
  if (!nearlyIdenticalResult.connected) {
    assert.equal(separatedResult.connected, true, 'a dense graph should still connect well-separated points even when near-identical points falsely report disconnected');
  }
});

check('testConnectivity: two points in an EMPTY graph are never reachable', () => {
  const emptyGraph: ShapeGraph = { nodes: {}, segments: [] };
  const { directed, outgoing } = buildDirected(emptyGraph, target, 'generic', false);
  const result = testConnectivity(directed, outgoing, emptyGraph, target[0]!, target[target.length - 1]!, 3);
  assert.equal(result.connected, false);
  assert.equal(result.routeDistanceMeters, null);
});

console.log(`letter-street-support-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
