import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { resolveActiveLetter, sliceLetterStrokePolyline, computeEdgeStrokeDistance, makeStrokeProximityAugmenter } from './letter-stroke-proximity-diagnostic';
import type { Directed, SearchState } from './graph-shape-goal-mirror';

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

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const target = scalePoints(robzShape.points);
const boundaries = letterBoundariesFromWordShape(robzShape).boundaries;

function fakeEdge(points: Vec2[], endProgress: number): Directed {
  return {
    id: 'e', wayId: 'w', from: 'a', to: 'b', points,
    reverseId: 'e2', length: 10, meanPerp: 0, headingFit: 1, forward: 1,
    startProgress: endProgress - 0.01, endProgress, minProgress: endProgress - 0.01, maxProgress: endProgress,
    progressSpan: 0.01, forwardness: 0.01, overlapMeters: 5, followMeters: 5, crossing: false, interior: false,
  };
}
function stateWith(extraMask = 0): SearchState {
  return { node: 'a', progress: 0, cost: 0, length: 0, covered: 0, edgeIds: [], usedUndirected: new Set(), usedInterior: false, extraMask };
}

check('resolveActiveLetter: a progress strictly inside R\'s window resolves to R', () => {
  const r = boundaries[0]!;
  const midR = (r.projectedStartProgress + r.projectedEndProgress) / 2;
  const active = resolveActiveLetter(midR, boundaries);
  assert.equal(active?.letter, 'R');
});

check('resolveActiveLetter: a progress in the gap between R and O resolves to the NEAREST letter (not always the next one)', () => {
  const r = boundaries[0]!;
  const o = boundaries[1]!;
  const gapMid = (r.projectedEndProgress + o.projectedStartProgress) / 2;
  const active = resolveActiveLetter(gapMid, boundaries);
  assert.ok(active?.letter === 'R' || active?.letter === 'O');
  // Closer to R's end than O's start should resolve to R specifically.
  const nearR = r.projectedEndProgress + (o.projectedStartProgress - r.projectedEndProgress) * 0.1;
  assert.equal(resolveActiveLetter(nearR, boundaries)?.letter, 'R');
  const nearO = r.projectedEndProgress + (o.projectedStartProgress - r.projectedEndProgress) * 0.9;
  assert.equal(resolveActiveLetter(nearO, boundaries)?.letter, 'O');
});

check('sliceLetterStrokePolyline: R\'s slice is a real sub-polyline of the placed target, not the abstract word-shape geometry (scaled coordinates)', () => {
  const r = boundaries[0]!;
  const stroke = sliceLetterStrokePolyline(target, r);
  assert.ok(stroke.length >= 2);
  for (const p of stroke) assert.ok(Math.abs(p.x) <= SCALE * 1.5 && Math.abs(p.y) <= SCALE * 1.5, 'points should be in the scaled local-meters frame, not abstract 0..1 units');
});

check('computeEdgeStrokeDistance: an edge ON the letter stroke has near-zero distance; an edge far away has a large distance', () => {
  const r = boundaries[0]!;
  const stroke = sliceLetterStrokePolyline(target, r);
  const onStroke = fakeEdge([stroke[0]!, stroke[Math.min(1, stroke.length - 1)]!], r.projectedStartProgress + 0.01);
  const farAway = fakeEdge([{ x: stroke[0]!.x + 5000, y: stroke[0]!.y + 5000 }, { x: stroke[0]!.x + 5010, y: stroke[0]!.y + 5010 }], r.projectedStartProgress + 0.01);
  const near = computeEdgeStrokeDistance(onStroke, stroke);
  const far = computeEdgeStrokeDistance(farAway, stroke);
  assert.ok(near < 5, `expected near-zero, got ${near}`);
  assert.ok(far > 4000, `expected large distance, got ${far}`);
});

check('computeEdgeStrokeDistance samples the WHOLE edge, not just an endpoint — a long edge whose far end is near the stroke but whose near end is not still reports a small MINIMUM distance', () => {
  const r = boundaries[0]!;
  const stroke = sliceLetterStrokePolyline(target, r);
  const nearPoint = stroke[0]!;
  const farPoint = { x: nearPoint.x + 3000, y: nearPoint.y + 3000 };
  const longEdge = fakeEdge([farPoint, nearPoint], r.projectedStartProgress + 0.01);
  const distance = computeEdgeStrokeDistance(longEdge, stroke);
  assert.ok(distance < 5, `min-over-samples should catch the near endpoint even though the edge is long, got ${distance}`);
});

check('makeStrokeProximityAugmenter: lambda=0 always returns 0 extra cost regardless of distance', () => {
  const { augmenter } = makeStrokeProximityAugmenter(boundaries, target, { lambda: 0, distanceScaleMeters: 25 });
  const r = boundaries[0]!;
  const stroke = sliceLetterStrokePolyline(target, r);
  const farAway = fakeEdge([{ x: stroke[0]!.x + 5000, y: stroke[0]!.y + 5000 }, { x: stroke[0]!.x + 5010, y: stroke[0]!.y + 5010 }], r.projectedStartProgress + 0.01);
  assert.equal(augmenter(farAway, r.projectedStartProgress, stateWith()), 0);
});

check('makeStrokeProximityAugmenter: a far-away edge at lambda>0 costs strictly more than an on-stroke edge, and the penalty is capped at lambda (clamp01)', () => {
  const { augmenter } = makeStrokeProximityAugmenter(boundaries, target, { lambda: 0.2, distanceScaleMeters: 25 });
  const r = boundaries[0]!;
  const stroke = sliceLetterStrokePolyline(target, r);
  const onStroke = fakeEdge([stroke[0]!, stroke[Math.min(1, stroke.length - 1)]!], r.projectedStartProgress + 0.01);
  const farAway = fakeEdge([{ x: stroke[0]!.x + 5000, y: stroke[0]!.y + 5000 }, { x: stroke[0]!.x + 5010, y: stroke[0]!.y + 5010 }], r.projectedStartProgress + 0.01);
  const nearCost = augmenter(onStroke, r.projectedStartProgress, stateWith());
  const farCost = augmenter(farAway, r.projectedStartProgress, stateWith());
  assert.ok(nearCost < farCost);
  assert.ok(farCost <= 0.2 + 1e-9, `penalty should never exceed lambda (clamp01 on the ratio), got ${farCost}`);
});

console.log(`letter-stroke-proximity-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
