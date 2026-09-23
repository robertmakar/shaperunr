/**
 * DEVELOPMENT ONLY. Final pre-production validation of GUARDED completion-
 * aware goal logic: counterfactual C (completion-aware selection +
 * completion-aware eligibility + final-beam goal checking) with the existing
 * nine-guard fallback applied to C's pick (evaluateTwoSidedGuard, thresholds
 * unchanged, continuity rule 'no_valid_to_invalid'). If any guard rejects the
 * pick, the production route is returned.
 *
 * Corpora: (1) the 175-placement I+X corpus of completion-generalization.run.ts
 * (Alexandria/2000 + Zamalek/2000, injected 170m collection, ≤10 feasible per
 * word/case); (2) the 78-placement ROBZ/CAIRO Z/O corpus (production pipeline).
 * One traced production search per placement (parity- and independence-
 * checked); every variant is post-search. No production file is modified.
 *
 * Run with: npx tsx src/diagnostics/completion-guarded-validation.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';
import { getSupportedLetters } from '@/lib/letter-shapes';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { collectNeighborhoodShapeGraph, shapeKindFromWord } from '../generation/graph-shape-router';
import { snapSearchOrigin, searchOriginFromSnap } from '../generation/snap-search-origin';
import { getSearchRadiusForTargetDistance } from '../generation/search-radius';
import { isFeasible } from '../generation/shape-discovery';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, mirrorResultForState } from './graph-shape-goal-mirror';
import { routeQuality } from './goal-threshold-diagnostic';
import { analyzeStrokeTraversal, buildRoutePieces } from './z-diagonal-direction-diagnostic';
import { measureSubStrokeCoverage } from './z-checkpoint-repair-experiment';
import { createBeamTracer, pathOf, type StateRecord } from './beam-survival-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { evaluateTwoSidedGuard, type GuardQuality, type TwoSidedGuardResult } from './goal-selection-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const MAX_PER_CASE = 10;
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const mean = (v: readonly number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : Number.NaN);
/** The 5 strong Rule-A wins from completion-generalization (word|case|placement). */
const STRONG_A = ['IN|Alexandria/2000|sf-r90-s1.2-e0-n-400', 'IP|Alexandria/2000|sf-r225-s0.8-e282.8-n282.8', 'IR|Alexandria/2000|sf-r225-s1.0-e282.8-n282.8', 'IV|Alexandria/2000|sf-r112.5-s0.6-e0-n-400', 'IN|Zamalek/2000|sf-r67.5-s0.8-e-282.8-n-282.8'];

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

type Source = 'production_goal' | 'A_rule' | 'B_final_beam';
type Snap = {
  stateId: number;
  source: Source;
  progress: number;
  searchCoverage: number;
  cost: number;
  pipelineFeasible: boolean;
  guardFeasible: boolean;
  shapeScore: number;
  targetCoverage: number;
  backtracking: number;
  routeTarget: number;
  continuityValid: boolean;
  finalCoverage: number;
  finalRawInk: number;
  finalPhysical: boolean;
  finalCategory: string;
  finalInOrder: boolean;
  wordPhysical: boolean;
  letters: Array<{ letter: string; physicallyCovered: boolean; coverage: number; rawInk: number }>;
  routeLengthMeters: number;
  heading: number;
};
type Row = { corpus: string; key: string; word: string; letter: string; caseLabel: string; placementId: string; parity: boolean; independent: boolean; prod: Snap; c: Snap; guard: TwoSidedGuardResult | null; variants: Record<string, Snap> };

function guardQuality(s: Snap): GuardQuality {
  return { shapeScore: s.shapeScore, targetCoverage: s.targetCoverage, backtracking: s.backtracking, routeTarget: s.routeTarget, feasible: s.guardFeasible, wordTraversalPhysical: s.wordPhysical, continuityValid: s.continuityValid, letters: s.letters };
}
const earlierLost = (p: Snap, c: Snap) => p.letters.slice(0, -1).some((l, i) => l.physicallyCovered && !c.letters[i]!.physicallyCovered) || (p.wordPhysical && !c.wordPhysical);

