/**
 * DEVELOPMENT ONLY. Self-test for goal-selection-diagnostic.ts — selector
 * parity (BASELINE_COST === production's returned state) and same-search
 * guarantees (every selector picks from the one identical goal pool).
 */
import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, type ShapeGraph } from '../generation/graph-shape';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { routeGraphConstrainedShapeMirror, mirrorResultForState, computeLetterBinRanges, type SearchState } from './graph-shape-goal-mirror';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { createGoalPoolObserver, selectGoal, SELECTORS, SELECTION_PARAMS, finalLetterProgress, regressionFlags, classifyOutcome, evaluateSelectionGuard, evaluateTwoSidedGuard, twoSidedRouteTargetOk, type GoalEntry } from './goal-selection-diagnostic';

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

for (const word of ['ROBZ', 'CAIRO']) {
  const shape = buildWalkableWordShape(word, { letterVariant: 'smooth' });
  const target = scale(shape.points);
  const graph = buildDenseConnectedGraph(target);
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const finalLetter = boundaries[boundaries.length - 1]!;
  const finalLetterBins = computeLetterBinRanges(boundaries)[boundaries.length - 1]!;
  const production = routeGraphConstrainedShape({ target, graph, kind: 'generic', multiLetter: true });
  const { observer, pool } = createGoalPoolObserver();
  const observed = routeGraphConstrainedShapeMirror({ target, graph, kind: 'generic', multiLetter: true, observer });
  const p = pool();

  check(`${word}: observed search is production's search (path, statesExplored, failure)`, () => {
    assert.deepEqual(observed.pathPoints, production.pathPoints);
    assert.equal(observed.search.statesExplored, production.search.statesExplored);
    assert.equal(p.expansions, production.search.statesExplored);
    assert.equal(observed.failure, production.failure);
  });

  check(`${word}: BASELINE_COST selects exactly the state production returns, and mirrorResultForState reproduces production's route`, () => {
    assert.ok(p.goals.length > 0, 'fixture must produce goal states');
    const sel = selectGoal('BASELINE_COST', p.goals, { finalLetter, finalLetterBins });
    assert.equal(sel.entry?.state, p.searchReturned);
    const r = mirrorResultForState(sel.entry!.state, p.directed, target, 'generic', isClosedTarget(target), observed.regions, observed.search);
    assert.deepEqual(r.pathPoints, production.pathPoints);
    assert.equal(r.failure, production.failure);
    assert.equal(r.metrics.shapeScore, production.metrics.shapeScore);
  });

  check(`${word}: every selector picks a member of the SAME goal pool and respects its own rule`, () => {
    const maxP = Math.max(...p.goals.map((g) => g.state.progress));
    for (const name of SELECTORS) {
      const sel = selectGoal(name, p.goals, { finalLetter, finalLetterBins });
      assert.ok(sel.entry && p.goals.includes(sel.entry), `${name} must select from the pool`);
    }
    assert.ok(selectGoal('PROGRESS_BAND_03', p.goals, { finalLetter, finalLetterBins }).entry!.state.progress >= maxP - SELECTION_PARAMS.bandWide);
    assert.ok(selectGoal('PROGRESS_BAND_01', p.goals, { finalLetter, finalLetterBins }).entry!.state.progress >= maxP - SELECTION_PARAMS.bandTight);
    assert.equal(selectGoal('MAX_PROGRESS', p.goals, { finalLetter, finalLetterBins }).entry!.state.progress, maxP);
  });
}

// Pure-selector cases on a hand-built pool.
const mk = (progress: number, cost: number, order: number, covered = 0): GoalEntry => ({ state: { node: 'n', progress, cost, length: 0, covered, edgeIds: [], usedUndirected: new Set(), usedInterior: false, extraMask: 0 } as SearchState, order, layer: order });
const pool = [mk(0.9, 10, 0), mk(0.9, 10, 1), mk(0.95, 14, 2), mk(0.985, 30, 3), mk(1.0, 40, 4), mk(0.995, 35, 5)];
const finalLetter = { letter: 'Z', index: 0, projectedStartProgress: 0.84, projectedEndProgress: 1, lengthStartProgress: 0.84, lengthEndProgress: 1, letterLength: 1 };
const ctx = { finalLetter, finalLetterBins: { letter: 'Z', bins: [24, 25, 26, 27] } };

