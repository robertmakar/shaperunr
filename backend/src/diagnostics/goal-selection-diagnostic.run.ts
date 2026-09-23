/**
 * DEVELOPMENT ONLY. Goal-selection experiment over the SAME ROBZ + CAIRO
 * corpus as goal-threshold-diagnostic.run.ts. The production search runs
 * once per candidate (goal progress 0.88, all else unchanged); every
 * treatment returns a different member of that one goal pool. Nothing that
 * generates states is varied. graph-shape.ts is never touched.
 *
 * Run with: npx tsx src/diagnostics/goal-selection-diagnostic.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { scorePolylines } from '../scoring/shape-match';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, mirrorResultForState, computeLetterBinRanges } from './graph-shape-goal-mirror';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { routeQuality, finalLetterOf, type RouteQuality, type FinalLetter } from './goal-threshold-diagnostic';
import {
  SELECTORS,
  SELECTION_PARAMS,
  createGoalPoolObserver,
  selectGoal,
  poolStats,
  finalLetterProgress,
  classifyOutcome,
  finalLetterImproved,
  pathOfState,
  type SelectorName,
  type PoolStats,
  type Outcome,
  type ComparableQuality,
} from './goal-selection-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const CASES = [
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];
const ROBZ1 = { caseLabel: 'Zamalek/4000', placementId: 'sf-r315-s0.6-e-905.1-n905.1' };
const ROBZ2 = { caseLabel: 'Alexandria/2000', placementId: 'sf-r315-s0.8-e0-n-400' };
const CONTROLS: Record<string, Array<{ letter: string; index: number }>> = { ROBZ: [{ letter: 'R', index: 0 }], CAIRO: [{ letter: 'C', index: 0 }, { letter: 'I', index: 2 }] };
const POOL_SAMPLE = 24;

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}
const mean = (v: readonly number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : Number.NaN);
const median = (v: readonly number[]) => {
  if (!v.length) return Number.NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j += 1;
    for (let k = i; k <= j; k += 1) r[order[k]!.i] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function spearman(x: readonly number[], y: readonly number[]): number {
  if (x.length < 3) return Number.NaN;
  const rx = ranks(x);
  const ry = ranks(y);
  const mx = mean(rx);
  const my = mean(ry);
  let n = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    n += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx > 0 && dy > 0 ? n / Math.sqrt(dx * dy) : Number.NaN;
}

// ---------------------------------------------------------------------------

type Treatment = {
  selector: SelectorName;
  fellBack: boolean;
  noGoalPool: boolean;
  sameStateAsBaseline: boolean;
  statePosition: number | null;
  progress: number;
  cost: number;
  finalLetterProgress: number;
  failure: string | null;
  quality: RouteQuality;
  finalLetter: FinalLetter | null;
  routeDistanceMeters: number;
  outcome: Outcome;
  regressionFlags: string[];
};

type PoolAnalysis = { spearmanProgressCost: number; spearmanProgressShape: number; spearmanProgressFinalCov: number; sampled: number };

type CandidateRecord = {
  word: string;
  finalLetter: string;
  caseLabel: string;
  placementId: string;
  parity: { productionPath: boolean; productionStates: boolean; productionFailure: boolean; secondRunStates: boolean; secondRunPath: boolean };
  statesExplored: number;
  maxExpansionsHit: boolean;
  pool: PoolStats;
  poolAnalysis: PoolAnalysis | null;
  treatments: Treatment[];
};

function comparable(q: RouteQuality): ComparableQuality {
  return { shapeScore: q.shapeScore, targetCoverage: q.targetCoverage, backtracking: q.backtracking, routeTarget: q.routeTarget, feasible: q.feasible, wordTraversalPhysical: q.wordTraversalPhysical, letters: q.letters };
}

function analyzeCandidate(word: string, caseLabel: string, record: FeasibilityRecord): CandidateRecord | null {
  const target = record.target;
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const loop = isClosedTarget(target);
  const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
  const finalBoundary = boundaries[boundaries.length - 1]!;
  const finalLetterBins = computeLetterBinRanges(boundaries)[boundaries.length - 1]!;
  const ctx = { finalLetter: finalBoundary, finalLetterBins };

  const production = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
  const { observer, pool } = createGoalPoolObserver();
  const observed = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
  const second = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true });
  const p = pool();
  if (observed.pathPoints.length < 2) return null;

  const parity = {
    productionPath: JSON.stringify(observed.pathPoints) === JSON.stringify(production.pathPoints),
    productionStates: observed.search.statesExplored === production.search.statesExplored,
    productionFailure: observed.failure === production.failure,
    secondRunStates: second.search.statesExplored === observed.search.statesExplored,
    secondRunPath: JSON.stringify(second.pathPoints) === JSON.stringify(observed.pathPoints),
  };

  const evaluate = (state: NonNullable<typeof p.searchReturned>) => {
    const r = mirrorResultForState(state, p.directed, target, kind, loop, observed.regions, observed.search);
    const q = routeQuality(word, target, r.pathPoints, r.failure)!;
    q.targetCoverage = r.metrics.targetCoverage;
    return { r, q, fl: finalLetterOf(word, target, r.pathPoints, finalBoundary, q) };
  };

  const baseSel = p.goals.length ? selectGoal('BASELINE_COST', p.goals, ctx).entry!.state : p.searchReturned!;
  const base = evaluate(baseSel);
  // Selector parity on the real corpus: BASELINE_COST's state must be the search's own returned state and reproduce production's route.
  if (baseSel !== p.searchReturned || JSON.stringify(base.r.pathPoints) !== JSON.stringify(production.pathPoints)) parity.productionPath = false;

  const treatments: Treatment[] = SELECTORS.map((selector) => {
    const sel = p.goals.length ? selectGoal(selector, p.goals, ctx) : { entry: null, fellBack: false };
    const state = sel.entry?.state ?? p.searchReturned!;
    const e = state === baseSel ? base : evaluate(state);
    const same = state === baseSel;
    const { outcome, flags } = classifyOutcome(same, comparable(base.q), comparable(e.q));
    return {
      selector,
      fellBack: sel.fellBack,
      noGoalPool: p.goals.length === 0,
      sameStateAsBaseline: same,
      statePosition: sel.entry?.order ?? null,
      progress: state.progress,
      cost: state.cost,
      finalLetterProgress: finalLetterProgress(state, finalBoundary),
      failure: e.r.failure,
      quality: e.q,
      finalLetter: e.fl,
      routeDistanceMeters: polylineLength(e.r.pathPoints),
      outcome,
      regressionFlags: flags,
    };
  });

  // Goal-pool cost-function analysis: evenly sampled (by progress rank) goal states.
  let poolAnalysis: PoolAnalysis | null = null;
  if (p.goals.length >= 3) {
    const sorted = [...p.goals].sort((a, b) => a.state.progress - b.state.progress || a.order - b.order);
    const step = Math.max(1, sorted.length / POOL_SAMPLE);
    const sample = [] as typeof sorted;
    for (let i = 0; i < sorted.length && sample.length < POOL_SAMPLE; i += step) sample.push(sorted[Math.floor(i)]!);
    const rows = sample.map((g) => {
      const path = pathOfState(g.state, p.directed);
      const shape = path.length >= 2 ? scorePolylines(path, target).score : 0;
      const phys = path.length >= 2 ? evaluatePhysicalWordTraversal(word, target, path, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS) : null;
      return { progress: g.state.progress, cost: g.state.cost, shape, finalCov: phys?.letters[phys.letters.length - 1]?.coverage ?? 0 };
    });
    poolAnalysis = {
      spearmanProgressCost: spearman(rows.map((r) => r.progress), rows.map((r) => r.cost)),
      spearmanProgressShape: spearman(rows.map((r) => r.progress), rows.map((r) => r.shape)),
      spearmanProgressFinalCov: spearman(rows.map((r) => r.progress), rows.map((r) => r.finalCov)),
      sampled: rows.length,
    };
  }

  return {
    word,
    finalLetter: finalBoundary.letter,
    caseLabel,
    placementId: record.placementId,
    parity,
    statesExplored: observed.search.statesExplored,
    maxExpansionsHit: p.finishReason === 'max_expansions',
    pool: poolStats(p.goals),
    poolAnalysis,
    treatments,
  };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const tr = (c: CandidateRecord, s: SelectorName) => c.treatments.find((t) => t.selector === s)!;

function mainTable(label: string, cs: readonly CandidateRecord[]) {
  console.log(`  ${label} (n=${cs.length})`);
  console.log('    selector               finalEnd finalPhys finalCov mean/med   finalRawInk  finalProg(route) mean/med  shape mean/med   tgtCov   order  tSpan  backtr  route/tgt  feasible  wordPhys  fallbacks');
  for (const s of SELECTORS) {
    const ts = cs.map((c) => tr(c, s));
    const fl = ts.map((t) => t.finalLetter).filter((x): x is FinalLetter => Boolean(x));
    const fp = ts.map((t) => t.quality.routeFinalProgress ?? 0);
    console.log(
      `    ${s.padEnd(22)} ${String(fl.filter((l) => l.reachesEnd).length).padStart(5)}   ${String(fl.filter((l) => l.physicallyCovered).length).padStart(5)}    ${f(mean(fl.map((l) => l.coverage)))}/${f(median(fl.map((l) => l.coverage)))}   ${f(mean(fl.map((l) => l.rawInk)), 2)}         ${f(mean(fp))}/${f(median(fp))}          ${f(mean(ts.map((t) => t.quality.shapeScore)))}/${f(median(ts.map((t) => t.quality.shapeScore)))}  ${f(mean(ts.map((t) => t.quality.targetCoverage)))}  ${f(mean(ts.map((t) => t.quality.order)))}  ${f(mean(ts.map((t) => t.quality.targetSpan)))}  ${f(mean(ts.map((t) => t.quality.backtracking)))}  ${f(mean(ts.map((t) => t.quality.routeTarget)))}     ${String(ts.filter((t) => t.quality.feasible).length).padStart(3)}      ${String(ts.filter((t) => t.quality.wordTraversalPhysical).length).padStart(3)}      ${ts.filter((t) => t.fellBack).length}`,
    );
  }
}

function tradeoffTable(label: string, cs: readonly CandidateRecord[]) {
  console.log(`  ${label}`);
  console.log('    selector               changed  Δprogress  Δcost     Δshape   ΔtgtCov  ΔfinalCov | identical improved_clean improved_w_regr regressed neutral | flags');
  for (const s of SELECTORS) {
    const pairs = cs.map((c) => ({ b: tr(c, 'BASELINE_COST'), t: tr(c, s) }));
    const counts: Record<string, number> = {};
    const flagCounts: Record<string, number> = {};
    for (const { t } of pairs) {
      counts[t.outcome] = (counts[t.outcome] ?? 0) + 1;
      for (const fl of t.regressionFlags) flagCounts[fl] = (flagCounts[fl] ?? 0) + 1;
    }
    console.log(
      `    ${s.padEnd(22)} ${String(pairs.filter((x) => !x.t.sameStateAsBaseline).length).padStart(4)}    ${f(mean(pairs.map((x) => x.t.progress - x.b.progress)))}    ${f(mean(pairs.map((x) => x.t.cost - x.b.cost)), 1).padStart(6)}   ${f(mean(pairs.map((x) => x.t.quality.shapeScore - x.b.quality.shapeScore)))}   ${f(mean(pairs.map((x) => x.t.quality.targetCoverage - x.b.quality.targetCoverage)))}   ${f(mean(pairs.map((x) => (x.t.finalLetter?.coverage ?? 0) - (x.b.finalLetter?.coverage ?? 0))))}  |    ${counts.identical ?? 0}          ${counts.improved_clean ?? 0}            ${counts.improved_with_regression ?? 0}              ${counts.regressed ?? 0}        ${counts.changed_neutral ?? 0}   | ${JSON.stringify(flagCounts)}`,
    );
  }
}

function controlsTable(all: readonly CandidateRecord[]) {
  console.log('  letter  selector               n   phys  cov mean  rawInk | word-level: shape  tgtCov  order  tSpan  route/tgt  wordPhys');
  for (const [word, ctrls] of Object.entries(CONTROLS)) {
    const cs = all.filter((c) => c.word === word);
    for (const { letter, index } of ctrls) {
      for (const s of SELECTORS) {
        const ts = cs.map((c) => tr(c, s));
        const ls = ts.map((t) => t.quality.letters[index]!);
        console.log(`  ${letter.padEnd(6)}  ${s.padEnd(22)} ${String(ls.length).padStart(3)}  ${String(ls.filter((l) => l.physicallyCovered).length).padStart(4)}   ${f(mean(ls.map((l) => l.coverage)))}   ${f(mean(ls.map((l) => l.rawInk)), 2)}  |  ${f(mean(ts.map((t) => t.quality.shapeScore)))}  ${f(mean(ts.map((t) => t.quality.targetCoverage)))}  ${f(mean(ts.map((t) => t.quality.order)))}  ${f(mean(ts.map((t) => t.quality.targetSpan)))}  ${f(mean(ts.map((t) => t.quality.routeTarget)))}   ${ts.filter((t) => t.quality.wordTraversalPhysical).length}`);
      }
      const lost = cs.filter((c) => c.treatments.some((t) => t.selector !== 'BASELINE_COST' && tr(c, 'BASELINE_COST').quality.letters[index]!.physicallyCovered && !t.quality.letters[index]!.physicallyCovered));
      console.log(`  ${letter}: candidates where ANY non-baseline selector loses ${letter}'s physical coverage: ${lost.length}/${cs.length}; per selector: ${SELECTORS.filter((s) => s !== 'BASELINE_COST').map((s) => `${s}=${cs.filter((c) => tr(c, 'BASELINE_COST').quality.letters[index]!.physicallyCovered && !tr(c, s).quality.letters[index]!.physicallyCovered).length}`).join(' ')}`);
    }
  }
}

/** Step 17: the farther goal vs the baseline goal. */
function poolClass(b: Treatment, t: Treatment): 'same' | 'A_better_shape_and_coverage' | 'B_better_coverage_worse_shape' | 'C_longer_or_worse' | 'D_infeasible' | 'neutral' {
  if (t.sameStateAsBaseline) return 'same';
  if (!t.quality.feasible) return 'D_infeasible';
  const improved = finalLetterImproved(comparable(b.quality), comparable(t.quality));
  const dShape = t.quality.shapeScore - b.quality.shapeScore;
  if (improved && dShape >= 0) return 'A_better_shape_and_coverage';
  if (improved && dShape < 0) return 'B_better_coverage_worse_shape';
  if (!improved && Math.abs(dShape) <= 0.01 && t.regressionFlags.length === 0) return 'neutral';
  return 'C_longer_or_worse';
}