function evaluatePlacement(corpus: string, word: string, caseLabel: string, record: FeasibilityRecord): Row {
  const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
  const finalB = boundaries[boundaries.length - 1]!;
  const window = { label: finalB.letter, start: finalB.projectedStartProgress, end: finalB.projectedEndProgress };
  const target = record.target;
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const loop = isClosedTarget(target);
  const production = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
  const { observer, trace } = createBeamTracer();
  const mirror = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
  const parity = JSON.stringify(mirror.pathPoints) === JSON.stringify(production.pathPoints) && JSON.stringify(production.pathPoints) === JSON.stringify(record.pathPoints) && mirror.search.statesExplored === production.search.statesExplored;
  const { observer: o2, trace: t2 } = createBeamTracer();
  routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer: o2, goalCheck: () => false });
  const independent = t2.finish!.expansions === trace.finish!.expansions && t2.records.length === trace.records.length;

  const cache = new Map<number, Omit<Snap, 'source'>>();
  const snap = (rec: StateRecord, source: Source): Snap => {
    let s = cache.get(rec.id);
    if (!s) {
      const res = mirrorResultForState(rec.state, trace.directed, target, kind, loop, mirror.regions, mirror.search);
      const q = routeQuality(word, target, res.pathPoints, res.failure)!;
      const phys = evaluatePhysicalWordTraversal(word, target, res.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
      const fl = phys.letters[phys.letters.length - 1]!;
      const trav = analyzeStrokeTraversal(buildRoutePieces(res.pathPoints, target), target, window);
      s = {
        stateId: rec.id,
        progress: rec.state.progress,
        searchCoverage: bitCount(rec.state.covered) / GRAPH_SHAPE.progressBins,
        cost: rec.state.cost,
        pipelineFeasible: isFeasible(res),
        guardFeasible: q.feasible, // the guard set as-is: failure === null (routeQuality)
        shapeScore: q.shapeScore,
        targetCoverage: res.metrics.targetCoverage,
        backtracking: q.backtracking,
        routeTarget: q.routeTarget,
        continuityValid: q.continuityValid,
        finalCoverage: fl.coverage,
        finalRawInk: fl.rawInkCoverage,
        finalPhysical: fl.physicallyCovered,
        finalCategory: trav.category,
        finalInOrder: fl.physicallyCovered && trav.category === 'A_correct',
        wordPhysical: phys.wordTraversalPhysical,
        letters: phys.letters.map((l) => ({ letter: l.letter, physicallyCovered: l.physicallyCovered, coverage: l.coverage, rawInk: l.rawInkCoverage })),
        routeLengthMeters: polylineLength(res.pathPoints),
        heading: res.metrics.headingAgreement,
      };
      cache.set(rec.id, s);
    }
    return { ...s, source };
  };
  const inkOk = new Map<number, boolean>();
  const inked = (r: StateRecord) => {
    let v = inkOk.get(r.id);
    if (v === undefined) {
      const p = pathOf(r.state, trace.directed);
      v = p.length >= 2 && measureSubStrokeCoverage(p, target, [{ label: 'f', start: window.start, end: window.end }])[0]!.occupancy >= PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold;
      inkOk.set(r.id, v);
    }
    return v;
  };
  const cov = (r: StateRecord) => bitCount(r.state.covered) / GRAPH_SHAPE.progressBins;
  const completeInOrder = (r: StateRecord) => inked(r) && snap(r, 'production_goal').finalInOrder;
  const realGoal = (r: StateRecord) => cov(r) >= GRAPH_SHAPE.goalCoverage && r.state.progress >= GRAPH_SHAPE.goalProgress;

  const prodGoals = trace.records.filter((r) => r.isGoal);
  const expanded = trace.records.filter((r) => (r.fate === 'survived' || r.fate === 'start') && r.expanded && !r.isGoal);
  const finalBeam = trace.unexpandedAtCap.map((id) => trace.records[id]!);
  const aRule = [...expanded, ...finalBeam].filter((r) => !realGoal(r) && cov(r) >= GRAPH_SHAPE.goalCoverage && completeInOrder(r));
  const bRule = finalBeam.filter(realGoal);
  const source = new Map<number, Source>();
  for (const r of prodGoals) source.set(r.id, 'production_goal');
  for (const r of bRule) if (!source.has(r.id)) source.set(r.id, 'B_final_beam');
  for (const r of aRule) if (!source.has(r.id)) source.set(r.id, 'A_rule');
  const pool = [...new Set([...prodGoals, ...bRule, ...aRule])].sort((a, b) => a.state.cost - b.state.cost || a.id - b.id);
  const prodRec = trace.byState.get(trace.finish!.best!)!;
  const prod = snap(prodRec, 'production_goal');
  let c: Snap | null = null;
  for (const r of pool) {
    if (completeInOrder(r)) {
      c = snap(r, source.get(r.id)!);
      break;
    }
  }
  if (!c) c = snap(pool[0] ?? prodRec, pool[0] ? source.get(pool[0].id)! : 'production_goal');
  const changed = c.stateId !== prod.stateId;
  const guard = changed ? evaluateTwoSidedGuard(guardQuality(prod), guardQuality(c), { continuityRule: 'no_valid_to_invalid' }) : null;
  const variants: Record<string, Snap> = {
    PROD: prod,
    C: c,
    'C+feas': changed && !c.pipelineFeasible ? prod : c,
    'C+feas+earlier': changed && (!c.pipelineFeasible || earlierLost(prod, c)) ? prod : c,
    'C+9guards': changed && !guard!.accepted ? prod : c,
  };
  return { corpus, key: `${word}|${caseLabel}|${record.placementId}`, word, letter: finalB.letter, caseLabel, placementId: record.placementId, parity, independent, prod, c, guard, variants };
}

