/**
 * DEVELOPMENT ONLY. Verifies the PRODUCTION implementation of guarded
 * completion-aware goal selection (graph-shape.ts + completion-aware-goal.ts)
 * against an INDEPENDENT trace-based reimplementation of the validated
 * "C + nine guards" logic (completion-guarded-validation.run.ts), on the same
 * two corpora (I+X 175, ROBZ/CAIRO 78).
 *
 * For every placement in every feasibility pool:
 *   old  = the pre-change production route (parity-proven mirror, no hook)
 *   new  = the production pipeline's record.pathPoints (hook active)
 * For the validated placements (old-feasible; ≤10 per I+X word/case), the
 * expected validated pick is recomputed from a traced search and must equal
 * `new` exactly. For all other placements, any change (new != old) must be an
 * expected, guard-accepted candidate.
 *
 * Run with: npx tsx src/diagnostics/completion-production-verification.run.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import type { Vec2 } from '@/lib/geometry';
import { getSupportedLetters } from '@/lib/letter-shapes';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { collectNeighborhoodShapeGraph, shapeKindFromWord } from '../generation/graph-shape-router';
import { snapSearchOrigin, searchOriginFromSnap } from '../generation/snap-search-origin';
import { getSearchRadiusForTargetDistance } from '../generation/search-radius';
import { isFeasible } from '../generation/shape-discovery';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { createCompletionAwareGoalSupport } from '../generation/completion-aware-goal';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, mirrorResultForState } from './graph-shape-goal-mirror';
import { routeQuality } from './goal-threshold-diagnostic';
import { analyzeStrokeTraversal, buildRoutePieces } from './z-diagonal-direction-diagnostic';
import { measureSubStrokeCoverage } from './z-checkpoint-repair-experiment';
import { createBeamTracer, pathOf, type StateRecord } from './beam-survival-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { evaluateTwoSidedGuard, type GuardQuality } from './goal-selection-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const MAX_PER_CASE = 10;
const same = (a: readonly Vec2[], b: readonly Vec2[]) => JSON.stringify(a) === JSON.stringify(b);

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}
function bitCount(v: number): number {
  let c = 0;
  let b = v >>> 0;
  while (b) {
    c += b & 1;
    b >>>= 1;
  }
  return c;
}

type Q = GuardQuality & { finalInOrder: boolean; pipelineFeasible: boolean; shapeScore: number };

/** Independent trace-based reimplementation of the validated C + nine-guard pick (as in completion-guarded-validation.run.ts). */
function expectedPick(word: string, target: Vec2[], graph: ShapeGraph): { path: Vec2[]; changed: boolean; accepted: boolean | null; reasons: string[]; prod: Q; cand: Q } {
  const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
  const finalB = boundaries[boundaries.length - 1]!;
  const window = { label: finalB.letter, start: finalB.projectedStartProgress, end: finalB.projectedEndProgress };
  const kind = shapeKindFromWord(word);
  const loop = isClosedTarget(target);
  const { observer, trace } = createBeamTracer();
  const mirror = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
  const cache = new Map<number, { q: Q; path: Vec2[] }>();
  const evalRec = (rec: StateRecord) => {
    let hit = cache.get(rec.id);
    if (!hit) {
      const res = mirrorResultForState(rec.state, trace.directed, target, kind, loop, mirror.regions, mirror.search);
      const rq = routeQuality(word, target, res.pathPoints, res.failure)!;
      const phys = evaluatePhysicalWordTraversal(word, target, res.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
      const fl = phys.letters[phys.letters.length - 1]!;
      const trav = analyzeStrokeTraversal(buildRoutePieces(res.pathPoints, target), target, window);
      hit = {
        path: res.pathPoints,
        q: {
          shapeScore: rq.shapeScore,
          targetCoverage: res.metrics.targetCoverage,
          backtracking: rq.backtracking,
          routeTarget: rq.routeTarget,
          feasible: rq.feasible,
          wordTraversalPhysical: phys.wordTraversalPhysical,
          continuityValid: rq.continuityValid,
          letters: phys.letters.map((l) => ({ physicallyCovered: l.physicallyCovered, coverage: l.coverage, rawInk: l.rawInkCoverage })),
          finalInOrder: fl.physicallyCovered && trav.category === 'A_correct',
          pipelineFeasible: isFeasible(res),
        },
      };
      cache.set(rec.id, hit);
    }
    return hit;
  };
  const inked = (r: StateRecord) => {
    const p = pathOf(r.state, trace.directed);
    return p.length >= 2 && measureSubStrokeCoverage(p, target, [{ label: 'f', start: window.start, end: window.end }])[0]!.occupancy >= PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold;
  };
  const cov = (r: StateRecord) => bitCount(r.state.covered) / GRAPH_SHAPE.progressBins;
  const complete = (r: StateRecord) => inked(r) && evalRec(r).q.finalInOrder;
  const realGoal = (r: StateRecord) => cov(r) >= GRAPH_SHAPE.goalCoverage && r.state.progress >= GRAPH_SHAPE.goalProgress;
  const goals = trace.records.filter((r) => r.isGoal);
  const expanded = trace.records.filter((r) => (r.fate === 'survived' || r.fate === 'start') && r.expanded && !r.isGoal);
  const finalBeam = trace.unexpandedAtCap.map((id) => trace.records[id]!);
  const aRule = [...expanded, ...finalBeam].filter((r) => !realGoal(r) && cov(r) >= GRAPH_SHAPE.goalCoverage && complete(r));
  const bRule = finalBeam.filter(realGoal);
  const pool = [...new Set([...goals, ...bRule, ...aRule])].sort((a, b) => a.state.cost - b.state.cost || a.id - b.id);
  const prodRec = trace.byState.get(trace.finish!.best!)!;
  let pick: StateRecord | null = null;
  for (const r of pool) {
    if (complete(r)) {
      pick = r;
      break;
    }
  }
  pick = pick ?? pool[0] ?? prodRec;
  const prod = evalRec(prodRec);
  if (pick === prodRec) return { path: prod.path, changed: false, accepted: null, reasons: [], prod: prod.q, cand: prod.q };
  const cand = evalRec(pick);
  const g = evaluateTwoSidedGuard(prod.q, cand.q, { continuityRule: 'no_valid_to_invalid' });
  return { path: g.accepted ? cand.path : prod.path, changed: true, accepted: g.accepted, reasons: g.rejectionReasons, prod: prod.q, cand: cand.q };
}

type Row = { corpus: string; key: string; validated: boolean; oldFeasible: boolean; newFeasible: boolean; changed: boolean; expectedMatch: boolean | null; expectedAccepted: boolean | null; reasons: string[]; msWithout: number; msWith: number; prodQ?: Q; newQ?: Q };

async function main() {
  const started = Date.now();
  const rows: Row[] = [];
  const handle = (corpus: string, word: string, caseLabel: string, record: FeasibilityRecord, validated: boolean) => {
    const target = record.target;
    const graph = reconstructGraph(record.graphLines);
    const kind = shapeKindFromWord(word);
    // Old production = parity-proven mirror with no hook; also time the production function with and without the hook.
    const old = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true });
    const t0 = performance.now();
    routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
    const t1 = performance.now();
    const withHook = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true, completionAware: createCompletionAwareGoalSupport({ word, target, geometryVariant: 'smooth' }) });
    const t2 = performance.now();
    const changed = !same(record.pathPoints, old.pathPoints);
    const row: Row = { corpus, key: `${word}|${caseLabel}|${record.placementId}`, validated, oldFeasible: isFeasible(old), newFeasible: record.feasible, changed, expectedMatch: null, expectedAccepted: null, reasons: [], msWithout: t1 - t0, msWith: t2 - t1 };
    if (!same(withHook.pathPoints, record.pathPoints)) throw new Error(`pipeline record differs from a direct production call for ${row.key}`);
    if (validated || changed) {
      const exp = expectedPick(word, target, graph);
      row.expectedMatch = same(exp.path, record.pathPoints);
      row.expectedAccepted = exp.changed ? exp.accepted : null;
      row.reasons = exp.reasons;
      row.prodQ = exp.prod;
      row.newQ = row.expectedMatch && exp.accepted ? exp.cand : exp.prod;
    }
    rows.push(row);
  };

  for (const tc of [
    { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
    { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  ]) {
    const caseLabel = `${tc.locationName}/${tc.targetDistanceMeters}`;
    const originSnap = await snapSearchOrigin(tc.start);
    const collection = await collectNeighborhoodShapeGraph(searchOriginFromSnap(originSnap), { radiusMeters: getSearchRadiusForTargetDistance(tc.targetDistanceMeters) });
    for (const letter of getSupportedLetters()) {
      const word = `I${letter}`;
      const report = await runExperimentalPipelineMultiVariant({ word, start: tc.start, targetDistanceMeters: tc.targetDistanceMeters }, ['smooth'], { collection, searchOriginSnap: originSnap });
      let validatedCount = 0;
      for (const record of report.diagnostics.feasibility ?? []) {
        if (record.pathPoints.length < 2 && !record.feasible) continue;
        const graph = reconstructGraph(record.graphLines);
        const oldFeasible = isFeasible(routeGraphConstrainedShapeMirror({ target: record.target, graph, kind: shapeKindFromWord(word), multiLetter: true }));
        const validated = oldFeasible && validatedCount < MAX_PER_CASE;
        if (validated) validatedCount += 1;
        handle('I+X', word, caseLabel, record, validated);
      }
    }
    console.log(`[I+X] ${caseLabel} done (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  for (const word of ['ROBZ', 'CAIRO']) {
    for (const tc of [
      { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
      { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
      { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
      { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
    ]) {
      const caseLabel = `${tc.locationName}/${tc.targetDistanceMeters}`;
      const report = await runExperimentalPipelineMultiVariant({ word, start: tc.start, targetDistanceMeters: tc.targetDistanceMeters }, ['smooth']);
      for (const record of report.diagnostics.feasibility ?? []) {
        if (record.pathPoints.length < 2 && !record.feasible) continue;
        const oldFeasible = isFeasible(routeGraphConstrainedShapeMirror({ target: record.target, graph: reconstructGraph(record.graphLines), kind: shapeKindFromWord(word), multiLetter: true }));
        handle('Z/O', word, caseLabel, record, oldFeasible);
      }
    }
    console.log(`[Z/O] ${word} done (${Math.round((Date.now() - started) / 1000)}s)`);
  }

  // ------------------------------------------------------------------ report
  const validation = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'completion-guarded-validation-results.json'), 'utf8')) as { rows: Array<{ key: string; prod: { stateId: number }; variants: Record<string, { stateId: number }> }> };
  const valKeys = new Set(validation.rows.map((r) => r.key));
  const valChanged = new Map(validation.rows.map((r) => [r.key, r.variants['C+9guards']!.stateId !== r.prod.stateId]));
  const validatedRows = rows.filter((r) => r.validated);
  console.log('');
  console.log(`=== VERIFICATION === placements in pools: ${rows.length}; validated set: ${validatedRows.length} (validation JSON: ${valKeys.size}; same keys: ${validatedRows.every((r) => valKeys.has(r.key)) && validatedRows.length === valKeys.size})`);
  console.log(`  validated placements where NEW production == independently recomputed C+9guards pick: ${validatedRows.filter((r) => r.expectedMatch).length}/${validatedRows.length}`);
  console.log(`  validated placements whose changed/unchanged status matches the validation run: ${validatedRows.filter((r) => valChanged.get(r.key) === r.changed).length}/${validatedRows.length}`);
  const changedAll = rows.filter((r) => r.changed);
  console.log(`  all pool placements changed vs old production: ${changedAll.length}; every change equals an expected guard-accepted pick: ${changedAll.every((r) => r.expectedMatch === true && r.expectedAccepted === true)}`);
  const nonValChanged = changedAll.filter((r) => !r.validated);
  console.log(`  changes outside the validated set: ${nonValChanged.length}${nonValChanged.map((r) => ` [${r.key} oldFeasible=${r.oldFeasible} newFeasible=${r.newFeasible}]`).join('')}`);
  console.log(`  pool feasibility: old feasible ${rows.filter((r) => r.oldFeasible).length} → new feasible ${rows.filter((r) => r.newFeasible).length}; lost ${rows.filter((r) => r.oldFeasible && !r.newFeasible).length}; gained ${rows.filter((r) => !r.oldFeasible && r.newFeasible).length}`);

  const metrics = (label: string, rs: Row[]) => {
    const m = (sel: (q: Q) => boolean, which: 'prodQ' | 'newQ') => rs.filter((r) => r[which] && sel(r[which]!)).length;
    const earlierLost = rs.filter((r) => r.prodQ && r.newQ && r.prodQ.letters.slice(0, -1).some((l, i) => l.physicallyCovered && !r.newQ!.letters[i]!.physicallyCovered)).length;
    const worse = rs.filter((r) => r.changed && r.prodQ && r.newQ && (r.prodQ.shapeScore - r.newQ.shapeScore > 0.03 || r.prodQ.targetCoverage - r.newQ.targetCoverage > 0.05)).length;
    console.log(`  ${label}: in-order final ${m((q) => q.finalInOrder, 'prodQ')} → ${m((q) => q.finalInOrder, 'newQ')}; whole word ${m((q) => q.wordTraversalPhysical, 'prodQ')} → ${m((q) => q.wordTraversalPhysical, 'newQ')}; pipeline-feasible ${m((q) => q.pipelineFeasible, 'prodQ')} → ${m((q) => q.pipelineFeasible, 'newQ')}; earlier-letter losses ${earlierLost}; clearly-worse accepted ${worse}; changed ${rs.filter((r) => r.changed).length}`);
  };
  console.log('');
  console.log('=== BEFORE → AFTER (validated set, production) ===');
  metrics('I+X', validatedRows.filter((r) => r.corpus === 'I+X'));
  metrics('Z/O', validatedRows.filter((r) => r.corpus === 'Z/O'));

  console.log('');
  console.log('=== KNOWN CASES ===');
  const known: Array<[string, string, boolean]> = [
    ['IP', 'IP|Alexandria/2000|sf-r225-s0.8-e282.8-n282.8', true],
    ['IR', 'IR|Alexandria/2000|sf-r225-s1.0-e282.8-n282.8', true],
    ['IN Zamalek', 'IN|Zamalek/2000|sf-r67.5-s0.8-e-282.8-n-282.8', true],
    ['IN Alexandria', 'IN|Alexandria/2000|sf-r90-s1.2-e0-n-400', false],
    ['IV', 'IV|Alexandria/2000|sf-r112.5-s0.6-e0-n-400', false],
    ['IU', 'IU|Alexandria/2000|sf-r112.5-s0.6-e0-n-400', false],
    ['IZ', 'IZ|Zamalek/2000|sf-r112.5-s1.4-e0-n-800', false],
    ['CAIRO Zamalek backtracking', 'CAIRO|Zamalek/2000|sf-r337.5-s0.8-e800-n0', false],
  ];
  for (const [label, key, shouldChange] of known) {
    const r = rows.find((x) => x.key === key);
    console.log(`  ${label}: ${r ? `${r.changed ? 'CHANGED (accepted)' : 'unchanged (rejected → production route)'} — expected ${shouldChange ? 'accepted' : 'rejected'} → ${r.changed === shouldChange ? 'OK' : 'MISMATCH'}${r.reasons.length ? ` [guards: ${r.reasons.join('+')}]` : ''}` : 'not found'}`);
  }
  const zoAccepted = validatedRows.filter((r) => r.corpus === 'Z/O' && r.changed);
  console.log(`  ROBZ completion cases accepted: ${zoAccepted.filter((r) => r.key.startsWith('ROBZ')).length}; CAIRO completion cases accepted: ${zoAccepted.filter((r) => r.key.startsWith('CAIRO')).length}`);
  const cosmetic = ['IW|Alexandria/2000|sf-r112.5-s0.8-e0-n-400', 'ROBZ|Alexandria/2000|sf-r315-s0.8-e0-n-400'];
  for (const k of cosmetic) {
    const r = rows.find((x) => x.key === k);
    console.log(`  cosmetic-completion case ${k}: ${r?.changed ? `accepted — shape ${r.prodQ?.shapeScore.toFixed(3)}→${r.newQ?.shapeScore.toFixed(3)}, target cov ${r.prodQ?.targetCoverage.toFixed(3)}→${r.newQ?.targetCoverage.toFixed(3)}, earlier letters kept ${r.prodQ?.letters.slice(0, -1).every((l, i) => !l.physicallyCovered || r.newQ?.letters[i]?.physicallyCovered)}` : 'not changed'}`);
  }

  console.log('');
  const ms = (sel: (r: Row) => number) => rows.reduce((s, r) => s + sel(r), 0) / rows.length;
  console.log(`=== RUNTIME === routeGraphConstrainedShape mean ${ms((r) => r.msWithout).toFixed(1)}ms without hook → ${ms((r) => r.msWith).toFixed(1)}ms with hook (max ${Math.max(...rows.map((r) => r.msWith)).toFixed(0)}ms) over ${rows.length} searches`);
  writeFileSync(resolve(DIAGNOSTIC_DIR, 'completion-production-verification-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), 'utf8');
  console.log(`[completion-production-verification] done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