function poolTable(label: string, cs: readonly CandidateRecord[]) {
  for (const s of ['MAX_PROGRESS', 'PROGRESS_BAND_03', 'FINAL_LETTER_PROGRESS'] as const) {
    const counts: Record<string, number> = {};
    for (const c of cs) {
      const k = poolClass(tr(c, 'BASELINE_COST'), tr(c, s));
      counts[k] = (counts[k] ?? 0) + 1;
    }
    console.log(`  ${label} ${s} vs BASELINE_COST: ${JSON.stringify(counts)}`);
  }
  const pa = cs.map((c) => c.poolAnalysis).filter((x): x is PoolAnalysis => Boolean(x));
  const ps = cs.map((c) => c.pool);
  console.log(
    `  ${label} goal pool: goals mean=${f(mean(ps.map((p) => p.goalCount)), 0)} progress min/med/max mean=${f(mean(ps.filter((p) => p.goalCount).map((p) => p.minProgress!)))}/${f(mean(ps.filter((p) => p.goalCount).map((p) => p.medianProgress!)))}/${f(mean(ps.filter((p) => p.goalCount).map((p) => p.maxProgress!)))} cheapest progress=${f(mean(ps.filter((p) => p.goalCount).map((p) => p.cheapestProgress!)))} gap cheapest→max=${f(mean(ps.filter((p) => p.goalCount).map((p) => p.progressGapCheapestToMax!)))} cost cheapest=${f(mean(ps.filter((p) => p.goalCount).map((p) => p.cheapestCost!)), 1)} cost of max-progress goal=${f(mean(ps.filter((p) => p.goalCount).map((p) => p.maxProgressGoalCost!)), 1)}`,
  );
  console.log(`  ${label} within-pool Spearman (mean over candidates, ≤${POOL_SAMPLE} sampled goals each): progress~cost=${f(mean(pa.map((x) => x.spearmanProgressCost).filter((v) => !Number.isNaN(v))), 2)} progress~shapeScore=${f(mean(pa.map((x) => x.spearmanProgressShape).filter((v) => !Number.isNaN(v))), 2)} progress~finalLetterCoverage=${f(mean(pa.map((x) => x.spearmanProgressFinalCov).filter((v) => !Number.isNaN(v))), 2)} (n=${pa.length})`);
}

