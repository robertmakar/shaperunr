/**
 * DEVELOPMENT ONLY. Self-test for goal-threshold-diagnostic.ts and the
 * read-only SearchObserver hook in graph-shape-goal-mirror.ts.
 */
import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { polylineLength } from '@/lib/geometry';
import { buildShapeGraph, routeGraphConstrainedShape, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { routeGraphConstrainedShapeMirror, REAL_ISGOAL } from './graph-shape-goal-mirror';
import { createTelemetryObserver, makeProgressThresholdGoal, classifyTermination, assessViability } from './goal-threshold-diagnostic';

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

// Same fixture pattern as graph-shape-goal-mirror.self-test.ts.
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
const scale = (points: Vec2[]) => points.map((p) => ({ x: p.x * 150, y: p.y * 150 }));

for (const word of ['ROBZ', 'CAIRO']) {
  const target = scale(buildWalkableWordShape(word, { letterVariant: 'smooth' }).points);
  const graph = buildDenseConnectedGraph(target);

  check(`${word}: mirror + observer + makeProgressThresholdGoal(0.88) === real routeGraphConstrainedShape (path, statesExplored, failure)`, () => {
    const real = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true });
    const { observer } = createTelemetryObserver({ threshold: GRAPH_SHAPE.goalProgress, targetLength: polylineLength(target), loop: false });
    const observed = routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true, goalCheck: makeProgressThresholdGoal(GRAPH_SHAPE.goalProgress), observer });
    assert.deepEqual(observed.pathPoints, real.pathPoints);
    assert.equal(observed.search.statesExplored, real.search.statesExplored);
    assert.equal(observed.failure, real.failure);
    assert.equal(observed.metrics.shapeScore, real.metrics.shapeScore);
  });

  check(`${word}: observer does not change the default-REAL_ISGOAL mirror result`, () => {
    const plain = routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true, goalCheck: REAL_ISGOAL });
    const { observer } = createTelemetryObserver({ threshold: GRAPH_SHAPE.goalProgress, targetLength: polylineLength(target), loop: false });
    const observed = routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true, goalCheck: REAL_ISGOAL, observer });
    assert.deepEqual(observed.pathPoints, plain.pathPoints);
    assert.equal(observed.search.statesExplored, plain.search.statesExplored);
  });

  check(`${word}: telemetry is internally consistent (returned is lowest-cost goal; first goal <= returned layer; finish reason matches cap)`, () => {
    const { observer, finish } = createTelemetryObserver({ threshold: 0.88, targetLength: polylineLength(target), loop: false });
    const result = routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true, goalCheck: makeProgressThresholdGoal(0.88), observer });
    const t = finish(0);
    assert.equal(t.expansions, result.search.statesExplored);
    assert.equal(t.maxExpansionsHit, t.expansions >= GRAPH_SHAPE.maxExpansions);
    if (t.returned?.isGoal) {
      assert.ok(t.goalStatesEncountered >= 1);
      assert.ok(t.firstGoal && t.returned.layerFound !== null && t.firstGoal.layer <= t.returned.layerFound);
      assert.ok(t.returned.progress >= 0.88 && t.returned.coverage >= GRAPH_SHAPE.goalCoverage);
      assert.ok(t.bestProgressGoal && t.bestProgressGoal.progress >= t.returned.progress);
    }
    assert.ok(['A_farther_viable_existed', 'B_no_viable_beyond', 'C_no_goal_found'].includes(classifyTermination(t)));
  });

  check(`${word}: a stricter threshold (0.99) never returns a goal below 0.99`, () => {
    const { observer, finish } = createTelemetryObserver({ threshold: 0.99, targetLength: polylineLength(target), loop: false });
    routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true, goalCheck: makeProgressThresholdGoal(0.99), observer });
    const t = finish(0);
    if (t.returned?.isGoal) assert.ok(t.returned.progress >= 0.99);
  });
}

check('viability: a synthetic state whose last edge is far from the target is not viable', () => {
  const directed = new Map([
    ['a>', { id: 'a>', reverseId: 'a<', from: 'n0', to: 'n1', wayId: 'w', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], length: 10, meanPerp: 5, startProgress: 0, endProgress: 0.1, minProgress: 0, maxProgress: 0.1 } as never],
    ['b>', { id: 'b>', reverseId: 'b<', from: 'n1', to: 'n2', wayId: 'w', points: [{ x: 10, y: 0 }, { x: 20, y: 0 }], length: 10, meanPerp: 500, startProgress: 0.1, endProgress: 0.2, minProgress: 0.1, maxProgress: 0.2 } as never],
  ]);
  const state = { node: 'n2', progress: 0.2, cost: 0, length: 20, covered: 0, edgeIds: ['a>', 'b>'], usedUndirected: new Set<string>(), usedInterior: false, extraMask: 0 };
  const v = assessViability(state, directed, 100);
  assert.equal(v.connected, true);
  assert.equal(v.proximityValid, false);
  assert.equal(v.viable, false);
});

check('viability: a jump of more than maxForwardJump in progress is flagged', () => {
  const directed = new Map([
    ['a>', { id: 'a>', reverseId: 'a<', from: 'n0', to: 'n1', wayId: 'w', points: [], length: 10, meanPerp: 5, startProgress: 0, endProgress: 0.1, minProgress: 0, maxProgress: 0.1 } as never],
    ['b>', { id: 'b>', reverseId: 'b<', from: 'n1', to: 'n2', wayId: 'w', points: [], length: 10, meanPerp: 5, startProgress: 0.5, endProgress: 0.6, minProgress: 0.5, maxProgress: 0.6 } as never],
  ]);
  const state = { node: 'n2', progress: 0.6, cost: 0, length: 20, covered: 0, edgeIds: ['a>', 'b>'], usedUndirected: new Set<string>(), usedInterior: false, extraMask: 0 };
  assert.equal(assessViability(state, directed, 100).noImpossibleJump, false);
});

console.log(`goal-threshold-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
