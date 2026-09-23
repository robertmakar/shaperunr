/**
 * Self-test for completion-aware goal selection in routeGraphConstrainedShape
 * (graph-shape.ts) and its production support (completion-aware-goal.ts).
 */
import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { buildShapeGraph, routeGraphConstrainedShape, type CompletionAwareGoalSupport, type ShapeGraph } from './graph-shape';
import { buildWalkableWordShape } from './walkable-target';
import { createCompletionAwareGoalSupport } from './completion-aware-goal';
import { routeGraphConstrainedShapeMirror } from '../diagnostics/graph-shape-goal-mirror';
import { computeInkOnlyOccupancy } from '../diagnostics/letter-occupancy';
import { letterBoundariesFromWordShape } from '../diagnostics/multi-letter-trace';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from '../diagnostics/physical-word-traversal-evaluator';
import { analyzeStrokeTraversal, buildRoutePieces } from '../diagnostics/z-diagonal-direction-diagnostic';

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
const scale = (points: Vec2[]) => points.map((p) => ({ x: p.x * 150, y: p.y * 150 }));

for (const word of ['ROBZ', 'CAIRO', 'IN']) {
  const target = scale(buildWalkableWordShape(word, { letterVariant: 'smooth' }).points);
  const graph = buildDenseConnectedGraph(target);
  const base = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true });
  const mirror = routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true });

  check(`${word}: without completionAware the result equals the parity-proven mirror (unchanged production)`, () => {
    assert.deepEqual(base.pathPoints, mirror.pathPoints);
    assert.equal(base.search.statesExplored, mirror.search.statesExplored);
    assert.equal(base.failure, mirror.failure);
  });

  check(`${word}: a support that never finds completion and always rejects returns the production route`, () => {
    const never: CompletionAwareGoalSupport = { finalLetterCompleteInOrder: () => false, acceptCandidate: () => false };
    const r = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true, completionAware: never });
    assert.deepEqual(r.pathPoints, base.pathPoints);
    assert.equal(r.search.statesExplored, base.search.statesExplored);
  });

  check(`${word}: a rejecting guard always returns the production route, whatever is complete`, () => {
    const rejectAll: CompletionAwareGoalSupport = { finalLetterCompleteInOrder: () => true, acceptCandidate: () => false };
    const r = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true, completionAware: rejectAll });
    assert.deepEqual(r.pathPoints, base.pathPoints);
  });

  check(`${word}: accepted candidates are the cheapest completion-aware state; the guard sees the production route as baseline`, () => {
    let seenBaseline: Vec2[] | null = null;
    let completeCalls = 0;
    const acceptAll: CompletionAwareGoalSupport = {
      finalLetterCompleteInOrder: () => {
        completeCalls += 1;
        return true;
      },
      acceptCandidate: (baseline) => {
        seenBaseline = baseline.pathPoints;
        return true;
      },
    };
    const r = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true, completionAware: acceptAll });
    assert.ok(completeCalls >= 1);
    // Everything is "complete", so the pick is the cheapest candidate overall; the search itself is unchanged.
    assert.equal(r.search.statesExplored, base.search.statesExplored);
    if (seenBaseline) assert.deepEqual(seenBaseline, base.pathPoints);
  });

  check(`${word}: single-letter / non-multiLetter searches ignore completionAware`, () => {
    const acceptAll: CompletionAwareGoalSupport = { finalLetterCompleteInOrder: () => true, acceptCandidate: () => true };
    const plain = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: false });
    const r = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: false, completionAware: acceptAll });
    assert.deepEqual(r.pathPoints, plain.pathPoints);
  });

  check(`${word}: real production support runs and never returns a route rejected by its own guard`, () => {
    const support = createCompletionAwareGoalSupport({ word, target, geometryVariant: 'smooth' })!;
    const r = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true, completionAware: support });
    if (JSON.stringify(r.pathPoints) !== JSON.stringify(base.pathPoints)) assert.equal(support.acceptCandidate(base, r), true);
    assert.equal(r.search.statesExplored, base.search.statesExplored);
  });
}

// Equivalence: the production (fast) completion check must equal the validated reference check on real candidate paths.
for (const word of ['ROBZ', 'CAIRO', 'IN', 'IU', 'IP']) {
  check(`${word}: fast finalLetterCompleteInOrder === validated reference (ink + evaluatePhysicalWordTraversal + analyzeStrokeTraversal(buildRoutePieces)) on every candidate path`, () => {
    const target = scale(buildWalkableWordShape(word, { letterVariant: 'smooth' }).points);
    const graph = buildDenseConnectedGraph(target);
    const fast = createCompletionAwareGoalSupport({ word, target, geometryVariant: 'smooth' })!;
    const paths: Vec2[][] = [];
    const recorder: CompletionAwareGoalSupport = {
      finalLetterCompleteInOrder: (p) => {
        paths.push([...p]);
        return false; // keep scanning: collect every candidate the search offers
      },
      acceptCandidate: () => false,
    };
    routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true, completionAware: recorder });
    const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' }));
    const fi = boundarySet.boundaries.length - 1;
    const fb = boundarySet.boundaries[fi]!;
    const reference = (p: Vec2[]) => {
      if (p.length < 2) return false;
      const ink = computeInkOnlyOccupancy({ route: p, target, boundarySet }).perLetterOccupancy[fi]!.occupancy;
      if (ink < PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold) return false;
      const phys = evaluatePhysicalWordTraversal(word, target, p, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS).letters[fi]!.physicallyCovered;
      const dir = analyzeStrokeTraversal(buildRoutePieces(p, target), target, { label: fb.letter, start: fb.projectedStartProgress, end: fb.projectedEndProgress }).category === 'A_correct';
      return phys && dir;
    };
    assert.ok(paths.length > 0);
    let positives = 0;
    for (const p of paths) {
      const r = reference(p);
      if (r) positives += 1;
      assert.equal(fast.finalLetterCompleteInOrder(p), r);
    }
    console.log(`       (${paths.length} candidate paths, ${positives} complete)`);
  });
}

check('createCompletionAwareGoalSupport returns undefined for a single-letter word', () => {
  const target = scale(buildWalkableWordShape('Z', { letterVariant: 'smooth' }).points);
  assert.equal(createCompletionAwareGoalSupport({ word: 'Z', target, geometryVariant: 'smooth' }), undefined);
});

console.log(`completion-aware-goal.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
