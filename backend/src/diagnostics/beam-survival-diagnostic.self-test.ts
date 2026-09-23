/**
 * DEVELOPMENT ONLY. Self-test for beam-survival-diagnostic.ts — tracer parity
 * (attaching it never changes the search), fate accounting, ancestry and
 * exact cost replay.
 */
import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { polylineLength } from '@/lib/geometry';
import { buildShapeGraph, routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { routeGraphConstrainedShapeMirror } from './graph-shape-goal-mirror';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { zStrokeRanges } from './z-checkpoint-repair-experiment';
import { createBeamTracer, createMetricCache, decomposeCost, ancestry } from './beam-survival-diagnostic';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}
function buildDenseConnectedGraph(target: Vec2[]): ShapeGraph {
  const segments: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
  const steps = 16;
  for (let i = 0; i < steps; i += 1) {
    const a = target[Math.floor((i / steps) * (target.length - 1))]!;
    const b = target[Math.floor(((i + 1) / steps) * (target.length - 1))]!;
    segments.push({ id: `main${i}`, wayId: `wayMain${i}`, points: [{ ...a }, { ...b }] });
    segments.push({ id: `spur${i}`, wayId: `waySpur${i}`, points: [{ ...a }, { x: a.x + 4, y: a.y + 4 }] });
  }
  return buildShapeGraph(segments);
}
const shape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const target = shape.points.map((p) => ({ x: p.x * 150, y: p.y * 150 }));
const graph = buildDenseConnectedGraph(target);
const production = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true });
const { observer, trace } = createBeamTracer();
const traced = routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true, observer });

check('tracer attached: identical to production (path, statesExplored, failure, shapeScore)', () => {
  assert.deepEqual(traced.pathPoints, production.pathPoints);
  assert.equal(traced.search.statesExplored, production.search.statesExplored);
  assert.equal(traced.failure, production.failure);
  assert.equal(traced.metrics.shapeScore, production.metrics.shapeScore);
});
check('beamWidth / maxExpansions overrides left at default are identical to production', () => {
  const r = routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true, beamWidth: 48 * 4, maxExpansions: 12_000 });
  assert.deepEqual(r.pathPoints, production.pathPoints);
  assert.equal(r.search.statesExplored, production.search.statesExplored);
});
check('fate accounting per layer: created = dedupeRejected + pushed; pushed = kept + truncated', () => {
  assert.ok(trace.layers.length > 0);
  for (const l of trace.layers) {
    assert.equal(l.created, l.dedupeRejected + l.pushed, `layer ${l.layer}`);
    assert.equal(l.pushed, l.kept + l.truncated, `layer ${l.layer}`);
  }
  const created = trace.records.filter((r) => r.fate !== 'start').length;
  assert.equal(created, trace.layers.reduce((s, l) => s + l.created, 0));
});
check('every non-start record has a parent that was expanded; returned state is traced', () => {
  for (const r of trace.records) {
    if (r.fate === 'start') continue;
    const p = trace.records[r.parentId!]!;
    assert.ok(p.expanded, `parent ${p.id} of ${r.id} must have been expanded`);
    assert.deepEqual(r.state.edgeIds.slice(0, -1), p.state.edgeIds);
  }
  assert.ok(trace.finish?.best && trace.byState.get(trace.finish.best));
});
check('exact cost replay: edgeCostBreakdown summed along ancestry === state.cost for every surviving state', () => {
  const targetLength = polylineLength(target);
  const survivors = trace.records.filter((r) => r.fate === 'survived' || r.fate === 'start');
  for (const r of survivors) {
    const d = decomposeCost(trace, r, targetLength, false, 'generic', traced.regions);
    assert.ok(d.matches, `record ${r.id}: replay ${d.total} vs state ${r.state.cost}`);
  }
});
check('metric cache: returned state has Z stroke ink in [0,1] and ancestry ends at itself', () => {
  const zBoundary = letterBoundariesFromWordShape(shape).boundaries[3]!;
  const metrics = createMetricCache(trace, target, zStrokeRanges(zBoundary));
  const best = trace.byState.get(trace.finish!.best!)!;
  const m = metrics(best);
  for (const v of [m.ink.top, m.ink.diagonal, m.ink.bottom]) assert.ok(v >= 0 && v <= 1);
  const chain = ancestry(trace, best);
  assert.equal(chain[chain.length - 1], best);
  assert.equal(chain[0]!.fate, 'start');
});

console.log(`beam-survival-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
