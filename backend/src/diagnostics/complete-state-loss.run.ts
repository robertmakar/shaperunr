/**
 * DEVELOPMENT ONLY. Why does production not return the in-order, physically
 * complete final-letter states that already exist (170m collection)? Traces
 * the 14 placements flagged by collection-radius-corpus.run.ts (5 Z, 9 O)
 * with the read-only beam tracer, on the exact production search.
 * No production file is modified; graph-shape.ts is untouched; beam, cap,
 * radius, weights and selector are unchanged.
 *
 * Run with: npx tsx src/diagnostics/complete-state-loss.run.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { isFeasible } from '../generation/shape-discovery';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, mirrorResultForState } from './graph-shape-goal-mirror';
import { routeQuality } from './goal-threshold-diagnostic';
import { analyzeStrokeTraversal, buildRoutePieces } from './z-diagonal-direction-diagnostic';
import { measureSubStrokeCoverage } from './z-checkpoint-repair-experiment';
import { createBeamTracer, pathOf, ancestry, decomposeCost, type StateRecord, type Trace } from './beam-survival-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const STARTS: Record<string, typeof ZAMALEK> = { Alexandria: ALEXANDRIA, Zamalek: ZAMALEK };
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));

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

type Eval = {
  rec: StateRecord;
  progress: number;
  cost: number;
  searchCoverage: number;
  isGoal: boolean;
  shapeScore: number;
  targetCoverage: number;
  routeTarget: number;
  heading: number;
  backtracking: number;
  finalCoverage: number;
  finalRawInk: number;
  finalPhysical: boolean;
  finalCategory: string;
  inOrder: boolean;
  feasible: boolean;
  failure: string | null;
  lengthMeters: number;
};

type Classification = 'A_never_goal' | 'B_goal_loses_selection' | 'C_beam_truncation' | 'D_deduplication' | 'E_feasible_rejected_by_other' | 'F_other';

async function main() {
  const corpus = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'collection-radius-corpus-results.json'), 'utf8')) as { rows: Array<{ word: string; caseLabel: string; placementId: string; r170: { inOrderCompleteInAnyBeamState: boolean } }> };
  const selected = corpus.rows.filter((r) => r.r170.inOrderCompleteInAnyBeamState);
  console.log(`=== CORPUS === ${selected.length} placements (Z ${selected.filter((r) => r.word === 'ROBZ').length}, O ${selected.filter((r) => r.word === 'CAIRO').length}) from collection-radius-corpus-results.json`);

  const reports = new Map<string, FeasibilityRecord[]>();
  const results: Array<Record<string, unknown>> = [];
  const classCounts: Record<string, number> = {};

  for (const sel of selected) {
    const [loc, dist] = sel.caseLabel.split('/') as [string, string];
    const key = `${sel.word}|${sel.caseLabel}`;
    if (!reports.has(key)) {
      const rep = await runExperimentalPipelineMultiVariant({ word: sel.word, start: STARTS[loc]!, targetDistanceMeters: Number(dist) }, ['smooth']);
      reports.set(key, (rep.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2));
    }
    const record = reports.get(key)!.find((r) => r.placementId === sel.placementId);
    if (!record) {
      console.log(`  ${key} ${sel.placementId}: not found`);
      continue;
    }
    const word = sel.word;
    const target = record.target;
    const graph = reconstructGraph(record.graphLines);
    const kind = shapeKindFromWord(word);
    const loop = isClosedTarget(target);
    const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
    const finalB: LetterBoundary = boundaries[boundaries.length - 1]!;
    const window = { label: finalB.letter, start: finalB.projectedStartProgress, end: finalB.projectedEndProgress };

    const production = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
    const { observer, trace } = createBeamTracer();
    const mirror = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
    const parity = JSON.stringify(mirror.pathPoints) === JSON.stringify(production.pathPoints) && JSON.stringify(production.pathPoints) === JSON.stringify(record.pathPoints) && mirror.search.statesExplored === production.search.statesExplored;

    const evaluate = (rec: StateRecord): Eval => {
      const res = mirrorResultForState(rec.state, trace.directed, target, kind, loop, mirror.regions, mirror.search);
      const q = routeQuality(word, target, res.pathPoints, res.failure)!;
      const phys = evaluatePhysicalWordTraversal(word, target, res.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
      const fl = phys.letters[phys.letters.length - 1]!;
      const trav = analyzeStrokeTraversal(buildRoutePieces(res.pathPoints, target), target, window);
      return {
        rec,
        progress: rec.state.progress,
        cost: rec.state.cost,
        searchCoverage: bitCount(rec.state.covered) / GRAPH_SHAPE.progressBins,
        isGoal: rec.isGoal,
        shapeScore: q.shapeScore,
        targetCoverage: res.metrics.targetCoverage,
        routeTarget: q.routeTarget,
        heading: res.metrics.headingAgreement,
        backtracking: res.metrics.backtracking,
        finalCoverage: fl.coverage,
        finalRawInk: fl.rawInkCoverage,
        finalPhysical: fl.physicallyCovered,
        finalCategory: trav.category,
        inOrder: fl.physicallyCovered && trav.category === 'A_correct',
        feasible: isFeasible(res),
        failure: res.failure,
        lengthMeters: polylineLength(res.pathPoints),
      };
    };

    // Every record whose final-letter ink qualifies (no cap), across ALL fates.
    const inkOf = (rec: StateRecord) => {
      const p = pathOf(rec.state, trace.directed);
      return p.length >= 2 ? measureSubStrokeCoverage(p, target, [{ label: 'f', start: window.start, end: window.end }])[0]!.occupancy : 0;
    };
    const inked = trace.records.filter((r) => inkOf(r) >= PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold);
    const evaluated = inked.map(evaluate);
    const complete = evaluated.filter((e) => e.inOrder);
    const inBeam = (r: StateRecord) => r.fate === 'survived' || r.fate === 'start';
    const completeBeam = complete.filter((e) => inBeam(e.rec));
    const completeTrunc = complete.filter((e) => e.rec.fate === 'truncated');
    const completeDedup = complete.filter((e) => e.rec.fate === 'dedupe_rejected');
    const returnedRec = trace.byState.get(trace.finish!.best!)!;
    const ret = evaluate(returnedRec);
    const goals = trace.records.filter((r) => r.isGoal).sort((a, b) => a.state.cost - b.state.cost);

    // Best complete state: goal first, then feasible, then lowest cost (beam states first; else truncated/deduped).
    const rank = (a: Eval, b: Eval) => Number(b.isGoal) - Number(a.isGoal) || Number(b.feasible) - Number(a.feasible) || a.cost - b.cost;
    const best = [...completeBeam].sort(rank)[0] ?? [...completeTrunc, ...completeDedup].sort(rank)[0];

    let cls: Classification = 'F_other';
    let why = '';
    if (!best) {
      cls = 'F_other';
      why = 'no in-order complete state found on re-trace';
    } else if (inBeam(best.rec) && best.isGoal) {
      const goalRank = goals.findIndex((g) => g === best.rec) + 1;
      cls = best.feasible ? 'B_goal_loses_selection' : 'B_goal_loses_selection';
      why = `goal-pool rank ${goalRank}/${goals.length} by cost; returned (rank 1) is cheaper by ${f(best.cost - ret.cost, 1)}`;
    } else if (inBeam(best.rec) && !best.rec.expanded && best.searchCoverage >= GRAPH_SHAPE.goalCoverage && best.progress >= GRAPH_SHAPE.goalProgress) {
      // Goal-eligible, but the real search only goal-checks a state when it EXPANDS its beam; the cap ended the search first.
      cls = 'F_other';
      why = `goal-ELIGIBLE (coverage ${f(best.searchCoverage, 3)} ≥ ${GRAPH_SHAPE.goalCoverage}, progress ${f(best.progress)} ≥ ${GRAPH_SHAPE.goalProgress}) but never goal-checked: it sits in beam L${best.rec.createdInLayer + 1}, which the search never expanded (finish=${trace.finish!.reason}); goals are only checked for expanded beam states`;
    } else if (inBeam(best.rec)) {
      cls = 'A_never_goal';
      const covOk = best.searchCoverage >= GRAPH_SHAPE.goalCoverage;
      const progOk = best.progress >= GRAPH_SHAPE.goalProgress;
      why = `goal predicate: coverage ${f(best.searchCoverage, 3)} ${covOk ? '≥' : '<'} ${GRAPH_SHAPE.goalCoverage}${covOk ? ' (ok)' : ' (FAILS)'}; progress ${f(best.progress)} ${progOk ? '≥' : '<'} ${GRAPH_SHAPE.goalProgress}${progOk ? ' (ok)' : ' (FAILS)'}`;
    } else if (best.rec.fate === 'truncated') {
      cls = 'C_beam_truncation';
      why = `rank ${best.rec.truncationRank}/${best.rec.truncationListSize}, cost ${f(best.cost, 1)} vs cutoff ${f(best.rec.truncationCutoffCost, 1)}`;
    } else {
      cls = 'D_deduplication';
      why = `lost key ${best.rec.dedupeKey} to #${best.rec.dedupeHolderId} (held cost ${f(best.rec.dedupePreviousCost, 1)})`;
    }
    classCounts[`${word}:${cls}`] = (classCounts[`${word}:${cls}`] ?? 0) + 1;

    const line = (label: string, e: Eval) =>
      `    ${label.padEnd(9)} #${e.rec.id} L${e.rec.createdInLayer + 1} ${e.rec.fate}${e.isGoal ? '+GOAL' : ''} prog=${f(e.progress)} searchCov=${f(e.searchCoverage, 2)} cost=${f(e.cost, 1)} shape=${f(e.shapeScore)} tgtCov=${f(e.targetCoverage)} route/tgt=${f(e.routeTarget)} heading=${f(e.heading)} backtr=${f(e.backtracking)} final ${finalB.letter}: cov=${f(e.finalCoverage)} ink=${f(e.finalRawInk, 2)} phys=${e.finalPhysical} traversal=${e.finalCategory} | feasible=${e.feasible}${e.failure ? `(${e.failure})` : ''} len=${f(e.lengthMeters, 0)}m`;
    console.log('');
    console.log(`--- ${word} ${sel.caseLabel} ${sel.placementId} (parity=${parity}, finish=${trace.finish!.reason}, goals=${goals.length}) → ${cls}: ${why}`);
    console.log(`    in-order complete states: beam=${completeBeam.length} (goals ${completeBeam.filter((e) => e.isGoal).length}) truncated=${completeTrunc.length} deduped=${completeDedup.length}; returned state in-order complete=${ret.inOrder}`);
    if (best) console.log(line('COMPLETE', best));
    console.log(line('RETURNED', ret));
    if (best) {
      // Survival to the final beam: the state itself, or any descendant.
      const finalBeamLayer = Math.max(...trace.records.filter(inBeam).map((r) => r.createdInLayer + 1));
      const descendantInFinal = trace.records.some((r) => inBeam(r) && r.createdInLayer + 1 === finalBeamLayer && ancestry(trace, r).includes(best.rec));
      console.log(`    survival: state in beam L${best.rec.createdInLayer + 1}, final beam L${finalBeamLayer}; expanded=${best.rec.expanded}; a descendant reaches the final beam=${descendantInFinal}`);
      // Ancestry comparison.
      const ca = ancestry(trace, best.rec);
      const ra = ancestry(trace, returnedRec);
      let k = 0;
      while (k < ca.length && k < ra.length && ca[k]!.id === ra[k]!.id) k += 1;
      const dC = decomposeCost(trace, best.rec, polylineLength(target), loop, kind, mirror.regions);
      const dR = decomposeCost(trace, returnedRec, polylineLength(target), loop, kind, mirror.regions);
      const diff = Object.entries(dC.terms).map(([t, v]) => [t, v - (dR.terms as Record<string, number>)[t]!] as const).filter(([, v]) => Math.abs(v) > 0.05).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      console.log(`    ancestry: shared prefix ${k} step(s)${k ? ` (diverge after #${ca[k - 1]!.id}, prog ${f(ca[k - 1]!.state.progress)}, beam L${ca[k - 1]!.createdInLayer + 1})` : ' (different start edges)'}; complete adds ${ca.length - k} steps / returned adds ${ra.length - k} steps after divergence; cost replay matches: ${dC.matches && dR.matches}`);
      console.log(`    cost(complete) − cost(returned) = ${f(dC.total - dR.total, 1)} :: ${diff.map(([t, v]) => `${t}=${v >= 0 ? '+' : ''}${f(v, 1)}`).join(' ')}`);
      const steps = (chain: StateRecord[], from: number) =>
        chain
          .slice(from)
          .map((r) => `${r.edgeId}:+${f(r.stepCost, 1)}@${f(r.state.progress, 2)}`)
          .join(' ');
      console.log(`    complete branch steps: ${steps(ca, k)}`);
      console.log(`    returned branch steps: ${steps(ra, k)}`);
      results.push({ word, caseLabel: sel.caseLabel, placementId: sel.placementId, parity, classification: cls, why, complete: { ...best, rec: undefined, id: best.rec.id, fate: best.rec.fate }, returned: { ...ret, rec: undefined, id: returnedRec.id }, costDelta: dC.total - dR.total, termDelta: Object.fromEntries(diff), counts: { completeBeam: completeBeam.length, completeGoals: completeBeam.filter((e) => e.isGoal).length, truncated: completeTrunc.length, deduped: completeDedup.length } });
    }
  }

  console.log('');
  console.log(`=== CLASSIFICATION === ${JSON.stringify(classCounts)}`);
  const all = results as Array<{ classification: string; complete: Eval; returned: Eval; costDelta: number; termDelta: Record<string, number> }>;
  const agg = (cls: string) => {
    const xs = all.filter((r) => r.classification === cls);
    if (!xs.length) return;
    const m = (sel: (r: (typeof xs)[number]) => number) => f(xs.reduce((s, r) => s + sel(r), 0) / xs.length);
    const terms: Record<string, number> = {};
    for (const r of xs) for (const [t, v] of Object.entries(r.termDelta)) terms[t] = (terms[t] ?? 0) + v / xs.length;
    console.log(`  ${cls} (n=${xs.length}): mean complete−returned: cost ${m((r) => r.costDelta)} shape ${m((r) => r.complete.shapeScore - r.returned.shapeScore)} tgtCov ${m((r) => r.complete.targetCoverage - r.returned.targetCoverage)} route/tgt ${m((r) => r.complete.routeTarget - r.returned.routeTarget)} heading ${m((r) => r.complete.heading - r.returned.heading)} final cov ${m((r) => r.complete.finalCoverage - r.returned.finalCoverage)}; complete feasible ${xs.filter((r) => r.complete.feasible).length}/${xs.length}; mean term deltas ${Object.entries(terms).filter(([, v]) => Math.abs(v) > 0.5).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([t, v]) => `${t}=${v >= 0 ? '+' : ''}${f(v, 1)}`).join(' ')}`);
  };
  for (const c of ['A_never_goal', 'B_goal_loses_selection', 'C_beam_truncation', 'D_deduplication', 'E_feasible_rejected_by_other', 'F_other']) agg(c);
  writeFileSync(resolve(DIAGNOSTIC_DIR, 'complete-state-loss-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