function deepDive(label: string, c: CandidateRecord | undefined) {
  console.log('');
  console.log(`=== DEEP DIVE: ${label} ===`);
  if (!c) {
    console.log('  not present');
    return;
  }
  const fl = tr(c, 'BASELINE_COST').finalLetter;
  console.log(`  ${c.word} ${c.caseLabel} ${c.placementId} final=${c.finalLetter} window=${f(fl?.start, 4)}/${f(fl?.mid, 4)}/${f(fl?.end, 4)} states=${c.statesExplored} cap=${c.maxExpansionsHit} goals=${c.pool.goalCount} poolProgress min/med/max=${f(c.pool.minProgress)}/${f(c.pool.medianProgress)}/${f(c.pool.maxProgress)} cheapest=${f(c.pool.cheapestProgress)}@${f(c.pool.cheapestCost, 1)} maxProgGoalCost=${f(c.pool.maxProgressGoalCost, 1)}`);
  console.log('    selector               prog   cost    finalLtrProg  end phys finalCov rawInk  zInk(t/d/b)     shape  tgtCov order  route/tgt  dist   feasible outcome                  flags');
  for (const t of c.treatments) {
    const z = t.finalLetter?.zStrokeInk;
    console.log(
      `    ${t.selector.padEnd(22)} ${f(t.progress)}  ${f(t.cost, 1).padStart(6)}  ${f(t.finalLetterProgress, 2)}          ${t.finalLetter?.reachesEnd ? 'Y' : 'n'}   ${t.finalLetter?.physicallyCovered ? 'Y' : 'n'}    ${f(t.finalLetter?.coverage)}   ${f(t.finalLetter?.rawInk, 2)}   ${z ? `${f(z.top, 2)}/${f(z.diagonal, 2)}/${f(z.bottom, 2)}` : '     -        '}  ${f(t.quality.shapeScore)}  ${f(t.quality.targetCoverage)}  ${f(t.quality.order)}  ${f(t.quality.routeTarget)}   ${t.routeDistanceMeters.toFixed(0).padStart(5)}  ${String(t.quality.feasible).padEnd(5)}    ${t.outcome.padEnd(24)} ${t.regressionFlags.join(',')}${t.fellBack ? ' (fallback)' : ''}`,
    );
  }
}

