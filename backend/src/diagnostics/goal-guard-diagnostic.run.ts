/**
 * DEVELOPMENT ONLY. Guarded goal-selection experiment: GUARDED_BAND_01 /
 * GUARDED_BAND_03 over the SAME ROBZ + CAIRO corpus and the SAME single
 * search + goal pool per candidate as goal-selection-diagnostic.run.ts.
 * The guard (evaluateSelectionGuard) is applied AFTER the band selection,
 * purely post-search: if any guard fails, BASELINE_COST is returned.
 * graph-shape.ts is never touched; nothing that generates states varies.
 *
 * Run with: npx tsx src/diagnostics/goal-guard-diagnostic.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, mirrorResultForState, computeLetterBinRanges, type SearchState } from './graph-shape-goal-mirror';
import { routeQuality, finalLetterOf, type RouteQuality, type FinalLetter } from './goal-threshold-diagnostic';
import { createGoalPoolObserver, selectGoal, finalLetterImproved, evaluateSelectionGuard, GUARD_LIMITS, SELECTION_PARAMS, type GuardQuality, type GuardResult, type GoalEntry } from './goal-selection-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const CASES = [
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];
const DEEP = [
  { label: 'ROBZ #1 (negative control)', word: 'ROBZ', caseLabel: 'Zamalek/4000', placementId: 'sf-r315-s0.6-e-905.1-n905.1' },
  { label: 'ROBZ #2 (positive control)', word: 'ROBZ', caseLabel: 'Alexandria/2000', placementId: 'sf-r315-s0.8-e0-n-400' },
  { label: 'O #1 (farther reaches end, O coverage lost)', word: 'CAIRO', caseLabel: 'Alexandria/2000', placementId: 'sf-r22.5-s1.0-e282.8-n-282.8' },
  { label: 'O #2 (BAND_03 clean; BAND_01 infeasible)', word: 'CAIRO', caseLabel: 'Zamalek/4000', placementId: 'sf-r315-s0.6-e0-n0' },
  { label: 'O #3 (BAND_03 large clean gain)', word: 'CAIRO', caseLabel: 'Alexandria/2000', placementId: 'sf-r0-s1.0-e-282.8-n-282.8' },
];
const CONTROL_LETTERS: Record<string, Array<{ letter: string; index: number }>> = { ROBZ: [{ letter: 'R', index: 0 }], CAIRO: [{ letter: 'C', index: 0 }, { letter: 'I', index: 2 }] };

type TreatmentName = 'BASELINE_COST' | 'BAND_01' | 'BAND_03' | 'GUARDED_BAND_01' | 'GUARDED_BAND_03';
const TREATMENTS: TreatmentName[] = ['BASELINE_COST', 'GUARDED_BAND_01', 'GUARDED_BAND_03', 'BAND_01', 'BAND_03'];

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}
const mean = (v: readonly number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : Number.NaN);
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));

type StateSnapshot = {
  stateId: string;
  progress: number;
  cost: number;
  shapeScore: number;
  targetCoverage: number;
  backtracking: number;
  routeTarget: number;
  feasible: boolean;
  continuityValid: boolean;
  letters: RouteQuality['letters'];
  finalLetter: FinalLetter | null;
  routeFinalProgress: number | null;
};

type TreatmentRecord = {
  treatment: TreatmentName;
  selected: StateSnapshot;
  sameAsBaseline: boolean;
  /** Guarded treatments only: the band candidate that was tested, and every guard's verdict. */
  bandCandidate?: StateSnapshot;
  bandCandidateDiffers?: boolean;
  guard?: GuardResult | null;
};

type CandidateRecord = {
  word: string;
  caseLabel: string;
  placementId: string;
  parity: { productionPath: boolean; productionStates: boolean; productionFailure: boolean; baselineIsSearchReturned: boolean; secondRunStates: boolean; secondRunGoalCount: boolean };
  statesExplored: number;
  goalCount: number;
  baseline: StateSnapshot;
  treatments: TreatmentRecord[];
};

