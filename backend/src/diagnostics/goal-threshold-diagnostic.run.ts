/**
 * DEVELOPMENT ONLY. Goal-progress threshold sweep (0.88 / 0.92 / 0.96 / 0.99)
 * over the SAME ROBZ + CAIRO corpus used by z-letter-forensic-analysis and
 * z-diagonal-direction-diagnostic. One variable changes: the goal progress
 * threshold inside the goal check (makeProgressThresholdGoal). Beam width,
 * expansion cap, corridor, follow radius, scoring, graph, target, coverage
 * goal: all unchanged. graph-shape.ts is never touched.
 *
 * For each candidate the 0.88 run is additionally compared against the REAL
 * production routeGraphConstrainedShape (exported) to prove parity on the
 * real corpus, not only on synthetic fixtures.
 *
 * Run with: npx tsx src/diagnostics/goal-threshold-diagnostic.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror } from './graph-shape-goal-mirror';
import { buildDirected, testConnectivity } from './letter-street-support-diagnostic';
import {
  GOAL_THRESHOLDS,
  GOAL_DIAGNOSTIC,
  classifyTermination,
  createTelemetryObserver,
  makeProgressThresholdGoal,
  routeQuality as quality,
  finalLetterOf,
  type RouteQuality,
  type FinalLetter,
  type SearchTelemetry,
  type TerminationCase,
} from './goal-threshold-diagnostic';

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
/** Non-final control letters (index within their word). */
const CONTROLS: Record<string, Array<{ letter: string; index: number }>> = { ROBZ: [{ letter: 'R', index: 0 }], CAIRO: [{ letter: 'C', index: 0 }, { letter: 'I', index: 2 }] };

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

// ---------------------------------------------------------------------------

type ThresholdRun = {
  threshold: number;
  telemetry: Omit<SearchTelemetry, 'maxViableProgressEverState'>;
  terminationCase: TerminationCase;
  quality: RouteQuality | null;
  finalLetter: FinalLetter | null;
  controls: Array<{ letter: string; rawInk: number; coverage: number; physicallyCovered: boolean; routePassesLetterEnd: boolean }>;
  /** Only at baseline: route metrics of the farthest viable state the search ever held. */
  farthestViable?: { progress: number; shapeScore: number; finalLetterRawInk: number; finalLetterCoverage: number; finalLetterPhysicallyCovered: boolean; lengthMeters: number } | null;
  /** Only at baseline: can the graph reach the target's end from the returned route's end? */
  endReachability?: { connected: boolean; ratio: number | null } | null;
};

type CandidateRecord = {
  word: string;
  finalLetter: string;
  caseLabel: string;
  placementId: string;
  parityWithProduction: boolean;
  runs: ThresholdRun[];
};

function analyzeCandidate(word: string, caseLabel: string, record: FeasibilityRecord): CandidateRecord {
  const target = record.target;
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
  const finalBoundary = boundaries[boundaries.length - 1]!;
  const targetLength = polylineLength(target);

  const production = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
  const runs: ThresholdRun[] = [];
  let parity = false;

  for (const threshold of GOAL_THRESHOLDS) {
    const { observer, finish } = createTelemetryObserver({ threshold, targetLength, loop: false });
    const t0 = performance.now();
    const result = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, goalCheck: makeProgressThresholdGoal(threshold), observer });
    const telemetry = finish(performance.now() - t0);
    if (threshold === GRAPH_SHAPE.goalProgress) {
      parity = JSON.stringify(result.pathPoints) === JSON.stringify(production.pathPoints) && result.search.statesExplored === production.search.statesExplored && result.failure === production.failure;
    }
    const q = quality(word, target, result.pathPoints, result.failure);
    if (q) q.targetCoverage = result.metrics.targetCoverage;
    const run: ThresholdRun = {
      threshold,
      telemetry: { ...telemetry, maxViableProgressEverState: undefined, maxViableProgressEverPoints: undefined } as never,
      terminationCase: classifyTermination(telemetry),
      quality: q,
      finalLetter: finalLetterOf(word, target, result.pathPoints, finalBoundary, q),
      controls: (CONTROLS[word] ?? []).map(({ letter, index }) => {
        const l = q?.letters[index];
        return { letter, rawInk: l?.rawInk ?? 0, coverage: l?.coverage ?? 0, physicallyCovered: l?.physicallyCovered ?? false, routePassesLetterEnd: (q?.routeFinalProgress ?? 0) >= boundaries[index]!.projectedEndProgress };
      }),
    };
    if (threshold === GRAPH_SHAPE.goalProgress) {
      // Is the farthest viable state the search ever held physically meaningful?
      const far = telemetry.maxViableProgressEverState;
      const points = telemetry.maxViableProgressEverPoints;
      if (far && points) {
        const fq = points.length >= 2 ? quality(word, target, points, null) : null;
        const fl = fq ? fq.letters[fq.letters.length - 1]! : null;
        run.farthestViable = fq && fl ? { progress: far.progress, shapeScore: fq.shapeScore, finalLetterRawInk: fl.rawInk, finalLetterCoverage: fl.coverage, finalLetterPhysicallyCovered: fl.physicallyCovered, lengthMeters: fq.routeLengthMeters } : null;
      } else run.farthestViable = null;
      // Graph reachability from the returned route's end to the target's end (dead-end check).
      if (result.pathPoints.length >= 2) {
        const { directed, outgoing } = buildDirected(graph, target, kind, false);
        const c = testConnectivity(directed, outgoing, graph, result.pathPoints[result.pathPoints.length - 1]!, target[target.length - 1]!, 3);
        run.endReachability = { connected: c.connected, ratio: c.graphStraightRatio };
      } else run.endReachability = null;
    }
    runs.push(run);
  }
  return { word, finalLetter: finalBoundary.letter, caseLabel, placementId: record.placementId, parityWithProduction: parity, runs };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function runAt(c: CandidateRecord, threshold: number): ThresholdRun {
  return c.runs.find((r) => r.threshold === threshold)!;
}

