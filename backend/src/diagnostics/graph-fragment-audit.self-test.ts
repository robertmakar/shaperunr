/**
 * DEVELOPMENT ONLY. Self-test for graph-fragment-audit.ts.
 */
import assert from 'node:assert/strict';

import { buildShapeGraph } from '../generation/graph-shape';
import { filterCorridorSegments } from '../generation/shape-discovery';
import { connectedComponents, nearestGap, nearMissEndpoints, shortestPathBetween, segmentDistanceToTarget } from './graph-fragment-audit';

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

// Target: a straight line y=0 from x=0..400. Main street on it (0..200), a fragment street on it (240..400),
// joined in the RAW data only by a detour loop 120m away from the target (dropped by the 70m corridor filter).
const target = [{ x: 0, y: 0 }, { x: 400, y: 0 }];
const raw = [
  { id: 'main', wayId: 'w1', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
  { id: 'frag', wayId: 'w2', points: [{ x: 240, y: 0 }, { x: 400, y: 0 }] },
  { id: 'up', wayId: 'w3', points: [{ x: 200, y: 0 }, { x: 200, y: 120 }] },
  { id: 'across', wayId: 'w3', points: [{ x: 200, y: 120 }, { x: 240, y: 120 }] },
  { id: 'down', wayId: 'w3', points: [{ x: 240, y: 120 }, { x: 240, y: 0 }] },
  // a T-junction near-miss: stub whose endpoint lands 3m off the interior of 'frag'
  { id: 'stub', wayId: 'w4', points: [{ x: 320, y: -60 }, { x: 320, y: -3 }] },
];
const corridor = filterCorridorSegments(raw, target);
const corridorGraph = buildShapeGraph(corridor);
const rawGraph = buildShapeGraph(raw);

check('corridor graph: main and fragment are separate components; raw graph joins them', () => {
  const c = connectedComponents(corridorGraph);
  assert.notEqual(c.segmentComponent.get('main'), c.segmentComponent.get('frag'));
  const r = connectedComponents(rawGraph);
  assert.equal(r.segmentComponent.get('main'), r.segmentComponent.get('frag'));
});
check('the corridor filter dropped exactly the far link (across, 120m from target)', () => {
  assert.deepEqual(corridor.map((s) => s.id).sort(), ['down', 'frag', 'main', 'stub', 'up']);
  assert.ok(segmentDistanceToTarget(raw[3]!, target) > 70);
});
check('nearest gap between main and fragment is 40m along the target', () => {
  const g = nearestGap(corridor.filter((s) => s.id === 'main') as never, corridor.filter((s) => s.id === 'frag') as never)!;
  assert.ok(Math.abs(g.distance - 40) < 1e-9, `${g.distance}`);
});
check('raw shortest path between the corridor components is exactly the dropped far link', () => {
  const c = connectedComponents(corridorGraph);
  const mainNodes = new Set([...c.nodeComponent].filter(([, k]) => k === c.segmentComponent.get('main')).map(([n]) => n));
  const fragNodes = new Set([...c.nodeComponent].filter(([, k]) => k === c.segmentComponent.get('frag')).map(([n]) => n));
  const p = shortestPathBetween(rawGraph, mainNodes, fragNodes)!;
  assert.deepEqual(p.segments.map((s) => s.id), ['across']);
});
check('near-miss endpoints: stub endpoint 3m from the interior of frag is a T-junction', () => {
  const nm = nearMissEndpoints(corridorGraph.segments.filter((s) => s.id === 'stub'), corridorGraph.segments.filter((s) => s.id === 'frag'), 8);
  assert.equal(nm.length, 1);
  assert.ok(nm[0]!.toInterior && Math.abs(nm[0]!.distance - 3) < 1e-9);
});

console.log(`graph-fragment-audit.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