function stateId(entry: GoalEntry | null, state: SearchState): string {
  return entry ? `goal#${entry.order}@L${entry.layer}/e${state.edgeIds.length}` : `bestAny/e${state.edgeIds.length}`;
}

function guardQuality(s: StateSnapshot): GuardQuality {
  return { shapeScore: s.shapeScore, targetCoverage: s.targetCoverage, backtracking: s.backtracking, routeTarget: s.routeTarget, feasible: s.feasible, wordTraversalPhysical: false, continuityValid: s.continuityValid, letters: s.letters };
}

function analyzeCandidate(word: string, caseLabel: string, record: FeasibilityRecord): CandidateRecord | null {
  const target = record.target;
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const loop = isClosedTarget(target);
  const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
  const finalBoundary = boundaries[boundaries.length - 1]!;
  const ctx = { finalLetter: finalBoundary, finalLetterBins: computeLetterBinRanges(boundaries)[boundaries.length - 1]! };

  const production = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
  const { observer, pool } = createGoalPoolObserver();
  const observed = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
  const p = pool();
  const { observer: observer2, pool: pool2 } = createGoalPoolObserver();
  const second = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer: observer2 });
  if (observed.pathPoints.length < 2) return null;

  const snapshot = (entry: GoalEntry | null, state: SearchState): StateSnapshot => {
    const r = mirrorResultForState(state, p.directed, target, kind, loop, observed.regions, observed.search);
    const q = routeQuality(word, target, r.pathPoints, r.failure)!;
    q.targetCoverage = r.metrics.targetCoverage;
    return {
      stateId: stateId(entry, state),
      progress: state.progress,
      cost: state.cost,
      shapeScore: q.shapeScore,
      targetCoverage: q.targetCoverage,
      backtracking: q.backtracking,
      routeTarget: q.routeTarget,
      feasible: q.feasible,
      continuityValid: q.continuityValid,
      letters: q.letters,
      finalLetter: finalLetterOf(word, target, r.pathPoints, finalBoundary, q),
      routeFinalProgress: q.routeFinalProgress,
    };
  };

  const baseEntry = p.goals.length ? selectGoal('BASELINE_COST', p.goals, ctx).entry : null;
  const baseState = baseEntry?.state ?? p.searchReturned!;
  const baseline = snapshot(baseEntry, baseState);
  const baseRoute = mirrorResultForState(baseState, p.directed, target, kind, loop, observed.regions, observed.search);

  const parity = {
    productionPath: JSON.stringify(baseRoute.pathPoints) === JSON.stringify(production.pathPoints),
    productionStates: observed.search.statesExplored === production.search.statesExplored,
    productionFailure: baseRoute.failure === production.failure,
    baselineIsSearchReturned: baseState === p.searchReturned,
    secondRunStates: second.search.statesExplored === observed.search.statesExplored,
    secondRunGoalCount: pool2().goals.length === p.goals.length,
  };

  const band = (name: 'PROGRESS_BAND_01' | 'PROGRESS_BAND_03') => {
    const entry = p.goals.length ? selectGoal(name, p.goals, ctx).entry : null;
    const state = entry?.state ?? baseState;
    return { entry, state, snap: state === baseState ? baseline : snapshot(entry, state) };
  };
  const b01 = band('PROGRESS_BAND_01');
  const b03 = band('PROGRESS_BAND_03');

  const guarded = (name: TreatmentName, b: typeof b01): TreatmentRecord => {
    const differs = b.state !== baseState;
    const guard = differs ? evaluateSelectionGuard(guardQuality(baseline), guardQuality(b.snap)) : null;
    const accepted = differs && guard!.accepted;
    return { treatment: name, selected: accepted ? b.snap : baseline, sameAsBaseline: !accepted, bandCandidate: b.snap, bandCandidateDiffers: differs, guard };
  };

  return {
    word,
    caseLabel,
    placementId: record.placementId,
    parity,
    statesExplored: observed.search.statesExplored,
    goalCount: p.goals.length,
    baseline,
    treatments: [
      { treatment: 'BASELINE_COST', selected: baseline, sameAsBaseline: true },
      guarded('GUARDED_BAND_01', b01),
      guarded('GUARDED_BAND_03', b03),
      { treatment: 'BAND_01', selected: b01.snap, sameAsBaseline: b01.state === baseState },
      { treatment: 'BAND_03', selected: b03.snap, sameAsBaseline: b03.state === baseState },
    ],
  };
}