async function main() {
  const started = Date.now();
  const rows: Row[] = [];
  // Corpus 1: I+X (175).
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
      for (const record of (report.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2).slice(0, MAX_PER_CASE)) rows.push(evaluatePlacement('I+X', word, caseLabel, record));
    }
    console.log(`[I+X] ${caseLabel} done (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  // Corpus 2: ROBZ / CAIRO (78).
  for (const word of ['ROBZ', 'CAIRO']) {
    for (const tc of [
      { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
      { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
      { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
      { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
    ]) {
      const caseLabel = `${tc.locationName}/${tc.targetDistanceMeters}`;
      const report = await runExperimentalPipelineMultiVariant({ word, start: tc.start, targetDistanceMeters: tc.targetDistanceMeters }, ['smooth']);
      for (const record of (report.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2)) rows.push(evaluatePlacement('Z/O', word, caseLabel, record));
    }
    console.log(`[Z/O] ${word} done (${Math.round((Date.now() - started) / 1000)}s)`);
  }

  // ------------------------------------------------------------------ report
  console.log('');
  for (const corpus of ['I+X', 'Z/O']) {
    const rs = rows.filter((r) => r.corpus === corpus);
    console.log(`=== ${corpus} corpus (n=${rs.length}) — parity ${rs.filter((r) => r.parity).length}/${rs.length}, goal-logic independence ${rs.filter((r) => r.independent).length}/${rs.length} ===`);
    console.log('| variant | in-order final | physical final | whole word | feasible (isFeasible) | earlier-letter losses | clearly worse (shape −.03 / tgtCov −.05) | changed | mean shapeScore | mean target cov | mean final cov |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const v of ['PROD', 'C', 'C+feas', 'C+feas+earlier', 'C+9guards']) {
      const xs = rs.map((r) => ({ p: r.prod, s: r.variants[v]! }));
      const chg = xs.filter((x) => x.s.stateId !== x.p.stateId);
      console.log(`| ${v} | ${xs.filter((x) => x.s.finalInOrder).length} | ${xs.filter((x) => x.s.finalPhysical).length} | ${xs.filter((x) => x.s.wordPhysical).length} | ${xs.filter((x) => x.s.pipelineFeasible).length} | ${xs.filter((x) => earlierLost(x.p, x.s)).length} | ${chg.filter((x) => x.p.shapeScore - x.s.shapeScore > 0.03 || x.p.targetCoverage - x.s.targetCoverage > 0.05).length} | ${chg.length} | ${f(mean(xs.map((x) => x.s.shapeScore)))} | ${f(mean(xs.map((x) => x.s.targetCoverage)))} | ${f(mean(xs.map((x) => x.s.finalCoverage)))} |`);
    }
    console.log('');
  }

  console.log('=== EVERY CHANGED CANDIDATE (C differs from production) — nine-guard verdict ===');
  console.log('| corpus | word | placement | source | completion gained | prod: shape / tgtCov / finalCov / feasible / letters | cand: shape / tgtCov / finalCov / feasible / letters | guard | failed guards |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  const changed = rows.filter((r) => r.guard);
  const lettersStr = (s: Snap) => s.letters.map((l) => `${l.letter}${l.physicallyCovered ? '✓' : '·'}`).join('');
  for (const r of changed) {
    const p = r.prod;
    const c = r.c;
    console.log(`| ${r.corpus} | ${r.word} | ${r.caseLabel} ${r.placementId} | ${c.source} | ${c.finalInOrder && !p.finalInOrder ? 'yes' : 'no'} | ${f(p.shapeScore)} / ${f(p.targetCoverage)} / ${f(p.finalCoverage)} / ${p.pipelineFeasible} / ${lettersStr(p)} | ${f(c.shapeScore)} / ${f(c.targetCoverage)} / ${f(c.finalCoverage)} / ${c.pipelineFeasible} / ${lettersStr(c)} | ${r.guard!.accepted ? 'ACCEPTED' : 'rejected → PROD'} | ${r.guard!.rejectionReasons.join('+') || '-'} |`);
  }

  console.log('');
  console.log('=== BY SOURCE ===');
  for (const src of ['A_rule', 'production_goal', 'B_final_beam'] as Source[]) {
    const xs = changed.filter((r) => r.c.source === src);
    console.log(`  ${src === 'production_goal' ? 'selector (existing goal pool)' : src}: ${xs.length} changed; accepted ${xs.filter((r) => r.guard!.accepted).length}; rejected ${xs.filter((r) => !r.guard!.accepted).length}${xs.filter((r) => !r.guard!.accepted).map((r) => ` [${r.word} ${r.caseLabel} ${r.placementId}: ${r.guard!.rejectionReasons.join('+')}]`).join('')}`);
  }
  const multi = changed.filter((r) => r.guard!.rejectionReasons.length > 1);
  console.log(`  multiple guards fired: ${multi.length}${multi.map((r) => ` [${r.word} ${r.placementId}: ${r.guard!.rejectionReasons.join('+')}]`).join('')}`);

  console.log('');
  console.log('=== PRESERVATION CHECKS (C+9guards) ===');
  const g = (r: Row) => r.variants['C+9guards']!;
  for (const k of STRONG_A) {
    const r = rows.find((x) => x.key === k);
    console.log(`  strong Rule-A win ${k}: ${r ? (g(r).stateId === r.c.stateId && r.c.source === 'A_rule' ? `KEPT (shape ${f(r.prod.shapeScore)}→${f(g(r).shapeScore)})` : `LOST (guard: ${r.guard?.rejectionReasons.join('+') ?? 'n/a'})`) : 'not in corpus'}`);
  }
  const zo = rows.filter((r) => r.corpus === 'Z/O');
  const zoGain = (v: string) => zo.filter((r) => r.variants[v]!.finalInOrder && !r.prod.finalInOrder).length;
  console.log(`  Z/O in-order completions gained: C ${zoGain('C')} → C+9guards ${zoGain('C+9guards')} (lost by the guards: ${zo.filter((r) => r.c.finalInOrder && !r.prod.finalInOrder && !g(r).finalInOrder).map((r) => `${r.word} ${r.caseLabel} ${r.placementId} [${r.guard!.rejectionReasons.join('+')}]`).join('; ') || 'none'})`);
  const wordGain = (v: string) => rows.filter((r) => r.variants[v]!.wordPhysical && !r.prod.wordPhysical).length;
  console.log(`  whole-word gains: C ${wordGain('C')} → C+9guards ${wordGain('C+9guards')}; whole-word losses C+9guards: ${rows.filter((r) => r.prod.wordPhysical && !g(r).wordPhysical).length}`);
  console.log(`  earlier-letter losses C+9guards: ${rows.filter((r) => earlierLost(r.prod, g(r))).length}; pipeline-feasibility losses C+9guards: ${rows.filter((r) => r.prod.pipelineFeasible && !g(r).pipelineFeasible).length}${rows.filter((r) => r.prod.pipelineFeasible && !g(r).pipelineFeasible).map((r) => ` [${r.word} ${r.placementId}: guard-feasible ${g(r).guardFeasible}, heading ${f(g(r).heading)}]`).join('')}`);

  console.log('');
  console.log('=== COSMETIC-COMPLETION CHECK (accepted changes that gained completion) ===');
  const acceptedGains = changed.filter((r) => r.guard!.accepted && r.c.finalInOrder && !r.prod.finalInOrder);
  for (const r of acceptedGains) {
    const p = r.prod;
    const c = r.c;
    const flags = [c.shapeScore < p.shapeScore ? `shape −${f(p.shapeScore - c.shapeScore)}` : '', c.targetCoverage < p.targetCoverage ? `tgtCov −${f(p.targetCoverage - c.targetCoverage)}` : '', p.letters.slice(0, -1).some((l, i) => c.letters[i]!.coverage < l.coverage - 0.05) ? 'earlier-letter coverage −>0.05' : '', c.routeTarget < p.routeTarget - 0.05 ? 'route/target down' : ''].filter(Boolean).join(', ');
    console.log(`  ${r.word} ${r.caseLabel} ${r.placementId} (${c.source}): shape ${f(p.shapeScore)}→${f(c.shapeScore)} tgtCov ${f(p.targetCoverage)}→${f(c.targetCoverage)} final ${f(p.finalCoverage)}→${f(c.finalCoverage)} ${flags ? `⚠ ${flags}` : 'no degradation'}`);
  }
  console.log(`  accepted completion gains: ${acceptedGains.length}; with ANY shape or target-coverage decrease: ${acceptedGains.filter((r) => r.c.shapeScore < r.prod.shapeScore || r.c.targetCoverage < r.prod.targetCoverage).length}`);

  writeFileSync(resolve(DIAGNOSTIC_DIR, 'completion-guarded-validation-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), 'utf8');
  console.log('');
  console.log(`[completion-guarded-validation] done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