check('BASELINE_COST keeps the EARLIEST of equal-cost goals (production strict < rule)', () => {
  assert.equal(selectGoal('BASELINE_COST', pool, ctx).entry!.order, 0);
});
check('PROGRESS_BAND_03 = cheapest with progress >= max-0.03 (0.985@30)', () => {
  assert.equal(selectGoal('PROGRESS_BAND_03', pool, ctx).entry!.order, 3);
});
check('PROGRESS_BAND_01 = cheapest with progress >= 0.99 (0.995@35)', () => {
  assert.equal(selectGoal('PROGRESS_BAND_01', pool, ctx).entry!.order, 5);
});
check('MAX_PROGRESS = 1.0@40', () => {
  assert.equal(selectGoal('MAX_PROGRESS', pool, ctx).entry!.order, 4);
});
check('finalLetterProgress saturates at the letter end', () => {
  assert.equal(finalLetterProgress(mk(1.0, 0, 0).state, finalLetter), 1);
  assert.ok(Math.abs(finalLetterProgress(mk(0.92, 0, 0).state, finalLetter) - 0.5) < 1e-9);
});
check('FINAL_LETTER_MIN_50: eligible = >=2 of 4 final-letter bins covered; otherwise falls back to production choice', () => {
  const withBins = [mk(0.9, 10, 0, 1 << 24), mk(0.95, 20, 1, (1 << 24) | (1 << 25))];
  const sel = selectGoal('FINAL_LETTER_MIN_50', withBins, ctx);
  assert.equal(sel.entry!.order, 1);
  assert.equal(sel.fellBack, false);
  const none = selectGoal('FINAL_LETTER_MIN_50', [mk(0.9, 10, 0, 1 << 24)], ctx);
  assert.equal(none.fellBack, true);
  assert.equal(none.entry!.order, 0);
});
check('regression flags and outcome classification', () => {
  const base = { shapeScore: 0.7, targetCoverage: 0.8, backtracking: 0.01, routeTarget: 0.9, feasible: true, wordTraversalPhysical: false, letters: [{ physicallyCovered: true, coverage: 0.5, rawInk: 1 }, { physicallyCovered: false, coverage: 0.1, rawInk: 0.4 }] };
  const better = { ...base, letters: [base.letters[0]!, { physicallyCovered: true, coverage: 0.5, rawInk: 1 }] };
  assert.deepEqual(regressionFlags(base, better), []);
  assert.equal(classifyOutcome(false, base, better).outcome, 'improved_clean');
  const worse = { ...better, shapeScore: 0.6, feasible: false };
  assert.deepEqual(classifyOutcome(false, base, worse).flags.sort(), ['lost_feasibility', 'shape_drop']);
  assert.equal(classifyOutcome(false, base, worse).outcome, 'improved_with_regression');
  assert.equal(classifyOutcome(true, base, worse).outcome, 'identical');
});

check('guard: every guard is evaluated independently; all pass -> accepted', () => {
  const base = { shapeScore: 0.7, targetCoverage: 0.8, backtracking: 0.01, routeTarget: 0.5, feasible: true, wordTraversalPhysical: false, continuityValid: true, letters: [{ physicallyCovered: true, coverage: 0.5, rawInk: 1 }, { physicallyCovered: false, coverage: 0.1, rawInk: 0.4 }] };
  const ok = { ...base, shapeScore: 0.671, targetCoverage: 0.751, backtracking: 0.059, routeTarget: 0.625, letters: [base.letters[0]!, { physicallyCovered: true, coverage: 0.6, rawInk: 1 }] };
  const g = evaluateSelectionGuard(base, ok);
  assert.equal(g.accepted, true, JSON.stringify(g));
  const bad = { ...base, feasible: false, shapeScore: 0.6, targetCoverage: 0.7, backtracking: 0.1, routeTarget: 0.7, continuityValid: false, letters: [{ physicallyCovered: false, coverage: 0.1, rawInk: 0.2 }, base.letters[1]!] };
  const r = evaluateSelectionGuard(base, bad);
  assert.equal(r.accepted, false);
  assert.deepEqual(r.rejectionReasons, ['infeasible', 'shape', 'coverage', 'backtracking', 'route_target', 'letter_loss', 'continuity']);
  // continuity only fails on a valid -> invalid transition
  assert.equal(evaluateSelectionGuard({ ...base, continuityValid: false }, { ...base, continuityValid: false }).continuityGuard, true);
});

check('two-sided route/target guard: the task\'s four worked examples + zero-distance edge case', () => {
  assert.equal(twoSidedRouteTargetOk(0.273, 0.352), true);
  assert.equal(twoSidedRouteTargetOk(0.5, 0.7), true);
  assert.equal(twoSidedRouteTargetOk(0.9, 1.1), true);
  assert.equal(twoSidedRouteTargetOk(0.9, 1.2), false);
  assert.equal(twoSidedRouteTargetOk(1.0, 1.05), true);
  assert.equal(twoSidedRouteTargetOk(1.0, 1.06), false);
});

check('two-sided guard: final-letter coverage (-0.05 tolerance) and raw ink (no decrease) guards; O #1 pattern rejected', () => {
  const base = { shapeScore: 0.743, targetCoverage: 0.708, backtracking: 0, routeTarget: 0.603, feasible: true, wordTraversalPhysical: false, continuityValid: true, letters: [{ physicallyCovered: true, coverage: 0.4, rawInk: 1 }, { physicallyCovered: false, coverage: 0.333, rawInk: 0.6 }] };
  const o1 = { ...base, shapeScore: 0.730, targetCoverage: 0.667, routeTarget: 0.613, letters: [base.letters[0]!, { physicallyCovered: false, coverage: 0, rawInk: 0.6 }] };
  const r = evaluateTwoSidedGuard(base, o1);
  assert.equal(r.accepted, false);
  assert.deepEqual(r.rejectionReasons, ['final_coverage']);
  const inkLoss = { ...base, letters: [base.letters[0]!, { physicallyCovered: false, coverage: 0.333, rawInk: 0.4 }] };
  assert.deepEqual(evaluateTwoSidedGuard(base, inkLoss).rejectionReasons, ['final_raw_ink']);
  assert.equal(evaluateTwoSidedGuard(base, { ...base, letters: [base.letters[0]!, { physicallyCovered: false, coverage: 0.29, rawInk: 0.6 }] }).accepted, true);
  assert.deepEqual(evaluateTwoSidedGuard(base, { ...base, continuityValid: false }).rejectionReasons, ['continuity']);
  // continuityRule 'no_valid_to_invalid': invalid → invalid passes, valid → invalid fails.
  assert.equal(evaluateTwoSidedGuard({ ...base, continuityValid: false }, { ...base, continuityValid: false }, { continuityRule: 'no_valid_to_invalid' }).accepted, true);
  assert.deepEqual(evaluateTwoSidedGuard(base, { ...base, continuityValid: false }, { continuityRule: 'no_valid_to_invalid' }).rejectionReasons, ['continuity']);
});

console.log(`goal-selection-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