function thresholdTable(label: string, cands: readonly CandidateRecord[]) {
  console.log(`  ${label} (n=${cands.length})`);
  console.log('    thr   fullWord feasible finalLtrPhys finalLtrRawInk finalLtrCov reachEnd  finalProg mean/med   shape mean/med  cov mean/med   order  tSpan  backtr route/tgt  states mean/med/max  capHits  goalFound  ms/search');
  for (const thr of GOAL_THRESHOLDS) {
    const rs = cands.map((c) => runAt(c, thr));
    const qs = rs.map((r) => r.quality).filter((q): q is RouteQuality => Boolean(q));
    const fls = rs.map((r) => r.finalLetter).filter((x): x is FinalLetter => Boolean(x));
    const fp = qs.map((q) => q.routeFinalProgress ?? 0);
    const states = rs.map((r) => r.telemetry.expansions);
    console.log(
      `    ${thr.toFixed(2)}  ${String(qs.filter((q) => q.wordTraversalPhysical).length).padStart(5)}    ${String(qs.filter((q) => q.feasible).length).padStart(5)}    ${String(fls.filter((l) => l.physicallyCovered).length).padStart(6)}        ${f(mean(fls.map((l) => l.rawInk)))}          ${f(mean(fls.map((l) => l.coverage)))}      ${String(fls.filter((l) => l.reachesEnd).length).padStart(3)}     ${f(mean(fp))}/${f(median(fp))}     ${f(mean(qs.map((q) => q.shapeScore)))}/${f(median(qs.map((q) => q.shapeScore)))}   ${f(mean(qs.map((q) => q.coverage)))}/${f(median(qs.map((q) => q.coverage)))}  ${f(mean(qs.map((q) => q.order)))}  ${f(mean(qs.map((q) => q.targetSpan)))}  ${f(mean(qs.map((q) => q.backtracking)))}  ${f(mean(qs.map((q) => q.routeTarget)))}    ${Math.round(mean(states))}/${Math.round(median(states))}/${Math.max(...states)}      ${rs.filter((r) => r.telemetry.maxExpansionsHit).length}       ${rs.filter((r) => r.telemetry.returned?.isGoal).length}/${rs.length}    ${f(mean(rs.map((r) => r.telemetry.runtimeMs)), 0)}`,
    );
  }
}