// ---------------------------------------------------------------------------
// Classification helpers.
// ---------------------------------------------------------------------------

const tr = (c: CandidateRecord, t: TreatmentName) => c.treatments.find((x) => x.treatment === t)!;
const finalOf = (s: StateSnapshot) => s.letters[s.letters.length - 1]!;
const improvedFinal = (base: StateSnapshot, cand: StateSnapshot) => finalLetterImproved(guardQuality(base), guardQuality(cand));
/** Final letter got WORSE (coverage -0.05 or raw ink down, or lost completion) — a regression the guards do not directly measure. */
const worsenedFinal = (base: StateSnapshot, cand: StateSnapshot) => {
  const b = finalOf(base);
  const c = finalOf(cand);
  return (b.physicallyCovered && !c.physicallyCovered) || b.coverage - c.coverage > 0.05 || c.rawInk < b.rawInk - 1e-9;
};

type Outcome = 'clean_improvement' | 'improvement_with_guard_regression' | 'regression' | 'neutral' | 'identical';
function outcomeOf(c: CandidateRecord, t: TreatmentName): Outcome {
  const r = tr(c, t);
  if (r.sameAsBaseline) return 'identical';
  const guard = evaluateSelectionGuard(guardQuality(c.baseline), guardQuality(r.selected));
  const imp = improvedFinal(c.baseline, r.selected);
  const worse = worsenedFinal(c.baseline, r.selected);
  if (imp && guard.accepted && !worse) return 'clean_improvement';
  if (imp && !guard.accepted) return 'improvement_with_guard_regression';
  if (!guard.accepted || worse) return 'regression';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function mainTable(z: CandidateRecord[], o: CandidateRecord[]) {
  console.log('| Treatment | Z complete | O complete | Z end | O end | Z coverage | O coverage | Z progress | O progress | Z shape | O shape | Z feasible | O feasible | Z changed | O changed |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of TREATMENTS) {
    const col = (cs: CandidateRecord[]) => {
      const s = cs.map((c) => tr(c, t).selected);
      const fl = s.map((x) => x.finalLetter).filter((x): x is FinalLetter => Boolean(x));
      return {
        complete: fl.filter((l) => l.physicallyCovered).length,
        end: fl.filter((l) => l.reachesEnd).length,
        cov: mean(fl.map((l) => l.coverage)),
        prog: mean(s.map((x) => x.routeFinalProgress ?? 0)),
        shape: mean(s.map((x) => x.shapeScore)),
        feasible: s.filter((x) => x.feasible).length,
        changed: cs.filter((c) => !tr(c, t).sameAsBaseline).length,
      };
    };
    const a = col(z);
    const b = col(o);
    console.log(`| ${t} | ${a.complete}/${z.length} | ${b.complete}/${o.length} | ${a.end} | ${b.end} | ${f(a.cov)} | ${f(b.cov)} | ${f(a.prog)} | ${f(b.prog)} | ${f(a.shape)} | ${f(b.shape)} | ${a.feasible} | ${b.feasible} | ${a.changed} | ${b.changed} |`);
  }
}

function outcomeTable(label: string, cs: CandidateRecord[]) {
  for (const t of ['GUARDED_BAND_01', 'GUARDED_BAND_03', 'BAND_01', 'BAND_03'] as TreatmentName[]) {
    const counts: Record<Outcome, number> = { clean_improvement: 0, improvement_with_guard_regression: 0, regression: 0, neutral: 0, identical: 0 };
    for (const c of cs) counts[outcomeOf(c, t)] += 1;
    const rejected = cs.filter((c) => tr(c, t).guard && !tr(c, t).guard!.accepted).length;
    console.log(`  ${label} ${t.padEnd(16)} clean=${counts.clean_improvement} impr+guardRegr=${counts.improvement_with_guard_regression} regression=${counts.regression} neutral=${counts.neutral} identical=${counts.identical}${t.startsWith('GUARDED') ? ` (of identical: band picked baseline=${cs.filter((c) => !tr(c, t).bandCandidateDiffers).length}, guard rejected=${rejected})` : ''}`);
  }
}

const GUARD_KEYS = ['feasibilityGuard', 'shapeGuard', 'coverageGuard', 'backtrackGuard', 'lengthRatioGuard', 'letterCoverageGuard', 'continuityGuard'] as const;

function guardEffectiveness(label: string, cs: CandidateRecord[]) {
  for (const t of ['GUARDED_BAND_01', 'GUARDED_BAND_03'] as TreatmentName[]) {
    const tested = cs.filter((c) => tr(c, t).bandCandidateDiffers);
    const rejected = tested.filter((c) => !tr(c, t).guard!.accepted);
    console.log(`  ${label} ${t}: band differs from baseline ${tested.length}/${cs.length} (${f((100 * tested.length) / cs.length, 0)}%); accepted ${tested.length - rejected.length} (${f((100 * (tested.length - rejected.length)) / Math.max(1, tested.length), 0)}% of tested); rejected ${rejected.length} (${f((100 * rejected.length) / Math.max(1, tested.length), 0)}%)`);
    const imprRejected = rejected.filter((c) => improvedFinal(c.baseline, tr(c, t).bandCandidate!));
    const savedRejected = rejected.filter((c) => !improvedFinal(c.baseline, tr(c, t).bandCandidate!));
    console.log(`    rejections that saved a route with NO final-letter gain (pure protection)=${savedRejected.length}; rejections that blocked a final-letter gain=${imprRejected.length}`);
    console.log('    guard                 rejects  %tested  sole-blocker  saved(no gain lost)  blocked-a-gain  blocked-a-gain-as-sole-blocker');
    for (const k of GUARD_KEYS) {
      const fails = tested.filter((c) => !tr(c, t).guard![k]);
      const sole = fails.filter((c) => tr(c, t).guard!.rejectionReasons.length === 1);
      const saved = fails.filter((c) => !improvedFinal(c.baseline, tr(c, t).bandCandidate!));
      const blocked = fails.filter((c) => improvedFinal(c.baseline, tr(c, t).bandCandidate!));
      const blockedSole = blocked.filter((c) => tr(c, t).guard!.rejectionReasons.length === 1);
      console.log(`    ${k.padEnd(21)} ${String(fails.length).padStart(5)}    ${f((100 * fails.length) / Math.max(1, tested.length), 0).padStart(4)}%   ${String(sole.length).padStart(6)}        ${String(saved.length).padStart(6)}               ${String(blocked.length).padStart(6)}          ${String(blockedSole.length).padStart(6)}`);
    }
    const reasonSets: Record<string, number> = {};
    for (const c of rejected) {
      const key = tr(c, t).guard!.rejectionReasons.join('+');
      reasonSets[key] = (reasonSets[key] ?? 0) + 1;
    }
    console.log(`    complete rejection-reason sets: ${JSON.stringify(reasonSets)}`);
    for (const c of imprRejected) {
      const b = tr(c, t).bandCandidate!;
      console.log(`      blocked gain: ${c.caseLabel} ${c.placementId} reasons=${tr(c, t).guard!.rejectionReasons.join('+')} final cov ${f(finalOf(c.baseline).coverage)}→${f(finalOf(b).coverage)} phys ${finalOf(c.baseline).physicallyCovered}→${finalOf(b).physicallyCovered} shape ${f(c.baseline.shapeScore)}→${f(b.shapeScore)} feasible ${b.feasible}`);
    }
  }
}

function snapLine(s: StateSnapshot): string {
  const fl = s.finalLetter;
  const z = fl?.zStrokeInk;
  return `${s.stateId.padEnd(22)} prog=${f(s.progress)} cost=${f(s.cost, 1)} finalCov=${f(fl?.coverage)} rawInk=${f(fl?.rawInk, 2)} phys=${fl?.physicallyCovered ? 'Y' : 'n'} end=${fl?.reachesEnd ? 'Y' : 'n'}${z ? ` Z(t/d/b)=${f(z.top, 2)}/${f(z.diagonal, 2)}/${f(z.bottom, 2)}` : ''} shape=${f(s.shapeScore)} tgtCov=${f(s.targetCoverage)} backtr=${f(s.backtracking)} route/tgt=${f(s.routeTarget)} feasible=${s.feasible} continuity=${s.continuityValid} letters=${s.letters.map((l) => `${l.letter}${l.physicallyCovered ? '✓' : '·'}`).join('')}`;
}

function deepDive(label: string, c: CandidateRecord | undefined) {
  console.log('');
  console.log(`--- ${label} ---`);
  if (!c) {
    console.log('  not present');
    return;
  }
  console.log(`  ${c.word} ${c.caseLabel} ${c.placementId} states=${c.statesExplored} goals=${c.goalCount}`);
  console.log(`  BASELINE_COST     ${snapLine(c.baseline)}`);
  for (const t of ['GUARDED_BAND_01', 'GUARDED_BAND_03'] as TreatmentName[]) {
    const r = tr(c, t);
    if (!r.bandCandidateDiffers) {
      console.log(`  ${t}: band selects the BASELINE state itself (nothing to guard) → baseline`);
      continue;
    }
    console.log(`  ${t} band cand  ${snapLine(r.bandCandidate!)}`);
    console.log(`    guards: ${GUARD_KEYS.map((k) => `${k.replace('Guard', '')}=${r.guard![k] ? 'ok' : 'FAIL'}`).join(' ')} → ${r.guard!.accepted ? 'ACCEPTED' : `REJECTED (${r.guard!.rejectionReasons.join('+')}) → baseline`}`);
  }
}

function zoAnalysis(label: string, cs: CandidateRecord[]) {
  console.log(`  ${label}: physical completion baseline=${cs.filter((c) => finalOf(c.baseline).physicallyCovered).length} guarded01=${cs.filter((c) => finalOf(tr(c, 'GUARDED_BAND_01').selected).physicallyCovered).length} guarded03=${cs.filter((c) => finalOf(tr(c, 'GUARDED_BAND_03').selected).physicallyCovered).length}`);
  for (const t of ['GUARDED_BAND_01', 'GUARDED_BAND_03'] as TreatmentName[]) {
    const accepted = cs.filter((c) => !tr(c, t).sameAsBaseline);
    const best = [...accepted].sort((a, b) => finalOf(tr(b, t).selected).coverage - finalOf(b.baseline).coverage - (finalOf(tr(a, t).selected).coverage - finalOf(a.baseline).coverage))[0];
    if (best) console.log(`    ${t} best accepted gain: ${best.caseLabel} ${best.placementId} final cov ${f(finalOf(best.baseline).coverage)}→${f(finalOf(tr(best, t).selected).coverage)} phys ${finalOf(best.baseline).physicallyCovered}→${finalOf(tr(best, t).selected).physicallyCovered} shape ${f(best.baseline.shapeScore)}→${f(tr(best, t).selected.shapeScore)}`);
    const rejected = cs.filter((c) => tr(c, t).bandCandidateDiffers && !tr(c, t).guard!.accepted);
    const worst = [...rejected].sort((a, b) => tr(a, t).bandCandidate!.shapeScore - a.baseline.shapeScore - (tr(b, t).bandCandidate!.shapeScore - b.baseline.shapeScore))[0];
    if (worst) console.log(`    ${t} worst rejected: ${worst.caseLabel} ${worst.placementId} shape ${f(worst.baseline.shapeScore)}→${f(tr(worst, t).bandCandidate!.shapeScore)} feasible ${tr(worst, t).bandCandidate!.feasible} reasons=${tr(worst, t).guard!.rejectionReasons.join('+')}`);
    const acceptedWorse = accepted.filter((c) => worsenedFinal(c.baseline, tr(c, t).selected));
    console.log(`    ${t} accepted states whose final letter got WORSE (not a guard dimension): ${acceptedWorse.length}${acceptedWorse.length ? ` [${acceptedWorse.map((c) => `${c.caseLabel} ${c.placementId}`).join('; ')}]` : ''}`);
  }
}

function controls(all: CandidateRecord[]) {
  for (const [word, letters] of Object.entries(CONTROL_LETTERS)) {
    const cs = all.filter((c) => c.word === word);
    for (const { letter, index } of letters) {
      for (const t of ['GUARDED_BAND_01', 'GUARDED_BAND_03', 'BAND_03'] as TreatmentName[]) {
        const base = cs.filter((c) => c.baseline.letters[index]!.physicallyCovered).length;
        const after = cs.filter((c) => tr(c, t).selected.letters[index]!.physicallyCovered).length;
        const lost = cs.filter((c) => c.baseline.letters[index]!.physicallyCovered && !tr(c, t).selected.letters[index]!.physicallyCovered).length;
        console.log(`  ${letter} ${t.padEnd(16)} covered ${base} → ${after} (lost ${lost}) | Δshape mean=${f(mean(cs.map((c) => tr(c, t).selected.shapeScore - c.baseline.shapeScore)))} | feasible ${cs.filter((c) => c.baseline.feasible).length} → ${cs.filter((c) => tr(c, t).selected.feasible).length}`);
      }
    }
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
  console.log('=== PARITY / SAME SEARCH ===');
  const keys = Object.keys(all[0]!.parity) as Array<keyof CandidateRecord['parity']>;
  console.log(`  ${keys.map((k) => `${k}=${all.filter((c) => c.parity[k]).length}/${all.length}`).join(' ')}`);
  console.log(`  corpus Z=${z.length} O=${o.length} (R=${z.length} C=${o.length} I=${o.length}); guards: shapeDrop≤${GUARD_LIMITS.shapeDrop} targetCoverageDrop≤${GUARD_LIMITS.targetCoverageDrop} backtrackRise≤${GUARD_LIMITS.backtrackRise} routeTarget≤×${GUARD_LIMITS.routeTargetFactor}; bands ${SELECTION_PARAMS.bandTight}/${SELECTION_PARAMS.bandWide}; goalProgress=${GRAPH_SHAPE.goalProgress}`);

  console.log('');
  console.log('=== MAIN TABLE ===');
  mainTable(z, o);

  console.log('');
  console.log('=== IMPROVEMENT / REGRESSION ===');
  outcomeTable('Z', z);
  outcomeTable('O', o);

  console.log('');
  console.log('=== GUARD EFFECTIVENESS ===');
  guardEffectiveness('Z', z);
  guardEffectiveness('O', o);
  guardEffectiveness('ALL', all);

  console.log('');
  console.log('=== Z / O ANALYSIS ===');
  zoAnalysis('Z', z);
  zoAnalysis('O', o);

  console.log('');
  console.log('=== DEEP DIVES ===');
  for (const d of DEEP) deepDive(d.label, all.find((c) => c.word === d.word && c.caseLabel === d.caseLabel && c.placementId === d.placementId));

  console.log('');
  console.log('=== R/C/I CONTROLS ===');
  controls(all);

  const outPath = resolve(DIAGNOSTIC_DIR, 'goal-guard-diagnostic-results.json');
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), guardLimits: GUARD_LIMITS, bands: SELECTION_PARAMS, candidates: all }, null, 2), 'utf8');
  console.log('');
  console.log(`[goal-guard] done in ${Math.round((Date.now() - started) / 1000)}s; json: ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