async function main() {
  const started = Date.now();
  const all: CandidateRecord[] = [];
  for (const word of ['ROBZ', 'CAIRO']) {
    for (const tc of CASES) {
      const caseLabel = `${tc.locationName}/${tc.targetDistanceMeters}`;
      const report = await runExperimentalPipelineMultiVariant({ word, start: tc.start, targetDistanceMeters: tc.targetDistanceMeters }, ['smooth']);
      const feasible = (report.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2);
      console.log(`[corpus] ${word} ${caseLabel}: feasible=${feasible.length}`);
      for (const record of feasible) {
        const c = analyzeCandidate(word, caseLabel, record);
        if (c) all.push(c);
      }
    }
  }
  const z = all.filter((c) => c.word === 'ROBZ');
  const o = all.filter((c) => c.word === 'CAIRO');

  console.log('');
  console.log('=== PARITY / SAME-SEARCH ===');
  const pk = ['productionPath', 'productionStates', 'productionFailure', 'secondRunStates', 'secondRunPath'] as const;
  console.log(`  ${pk.map((k) => `${k}=${all.filter((c) => c.parity[k]).length}/${all.length}`).join(' ')}`);
  console.log(`  (productionPath also requires BASELINE_COST's selected state === the search's own returned state and mirrorResultForState(state) === production path)`);
  console.log(`  every treatment of a candidate draws from ONE search run and ONE goal pool (by construction); goal pools: Z empty=${z.filter((c) => c.pool.goalCount === 0).length} O empty=${o.filter((c) => c.pool.goalCount === 0).length}`);
  console.log(`  corpus: Z=${z.length} O=${o.length}; expansion-cap hits Z=${z.filter((c) => c.maxExpansionsHit).length} O=${o.filter((c) => c.maxExpansionsHit).length}; FINAL_LETTER bins: Z=${JSON.stringify(computeLetterBinRanges(letterBoundariesFromWordShape(buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' })).boundaries).at(-1))} O=${JSON.stringify(computeLetterBinRanges(letterBoundariesFromWordShape(buildWalkableWordShape('CAIRO', { letterVariant: 'smooth' })).boundaries).at(-1))}`);

  console.log('');
  console.log('=== B. MAIN COMPARISON ===');
  mainTable('Z (ROBZ)', z);
  mainTable('O (CAIRO)', o);

  console.log('');
  console.log('=== C. SELECTION TRADEOFF (vs BASELINE_COST) ===');
  tradeoffTable('Z', z);
  tradeoffTable('O', o);

  deepDive('ROBZ #1', z.find((c) => c.caseLabel === ROBZ1.caseLabel && c.placementId === ROBZ1.placementId));
  deepDive('ROBZ #2', z.find((c) => c.caseLabel === ROBZ2.caseLabel && c.placementId === ROBZ2.placementId));
  const oTop = [...o].sort((a, b) => tr(b, 'BASELINE_COST').quality.shapeScore - tr(a, 'BASELINE_COST').quality.shapeScore).slice(0, 2);
  oTop.forEach((c, i) => deepDive(`CAIRO/O #${i + 1} (top baseline shapeScore)`, c));
  // A third O case: the O candidate with the largest baseline cheapest→max progress gap (rule fixed before running).
  const oGap = [...o].filter((c) => !oTop.includes(c)).sort((a, b) => (b.pool.progressGapCheapestToMax ?? 0) - (a.pool.progressGapCheapestToMax ?? 0))[0];
  deepDive('CAIRO/O #3 (largest cheapest→max goal gap)', oGap);

  console.log('');
  console.log('=== F. R/C/I CONTROLS ===');
  controlsTable(all);

  console.log('');
  console.log('=== G. GOAL-POOL ANALYSIS ===');
  poolTable('Z', z);
  poolTable('O', o);

  const outPath = resolve(DIAGNOSTIC_DIR, 'goal-selection-diagnostic-results.json');
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), params: SELECTION_PARAMS, goalProgress: GRAPH_SHAPE.goalProgress, candidates: all }, null, 2), 'utf8');
  console.log('');
  console.log(`[goal-selection] done in ${Math.round((Date.now() - started) / 1000)}s; json: ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