function goalTelemetry(label: string, cands: readonly CandidateRecord[]) {
  console.log(`  ${label}`);
  console.log('    thr   firstGoal prog(mean/med)  bestProgGoal(mean)  returned prog(mean/med)  goalStates(mean)  firstGoalLayer/returnedLayer/layers  viableAtFirstGoal(mean) viableNonGoal  maxViableProg@firstGoal  viableBeyondReturned@firstGoal(n cands>0)  maxViableProgEver(mean)  cands with farther viable ever  lastSatisfied(prog/cov/joint)  blockedByCoverage(cands)  finish(exhausted/cap)');
  for (const thr of GOAL_THRESHOLDS) {
    const ts = cands.map((c) => runAt(c, thr).telemetry);
    const g = ts.filter((t) => t.firstGoal);
    const ret = ts.filter((t) => t.returned?.isGoal);
    const fgp = g.map((t) => t.firstGoal!.progress);
    const rp = ret.map((t) => t.returned!.progress);
    console.log(
      `    ${thr.toFixed(2)}  ${f(mean(fgp))}/${f(median(fgp))}             ${f(mean(g.map((t) => t.bestProgressGoal!.progress)))}              ${f(mean(rp))}/${f(median(rp))}              ${f(mean(ts.map((t) => t.goalStatesEncountered)), 0)}              ${f(mean(g.map((t) => t.firstGoal!.layer)), 0)}/${f(mean(ret.map((t) => t.returned!.layerFound ?? 0)), 0)}/${f(mean(ts.map((t) => t.layers)), 0)}                           ${f(mean(g.map((t) => t.atFirstGoal?.viableCount ?? 0)), 0)}               ${f(mean(g.map((t) => t.atFirstGoal?.viableNonGoalCount ?? 0)), 0)}            ${f(mean(g.map((t) => t.atFirstGoal?.maxViableProgress ?? 0)))}                     ${g.filter((t) => (t.atFirstGoal?.viableBeyond ?? 0) > 0).length}/${g.length}                                   ${f(mean(ts.map((t) => t.maxViableProgressEver ?? 0)))}                  ${ts.filter((t) => t.returned?.isGoal && (t.maxViableProgressEver ?? 0) > t.returned.progress + GOAL_DIAGNOSTIC.substantialProgress).length}/${ts.length}                            ${g.filter((t) => t.firstGoal!.lastSatisfied === 'progress').length}/${g.filter((t) => t.firstGoal!.lastSatisfied === 'coverage').length}/${g.filter((t) => t.firstGoal!.lastSatisfied === 'joint').length}                         ${ts.filter((t) => t.blockedByCoverageCount > 0).length}/${ts.length}                ${ts.filter((t) => t.finishReason === 'beam_exhausted').length}/${ts.filter((t) => t.finishReason === 'max_expansions').length}`,
    );
  }
}

function caseTable(label: string, cands: readonly CandidateRecord[]) {
  const counts: Record<string, number> = {};
  for (const c of cands) {
    const k = runAt(c, 0.88).terminationCase;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  // Case D (threshold response): 0.99 continues ≥ substantialProgress farther AND final-letter rawInk improves AND shapeScore not worse by > 0.02.
  const dCount = cands.filter((c) => {
    const b = runAt(c, 0.88);
    const h = runAt(c, 0.99);
    if (!b.quality || !h.quality || !b.finalLetter || !h.finalLetter) return false;
    return (h.quality.routeFinalProgress ?? 0) >= (b.quality.routeFinalProgress ?? 0) + GOAL_DIAGNOSTIC.substantialProgress && h.finalLetter.rawInk > b.finalLetter.rawInk && h.quality.shapeScore >= b.quality.shapeScore - 0.02;
  }).length;
  const farther99 = cands.filter((c) => (runAt(c, 0.99).quality?.routeFinalProgress ?? 0) >= (runAt(c, 0.88).quality?.routeFinalProgress ?? 0) + GOAL_DIAGNOSTIC.substantialProgress).length;
  const deadEnd = cands.filter((c) => runAt(c, 0.88).terminationCase === 'B_no_viable_beyond' && runAt(c, 0.88).endReachability && !runAt(c, 0.88).endReachability!.connected).length;
  const bReachable = cands.filter((c) => runAt(c, 0.88).terminationCase === 'B_no_viable_beyond' && runAt(c, 0.88).endReachability?.connected).length;
  console.log(`  ${label}: baseline cases ${JSON.stringify(counts)} | of B: graph can reach target end=${bReachable}, graph dead end=${deadEnd} | 0.99 route ends ≥+${GOAL_DIAGNOSTIC.substantialProgress} farther: ${farther99}/${cands.length} | CASE D (farther AND final-letter ink up AND shape not worse): ${dCount}/${cands.length}`);
  const fv = cands.map((c) => runAt(c, 0.88).farthestViable).filter((x): x is NonNullable<ThresholdRun['farthestViable']> => Boolean(x));
  const baseQ = cands.map((c) => runAt(c, 0.88));
  console.log(`    farthest viable state ever held (baseline): mean progress=${f(mean(fv.map((x) => x.progress)))} shape=${f(mean(fv.map((x) => x.shapeScore)))} (returned shape=${f(mean(baseQ.map((r) => r.quality?.shapeScore ?? 0)))}) finalLetterRawInk=${f(mean(fv.map((x) => x.finalLetterRawInk)))} (returned ${f(mean(baseQ.map((r) => r.finalLetter?.rawInk ?? 0)))}) finalLetterPhys=${fv.filter((x) => x.finalLetterPhysicallyCovered).length}/${fv.length} (returned ${baseQ.filter((r) => r.finalLetter?.physicallyCovered).length})`);
}

function deepDive(label: string, c: CandidateRecord | undefined) {
  console.log('');
  console.log(`=== DEEP DIVE: ${label} ===`);
  if (!c) {
    console.log('  not present');
    return;
  }
  const fl0 = runAt(c, 0.88).finalLetter;
  console.log(`  ${c.word} ${c.caseLabel} ${c.placementId} parity=${c.parityWithProduction} final letter ${c.finalLetter} window start/mid/end=${f(fl0?.start, 4)}/${f(fl0?.mid, 4)}/${f(fl0?.end, 4)}`);
  const b = runAt(c, 0.88);
  console.log(`  baseline: case=${b.terminationCase} endReachable=${b.endReachability?.connected} farthestViable=${JSON.stringify(b.farthestViable)}`);
  console.log('    thr   returnedProg routeFinalProg finalLtr(enter/mid/end) finalLtrInk finalLtrCov zInk(t/d/b)    firstGoal(prog,cov,layer,last)  bestGoalProg goals  viable@1stGoal nonGoal maxViable@1stGoal beyond  maxViableEver  states  cap  finish         shape  cov    route/tgt feasible');
  for (const r of c.runs) {
    const t = r.telemetry;
    const q = r.quality;
    const fl = r.finalLetter;
    console.log(
      `    ${r.threshold.toFixed(2)}  ${f(t.returned?.progress)}${t.returned?.isGoal ? '' : '*'}        ${f(q?.routeFinalProgress, 4)}        ${fl ? `${fl.enters ? 'Y' : 'n'}/${fl.reachesMid ? 'Y' : 'n'}/${fl.reachesEnd ? 'Y' : 'n'}` : '-'}                   ${f(fl?.rawInk, 2)}        ${f(fl?.coverage, 3)}      ${fl?.zStrokeInk ? `${f(fl.zStrokeInk.top, 2)}/${f(fl.zStrokeInk.diagonal, 2)}/${f(fl.zStrokeInk.bottom, 2)}` : '   -     '}   ${t.firstGoal ? `${f(t.firstGoal.progress)},${f(t.firstGoal.coverage, 2)},L${t.firstGoal.layer},${t.firstGoal.lastSatisfied}` : 'none'}      ${f(t.bestProgressGoal?.progress)}       ${t.goalStatesEncountered}    ${t.atFirstGoal?.viableCount ?? '-'}            ${t.atFirstGoal?.viableNonGoalCount ?? '-'}      ${f(t.atFirstGoal?.maxViableProgress)}             ${t.atFirstGoal?.viableBeyond ?? '-'}      ${f(t.maxViableProgressEver)}         ${t.expansions}  ${t.maxExpansionsHit ? 'HIT' : 'no '}  ${t.finishReason.padEnd(14)} ${f(q?.shapeScore)}  ${f(q?.coverage)}  ${f(q?.routeTarget)}     ${q?.feasible}`,
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
        if (runAt(c, 0.88).quality) all.push(c);
      }
    }
  }
  const z = all.filter((c) => c.word === 'ROBZ');
  const o = all.filter((c) => c.word === 'CAIRO');

  console.log('');
  console.log(`=== PARITY (0.88 mirror+observer vs real production routeGraphConstrainedShape) === ${all.filter((c) => c.parityWithProduction).length}/${all.length} identical (path, statesExplored, failure)`);
  console.log(`  corpus: Z=${z.length} O=${o.length}; non-final-letter controls available only as R (ROBZ) and C/I (CAIRO) — the corpus has no word whose final letter is not Z or O.`);

  console.log('');
  console.log('=== B. THRESHOLD TABLE ===');
  thresholdTable('Z (ROBZ)', z);
  thresholdTable('O (CAIRO)', o);

  console.log('');
  console.log('=== C. GOAL TELEMETRY ===');
  goalTelemetry('Z (ROBZ)', z);
  goalTelemetry('O (CAIRO)', o);
  console.log('  first-goal beam, viable states near the end of the word (baseline 0.88): within5/within10/within20 (mean per candidate)');
  for (const [label, cs] of [['Z', z], ['O', o]] as const) {
    const g = cs.map((c) => runAt(c, 0.88).telemetry.atFirstGoal).filter((x): x is NonNullable<typeof x> => Boolean(x));
    console.log(`    ${label}: ${f(mean(g.map((x) => x.viableWithin5)), 1)}/${f(mean(g.map((x) => x.viableWithin10)), 1)}/${f(mean(g.map((x) => x.viableWithin20)), 1)}; final beam maxProgress mean=${f(mean(cs.map((c) => runAt(c, 0.88).telemetry.finalBeam?.maxProgress ?? 0)))} maxCoverage mean=${f(mean(cs.map((c) => runAt(c, 0.88).telemetry.finalBeam?.maxCoverage ?? 0)))} size mean=${f(mean(cs.map((c) => runAt(c, 0.88).telemetry.finalBeam?.size ?? 0)), 0)}`);
  }

  console.log('');
  console.log('=== G. TERMINATION CASES ===');
  caseTable('Z', z);
  caseTable('O', o);

  deepDive('ROBZ #1', z.find((c) => c.caseLabel === ROBZ1.caseLabel && c.placementId === ROBZ1.placementId));
  deepDive('ROBZ #2', z.find((c) => c.caseLabel === ROBZ2.caseLabel && c.placementId === ROBZ2.placementId));
  // O deep dives: the two CAIRO candidates with the highest BASELINE shapeScore (rule fixed before running).
  const oTop = [...o].sort((a, b) => (runAt(b, 0.88).quality?.shapeScore ?? 0) - (runAt(a, 0.88).quality?.shapeScore ?? 0)).slice(0, 2);
  oTop.forEach((c, i) => deepDive(`CAIRO/O #${i + 1} (top baseline shapeScore)`, c));

  console.log('');
  console.log('=== F. FINAL-LETTER vs NON-FINAL COMPARISON (per threshold) ===');
  for (const thr of GOAL_THRESHOLDS) {
    const row = (label: string, xs: Array<{ rawInk: number; coverage: number; physicallyCovered: boolean; passesEnd: boolean; reachesMid?: boolean; enters?: boolean }>) =>
      `${label}: n=${xs.length} enters=${xs.filter((x) => x.enters ?? true).length} reachesMid=${xs.filter((x) => x.reachesMid ?? true).length} reachesEnd=${xs.filter((x) => x.passesEnd).length} phys=${xs.filter((x) => x.physicallyCovered).length} rawInk=${f(mean(xs.map((x) => x.rawInk)), 2)} cov=${f(mean(xs.map((x) => x.coverage)), 3)}`;
    const fin = (cs: CandidateRecord[]) => cs.map((c) => runAt(c, thr).finalLetter).filter((x): x is FinalLetter => Boolean(x)).map((l) => ({ rawInk: l.rawInk, coverage: l.coverage, physicallyCovered: l.physicallyCovered, passesEnd: l.reachesEnd, reachesMid: l.reachesMid, enters: l.enters }));
    const ctl = (L: string) => all.flatMap((c) => runAt(c, thr).controls.filter((x) => x.letter === L)).map((x) => ({ rawInk: x.rawInk, coverage: x.coverage, physicallyCovered: x.physicallyCovered, passesEnd: x.routePassesLetterEnd }));
    console.log(`  ${thr.toFixed(2)}  ${row('Z(final)', fin(z))} | ${row('O(final)', fin(o))}`);
    console.log(`        ${row('R', ctl('R'))} | ${row('C', ctl('C'))} | ${row('I', ctl('I'))}`);
  }

  const outPath = resolve(DIAGNOSTIC_DIR, 'goal-threshold-diagnostic-results.json');
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), thresholds: GOAL_THRESHOLDS, params: GOAL_DIAGNOSTIC, graphShape: GRAPH_SHAPE, candidates: all }, null, 2), 'utf8');
  console.log('');
  console.log(`[goal-threshold] done in ${Math.round((Date.now() - started) / 1000)}s; json: ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
