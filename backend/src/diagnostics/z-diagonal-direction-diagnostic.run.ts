/**
 * DEVELOPMENT ONLY. Z diagonal directional-traversal diagnostic — tests
 * whether Z's failure is caused by the baseline route traversing the
 * diagonal in the wrong direction, or by the search not choosing a
 * directionally viable path that the graph supports. Diagnostic only; never
 * reroutes a candidate beyond re-running the SAME unmodified baseline mirror
 * (routeGraphConstrainedShapeMirror + REAL_ISGOAL) that every prior Z task
 * used. graph-shape.ts is never touched.
 *
 * Corpus: identical to z-letter-forensic-analysis.run.ts — ROBZ and CAIRO,
 * Alexandria/Zamalek, 2000/4000m, 'smooth' variant, feasible records only.
 * Z candidates are matched to the prior forensic classification by corpus
 * order + placementId (placementIds repeat across cases, so the id alone is
 * not a key).
 *
 * Thresholds live in DIRECTION_THRESHOLDS (z-diagonal-direction-
 * diagnostic.ts) and were frozen by the synthetic self-test before this
 * script was first run.
 *
 * Run with: npx tsx src/diagnostics/z-diagonal-direction-diagnostic.run.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { coverageThresholdMeters } from '../generation/target-identity';
import { scorePolylines } from '../scoring/shape-match';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, REAL_ISGOAL } from './graph-shape-goal-mirror';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { buildDirected, decomposeZStrokes, testConnectivity, type ConnectivityResult } from './letter-street-support-diagnostic';
import { measureSubStrokeCoverage, zStrokeRanges } from './z-checkpoint-repair-experiment';
import {
  analyzeStrokeTraversal,
  analyzeTransition,
  buildRoutePieces,
  directionalFeasibilityShadow,
  progressStop,
  summarizeGraphEdgesNearWindow,
  DIRECTION_THRESHOLDS,
  type DiagonalCategory,
  type DirectionalFeasibility,
  type GraphEdgeDirectionSummary,
  type ProgressStop,
  type RoutePiece,
  type StrokeTraversal,
  type StrokeWindow,
  type TransitionAnalysis,
} from './z-diagonal-direction-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CASES = [
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];
const ROBZ1 = { case: 'Zamalek/4000', placementId: 'sf-r315-s0.6-e-905.1-n905.1' };
const ROBZ2 = { case: 'Alexandria/2000', placementId: 'sf-r315-s0.8-e0-n-400' };
const INK = PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold;

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}
function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : Number.NaN;
}
function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
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
  const rx = ranks(x);
  const ry = ranks(y);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : Number.NaN;
}
const f = (v: number | null | undefined, d = 2) => (v == null || Number.isNaN(v) ? '  -  ' : v.toFixed(d));

// ---------------------------------------------------------------------------
// Records.
// ---------------------------------------------------------------------------

type ZDirectionRecord = {
  caseLabel: string;
  placementId: string;
  priorClassification: string;
  priorObservedRawInk: number | null;
  priorObservedCoverage: number | null;
  shapeScore: number;
  zRawInk: number;
  zCoverage: number;
  zPhysicallyCovered: boolean;
  strokeInk: { top: number; diagonal: number; bottom: number };
  windows: { p0: number; p1: number; p2: number; p3: number };
  radiusMeters: number;
  top: StrokeTraversal;
  diagonal: StrokeTraversal;
  bottom: StrokeTraversal;
  wholeZ: StrokeTraversal;
  transition1: TransitionAnalysis;
  transition2: TransitionAnalysis;
  connectivity: { topToDiagonal: ConnectivityResult; diagonalToBottom: ConnectivityResult };
  shadow: { top: DirectionalFeasibility; diagonal: DirectionalFeasibility; bottom: DirectionalFeasibility };
  diagonalEdges: GraphEdgeDirectionSummary;
  stop: ProgressStop;
  goalProgress: number;
  routeLengthMeters: number;
  routeTrace: string;
};

type ControlRecord = {
  word: string;
  letter: string;
  caseLabel: string;
  placementId: string;
  rawInk: number;
  coverage: number;
  physicallyCovered: boolean;
  traversal: StrokeTraversal;
  shadow: DirectionalFeasibility;
  letterEndProgress: number;
  stop: ProgressStop;
};

/** Run-length-encoded description of the route in Z-stroke-local terms, for deep dives. */
function describeRoute(pieces: readonly RoutePiece[], target: readonly Vec2[], boundaries: readonly LetterBoundary[], windows: StrokeWindow[]): string {
  const radius = coverageThresholdMeters(target);
  const labelOf = (p: RoutePiece): string => {
    if (p.perpendicularDistance > radius) return 'off';
    const w = windows.find((win) => p.progress >= win.start && p.progress <= win.end);
    if (w) return `Z.${w.label}`;
    const b = boundaries.find((bd) => p.progress >= bd.projectedStartProgress && p.progress <= bd.projectedEndProgress);
    return b ? b.letter : 'gap';
  };
  const tOf = (p: RoutePiece, label: string) => {
    const w = windows.find((win) => `Z.${win.label}` === label);
    return w ? (p.progress - w.start) / (w.end - w.start) : p.progress;
  };
  const runs: string[] = [];
  let cur: { label: string; meters: number; t0: number; t1: number } | null = null;
  for (const p of pieces) {
    const label = labelOf(p);
    if (!cur || cur.label !== label) {
      if (cur) runs.push(`${cur.label}[${cur.t0.toFixed(2)}→${cur.t1.toFixed(2)}|${Math.round(cur.meters)}m]`);
      cur = { label, meters: 0, t0: tOf(p, label), t1: tOf(p, label) };
    }
    cur.meters += p.length;
    cur.t1 = tOf(p, label);
  }
  if (cur) runs.push(`${cur.label}[${cur.t0.toFixed(2)}→${cur.t1.toFixed(2)}|${Math.round(cur.meters)}m]`);
  // Compress: drop runs shorter than 8m to keep it readable.
  return runs.filter((r) => !/\|[0-7]m\]$/.test(r)).join(' ');
}

function analyzeZ(caseLabel: string, record: FeasibilityRecord, prior: { classification: string; observedRawInk: number; observedCoverage: number } | null): ZDirectionRecord | null {
  const shape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const zBoundary = boundaries[3]!;
  const kind = shapeKindFromWord('ROBZ');
  const graph = reconstructGraph(record.graphLines);
  const baseline = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
  if (baseline.pathPoints.length < 2) return null;
  const route = baseline.pathPoints;
  const target = record.target;

  const physical = evaluatePhysicalWordTraversal('ROBZ', target, route, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const zLetter = physical.letters[3]!;
  const ranges = zStrokeRanges(zBoundary);
  const inks = measureSubStrokeCoverage(route, target, ranges);
  const ink = (label: string) => inks.find((s) => s.label === label)?.occupancy ?? 0;
  const windows: StrokeWindow[] = ranges.map((r) => ({ label: r.label, start: r.start, end: r.end }));
  const [topW, diagW, botW] = windows as [StrokeWindow, StrokeWindow, StrokeWindow];

  const pieces = buildRoutePieces(route, target);
  const { directed, outgoing } = buildDirected(graph, target, kind, false);
  const strokes = decomposeZStrokes(target, zBoundary);
  const mid = (pts: Vec2[]) => pts[Math.floor(pts.length / 2)]!;
  const k = DIRECTION_THRESHOLDS.endpointK;

  return {
    caseLabel,
    placementId: record.placementId,
    priorClassification: prior?.classification ?? 'unmatched',
    priorObservedRawInk: prior?.observedRawInk ?? null,
    priorObservedCoverage: prior?.observedCoverage ?? null,
    shapeScore: scorePolylines(route, target).score,
    zRawInk: zLetter.rawInkCoverage,
    zCoverage: zLetter.coverage,
    zPhysicallyCovered: zLetter.physicallyCovered,
    strokeInk: { top: ink('top'), diagonal: ink('diagonal'), bottom: ink('bottom') },
    windows: { p0: topW.start, p1: diagW.start, p2: botW.start, p3: botW.end },
    radiusMeters: coverageThresholdMeters(target),
    top: analyzeStrokeTraversal(pieces, target, topW),
    diagonal: analyzeStrokeTraversal(pieces, target, diagW),
    bottom: analyzeStrokeTraversal(pieces, target, botW),
    wholeZ: analyzeStrokeTraversal(pieces, target, { label: 'Z', start: zBoundary.projectedStartProgress, end: zBoundary.projectedEndProgress }),
    transition1: analyzeTransition(pieces, target, topW, diagW),
    transition2: analyzeTransition(pieces, target, diagW, botW),
    connectivity: {
      topToDiagonal: testConnectivity(directed, outgoing, graph, mid(strokes.top), mid(strokes.diagonal), k),
      diagonalToBottom: testConnectivity(directed, outgoing, graph, mid(strokes.diagonal), mid(strokes.bottom), k),
    },
    shadow: {
      top: directionalFeasibilityShadow(directed, graph.nodes, target, topW),
      diagonal: directionalFeasibilityShadow(directed, graph.nodes, target, diagW),
      bottom: directionalFeasibilityShadow(directed, graph.nodes, target, botW),
    },
    diagonalEdges: summarizeGraphEdgesNearWindow(directed, target, diagW),
    stop: progressStop(pieces, target),
    goalProgress: GRAPH_SHAPE.goalProgress,
    routeLengthMeters: polylineLength(route),
    routeTrace: describeRoute(pieces, target, boundaries, windows),
  };
}

function analyzeControl(word: string, letterIndex: number, caseLabel: string, record: FeasibilityRecord): ControlRecord | null {
  const shape = buildWalkableWordShape(word, { letterVariant: 'smooth' });
  const boundary = letterBoundariesFromWordShape(shape).boundaries[letterIndex]!;
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const baseline = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
  if (baseline.pathPoints.length < 2) return null;
  const physical = evaluatePhysicalWordTraversal(word, record.target, baseline.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const letter = physical.letters[letterIndex]!;
  const window: StrokeWindow = { label: boundary.letter, start: boundary.projectedStartProgress, end: boundary.projectedEndProgress };
  const pieces = buildRoutePieces(baseline.pathPoints, record.target);
  const { directed } = buildDirected(graph, record.target, kind, false);
  return {
    word,
    letter: boundary.letter,
    caseLabel,
    placementId: record.placementId,
    rawInk: letter.rawInkCoverage,
    coverage: letter.coverage,
    physicallyCovered: letter.physicallyCovered,
    traversal: analyzeStrokeTraversal(pieces, record.target, window),
    shadow: directionalFeasibilityShadow(directed, graph.nodes, record.target, window),
    letterEndProgress: boundary.projectedEndProgress,
    stop: progressStop(pieces, record.target),
  };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const CATEGORIES: DiagonalCategory[] = ['A_correct', 'B_reverse', 'C_crossing_grazing', 'D_missing', 'E_mixed_ambiguous'];

function categoryTable(label: string, traversals: readonly StrokeTraversal[]) {
  console.log(`  ${label} (n=${traversals.length})`);
  for (const c of CATEGORIES) {
    const n = traversals.filter((t) => t.category === c).length;
    console.log(`    ${c.padEnd(20)} ${String(n).padStart(3)}  ${((100 * n) / Math.max(1, traversals.length)).toFixed(1)}%`);
  }
}

function directionMetrics(label: string, traversals: readonly StrokeTraversal[]) {
  const present = traversals.filter((t) => t.signedAgreement != null);
  const signed = present.map((t) => t.signedAgreement!);
  const blind = present.map((t) => t.meanAgreement!);
  console.log(
    `  ${label.padEnd(18)} n=${traversals.length} withPieces=${present.length} signedAgree mean=${f(mean(signed))} med=${f(median(signed))} | blindAgree mean=${f(mean(blind))} | headingFwdFrac mean=${f(mean(present.map((t) => t.headingForwardFraction!)))} ` +
      `| fwdT mean=${f(mean(traversals.map((t) => t.forwardT)))} med=${f(median(traversals.map((t) => t.forwardT)))} revT mean=${f(mean(traversals.map((t) => t.reverseT)))} med=${f(median(traversals.map((t) => t.reverseT)))} ` +
      `| longestFwdRun mean=${f(mean(traversals.map((t) => t.longestForwardRunT)))} med=${f(median(traversals.map((t) => t.longestForwardRunT)))} longestRevRun mean=${f(mean(traversals.map((t) => t.longestReverseRunT)))} ` +
      `| coverage mean=${f(mean(traversals.map((t) => t.coverage)))} | route/target mean=${f(mean(traversals.map((t) => t.routeTargetRatio)))} med=${f(median(traversals.map((t) => t.routeTargetRatio)))} | reversals mean=${f(mean(traversals.map((t) => t.directionReversals)))}`,
  );
}

function printBins(t: StrokeTraversal) {
  console.log(`    bins (${t.label}; t = fraction along stroke in intended direction):`);
  console.log('      bin  t-range     progress-range   pieces entries  meters  tgtHdg  rteHdg  fullΔ   signedAg fwdT  revT');
  for (const b of t.bins) {
    console.log(
      `      ${b.bin}    ${b.tStart.toFixed(3)}-${b.tEnd.toFixed(3)} ${b.progressStart.toFixed(4)}-${b.progressEnd.toFixed(4)}  ${String(b.pieceCount).padStart(5)}  ${String(b.entries).padStart(5)}  ${b.routeMeters.toFixed(0).padStart(6)}  ${f(b.meanTargetHeadingDeg, 0).padStart(6)}  ${f(b.meanRouteHeadingDeg, 0).padStart(6)}  ${f(b.meanFullDeltaDeg, 0).padStart(5)}  ${f(b.signedAgreement).padStart(7)}  ${f(b.forwardT)}  ${f(b.reverseT)}`,
    );
  }
}

function printTraversal(t: StrokeTraversal) {
  console.log(
    `    ${t.label}: category=${t.category} (${t.categoryReason}) targetLen=${t.targetLengthMeters.toFixed(0)}m inWindowPath=${t.inWindowPathMeters.toFixed(0)}m ratio=${f(t.routeTargetRatio)} coverage=${f(t.coverage)} signedAg=${f(t.signedAgreement)} blindAg=${f(t.meanAgreement)} fullΔ=${f(t.meanFullDeltaDeg, 0)} ` +
      `fwdT=${f(t.forwardT)} revT=${f(t.reverseT)} fwdRun=${f(t.longestForwardRunT)} revRun=${f(t.longestReverseRunT)} reversals=${t.directionReversals} visits=${t.visits} tRange=[${f(t.minTReached)},${f(t.maxTReached)}] firstEntryT=${f(t.firstEntryT)} firstRun=${t.firstRunDirection}`,
  );
}

function printTransition(label: string, tr: TransitionAnalysis) {
  console.log(
    `    ${label}: corner@progress=${tr.cornerProgress.toFixed(4)} nearestRoute=${tr.nearestRouteDistanceMeters.toFixed(1)}m reached=${tr.reachedCorner} incomingSignedAg=${f(tr.incomingSignedAgreement)} (${tr.incomingMeters.toFixed(0)}m) outgoingSignedAg=${f(tr.outgoingSignedAgreement)} (${tr.outgoingMeters.toFixed(0)}m) ` +
      `progress before/at/after=${f(tr.progressBefore, 4)}/${f(tr.progressAtClosest, 4)}/${f(tr.progressAfter, 4)} continuesIntoOutgoing=${tr.continuesIntoOutgoing}`,
  );
}

function printShadow(label: string, s: DirectionalFeasibility) {
  console.log(`    shadow ${label}: pathFound=${s.pathFound} directionallySupported=${s.directionallySupported} detour=${f(s.directionalDetourRatio)} meanHeadingΔ=${f(s.meanHeadingDeltaDeg, 0)} reverseFrac=${f(s.reverseFraction)} signedAg=${f(s.signedAgreement)} (${s.reason})`);
}

function deepDive(label: string, r: ZDirectionRecord | undefined) {
  console.log('');
  console.log(`=== DEEP DIVE: ${label} ===`);
  if (!r) {
    console.log('  candidate not present in this run.');
    return;
  }
  console.log(`  ${r.caseLabel} ${r.placementId} prior=${r.priorClassification} shapeScore=${r.shapeScore.toFixed(3)} zRawInk=${r.zRawInk.toFixed(3)} zCoverage=${r.zCoverage.toFixed(3)} strokeInk top/diag/bottom=${r.strokeInk.top.toFixed(2)}/${r.strokeInk.diagonal.toFixed(2)}/${r.strokeInk.bottom.toFixed(2)}`);
  console.log(`  windows: top=[${r.windows.p0.toFixed(4)},${r.windows.p1.toFixed(4)}] diagonal=[${r.windows.p1.toFixed(4)},${r.windows.p2.toFixed(4)}] bottom=[${r.windows.p2.toFixed(4)},${r.windows.p3.toFixed(4)}] goalProgress=${r.goalProgress} radius=${r.radiusMeters.toFixed(1)}m`);
  console.log(`  progress stop: maxOnTarget=${f(r.stop.maxOnTargetProgress, 4)} finalPiece=${f(r.stop.finalPieceProgress, 4)} (perp ${f(r.stop.finalPiecePerpendicular, 1)}m) routeLength=${r.routeLengthMeters.toFixed(0)}m`);
  printTraversal(r.top);
  printTraversal(r.diagonal);
  printBins(r.diagonal);
  printTraversal(r.bottom);
  printBins(r.bottom);
  printTransition('top→diagonal', r.transition1);
  printTransition('diagonal→bottom', r.transition2);
  console.log(`    connectivity(K=3): top→diag=${r.connectivity.topToDiagonal.connected} (ratio ${f(r.connectivity.topToDiagonal.graphStraightRatio)}) diag→bottom=${r.connectivity.diagonalToBottom.connected} (ratio ${f(r.connectivity.diagonalToBottom.graphStraightRatio)})`);
  printShadow('top', r.shadow.top);
  printShadow('diagonal', r.shadow.diagonal);
  printShadow('bottom', r.shadow.bottom);
  console.log(`    diagonal graph edges: ${JSON.stringify(r.diagonalEdges)}`);
  console.log(`    route trace (≥8m runs): ${r.routeTrace}`);
}

async function main() {
  const started = Date.now();
  const priorPath = resolve(DIAGNOSTIC_DIR, 'z-letter-forensic-analysis-results.json');
  const priorZ: Array<{ placementId: string; classification: string; observedRawInk: number; observedCoverage: number }> = existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')).zRecords : [];

  const zRecords: ZDirectionRecord[] = [];
  const controls: ControlRecord[] = [];
  let zOrdinal = 0;
  let priorMismatches = 0;

  for (const testCase of CASES) {
    const caseLabel = `${testCase.locationName}/${testCase.targetDistanceMeters}`;
    const report = await runExperimentalPipelineMultiVariant({ word: 'ROBZ', start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters }, ['smooth']);
    const feasible = (report.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2);
    console.log(`[corpus] ROBZ ${caseLabel}: feasible=${feasible.length}`);
    for (const record of feasible) {
      const prior = priorZ[zOrdinal] && priorZ[zOrdinal]!.placementId === record.placementId ? priorZ[zOrdinal]! : null;
      if (!prior) priorMismatches += 1;
      const z = analyzeZ(caseLabel, record, prior);
      if (z) {
        zRecords.push(z);
        zOrdinal += 1;
      }
      const r = analyzeControl('ROBZ', 0, caseLabel, record);
      if (r) controls.push(r);
    }
  }
  for (const testCase of CASES) {
    const caseLabel = `${testCase.locationName}/${testCase.targetDistanceMeters}`;
    const report = await runExperimentalPipelineMultiVariant({ word: 'CAIRO', start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters }, ['smooth']);
    const feasible = (report.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2);
    console.log(`[corpus] CAIRO ${caseLabel}: feasible=${feasible.length}`);
    for (const record of feasible) {
      const c = analyzeControl('CAIRO', 0, caseLabel, record);
      if (c) controls.push(c);
      const i = analyzeControl('CAIRO', 2, caseLabel, record);
      if (i) controls.push(i);
      // O = CAIRO's LAST letter: the last-letter control for Z (ROBZ's last letter).
      const o = analyzeControl('CAIRO', 4, caseLabel, record);
      if (o) controls.push(o);
    }
  }

  console.log('');
  console.log(`=== CORPUS IDENTITY === Z candidates=${zRecords.length} (prior forensic=${priorZ.length}) priorOrderMismatches=${priorMismatches}`);
  const rawInkDiffs = zRecords.filter((r) => r.priorObservedRawInk != null && Math.abs(r.priorObservedRawInk - r.zRawInk) > 1e-9).length;
  const covDiffs = zRecords.filter((r) => r.priorObservedCoverage != null && Math.abs(r.priorObservedCoverage - r.zCoverage) > 1e-9).length;
  console.log(`  baseline reproduces prior Z rawInk on ${zRecords.length - rawInkDiffs}/${zRecords.length}, Z coverage on ${zRecords.length - covDiffs}/${zRecords.length}`);
  const priorCounts: Record<string, number> = {};
  for (const r of zRecords) priorCounts[r.priorClassification] = (priorCounts[r.priorClassification] ?? 0) + 1;
  console.log(`  prior classification: ${JSON.stringify(priorCounts)}`);

  console.log('');
  console.log('=== B. Z DIAGONAL TRAVERSAL CLASSIFICATION ===');
  categoryTable('diagonal (all Z)', zRecords.map((r) => r.diagonal));
  categoryTable('diagonal (prior B_search_failure only)', zRecords.filter((r) => r.priorClassification === 'B_search_failure').map((r) => r.diagonal));
  categoryTable('top (all Z)', zRecords.map((r) => r.top));
  categoryTable('bottom (all Z)', zRecords.map((r) => r.bottom));
  categoryTable('whole Z letter window', zRecords.map((r) => r.wholeZ));

  console.log('');
  console.log('=== C. DIRECTION METRICS ===');
  directionMetrics('Z top', zRecords.map((r) => r.top));
  directionMetrics('Z diagonal', zRecords.map((r) => r.diagonal));
  directionMetrics('Z bottom', zRecords.map((r) => r.bottom));
  directionMetrics('Z whole', zRecords.map((r) => r.wholeZ));
  const withDiag = zRecords.filter((r) => r.diagonal.inWindowPathMeters > 0);
  const agreeing = withDiag.filter((r) => (r.diagonal.headingForwardFraction ?? 0) >= 0.5 === r.diagonal.forwardT >= r.diagonal.reverseT).length;
  console.log(`  consistency: heading-direction (reverse flag) agrees with progress-direction on ${agreeing}/${withDiag.length} candidates with diagonal pieces`);

  console.log('');
  console.log('=== D. TRANSITION METRICS ===');
  for (const [label, pick, inc, out] of [
    ['top → diagonal', (r: ZDirectionRecord) => r.transition1, (r: ZDirectionRecord) => r.top, (r: ZDirectionRecord) => r.diagonal],
    ['diagonal → bottom', (r: ZDirectionRecord) => r.transition2, (r: ZDirectionRecord) => r.diagonal, (r: ZDirectionRecord) => r.bottom],
  ] as const) {
    const trs = zRecords.map(pick);
    const incoming = zRecords.map(inc);
    const outgoing = zRecords.map(out);
    console.log(
      `  ${label}: incomingStrokeCompleted(maxT≥0.8)=${incoming.filter((t) => (t.maxTReached ?? 0) >= 0.8).length}/${zRecords.length} ` +
        `cornerReached(≤${GRAPH_SHAPE.followRadiusMeters}m)=${trs.filter((t) => t.reachedCorner).length}/${zRecords.length} ` +
        `continuesIntoOutgoing=${trs.filter((t) => t.continuesIntoOutgoing).length}/${zRecords.length} ` +
        `outgoingEnteredForward(firstRun=forward & firstEntryT≤0.25)=${outgoing.filter((t) => t.firstRunDirection === 'forward' && (t.firstEntryT ?? 1) <= 0.25).length}/${zRecords.length} ` +
        `outgoingFirstRun: fwd=${outgoing.filter((t) => t.firstRunDirection === 'forward').length} rev=${outgoing.filter((t) => t.firstRunDirection === 'reverse').length} neutral=${outgoing.filter((t) => t.firstRunDirection === 'neutral').length} none=${outgoing.filter((t) => t.firstRunDirection === null).length} ` +
        `incomingSignedAg mean=${f(mean(trs.filter((t) => t.incomingSignedAgreement != null).map((t) => t.incomingSignedAgreement!)))} outgoingSignedAg mean=${f(mean(trs.filter((t) => t.outgoingSignedAgreement != null).map((t) => t.outgoingSignedAgreement!)))} (n=${trs.filter((t) => t.outgoingSignedAgreement != null).length})`,
    );
  }
  console.log('  where target progress stops (max on-target progress, in Z-stroke terms):');
  const stopBuckets: Record<string, number> = {};
  for (const r of zRecords) {
    const p = r.stop.maxOnTargetProgress ?? -1;
    const bucket = p < r.windows.p0 ? 'before Z' : p < r.windows.p1 ? 'in top' : p < r.windows.p2 ? 'in diagonal' : p < r.windows.p3 - 0.005 ? 'in bottom' : 'end of Z';
    stopBuckets[bucket] = (stopBuckets[bucket] ?? 0) + 1;
  }
  console.log(`    ${JSON.stringify(stopBuckets)}`);
  const bottomTStops = zRecords.map((r) => ((r.stop.maxOnTargetProgress ?? 0) - r.windows.p2) / (r.windows.p3 - r.windows.p2));
  console.log(`    max on-target t within bottom stroke: mean=${f(mean(bottomTStops))} median=${f(median(bottomTStops))}`);
  const zp = zRecords[0]?.windows;
  if (zp) console.log(`    Z windows (ROBZ, identical for every placement): p0=${zp.p0.toFixed(4)} p1=${zp.p1.toFixed(4)} p2=${zp.p2.toFixed(4)} p3=${zp.p3.toFixed(4)}; GRAPH_SHAPE.goalProgress=${GRAPH_SHAPE.goalProgress} → goal progress lies at bottom t=${f((GRAPH_SHAPE.goalProgress - zp.p2) / (zp.p3 - zp.p2))}`);
  const finalPerps = zRecords.map((r) => r.stop.finalPieceProgress ?? 0);
  console.log(`    final route point progress: mean=${f(mean(finalPerps), 4)} median=${f(median(finalPerps), 4)} min=${f(Math.min(...finalPerps), 4)} max=${f(Math.max(...finalPerps), 4)}`);

  console.log('');
  console.log('=== E. STRUCTURAL vs DIRECTIONAL vs ACTUAL (per Z candidate) ===');
  console.log('  case             placementId                      prior          T→D  D→B | diagShadow det  Δ°  | botShadow det  Δ°  | diag cat  signedAg | bot cat   | zCov');
  for (const r of zRecords) {
    console.log(
      `  ${r.caseLabel.padEnd(16)} ${r.placementId.padEnd(32)} ${r.priorClassification.slice(0, 14).padEnd(14)} ${String(r.connectivity.topToDiagonal.connected).padEnd(5)}${String(r.connectivity.diagonalToBottom.connected).padEnd(5)}| ${String(r.shadow.diagonal.directionallySupported).padEnd(6)} ${f(r.shadow.diagonal.directionalDetourRatio)} ${f(r.shadow.diagonal.meanHeadingDeltaDeg, 0).padStart(3)} | ${String(r.shadow.bottom.directionallySupported).padEnd(6)} ${f(r.shadow.bottom.directionalDetourRatio)} ${f(r.shadow.bottom.meanHeadingDeltaDeg, 0).padStart(3)} | ${r.diagonal.category.slice(0, 9).padEnd(9)} ${f(r.diagonal.signedAgreement).padStart(6)} | ${r.bottom.category.slice(0, 9).padEnd(9)} | ${r.zCoverage.toFixed(3)}`,
    );
  }
  const cross = (stroke: 'diagonal' | 'bottom', conn: (r: ZDirectionRecord) => boolean) => {
    const rows = zRecords.filter(conn);
    const dirSup = rows.filter((r) => r.shadow[stroke].directionallySupported);
    const traversedCorrect = dirSup.filter((r) => r[stroke].category === 'A_correct');
    const notTraversed = dirSup.filter((r) => r[stroke].category !== 'A_correct');
    const notSup = rows.filter((r) => !r.shadow[stroke].directionallySupported);
    console.log(
      `  ${stroke}: structurallyConnected=${rows.length}/${zRecords.length} → directionallySupported=${dirSup.length} (traversed correctly=${traversedCorrect.length}, NOT traversed correctly=${notTraversed.length} [${CATEGORIES.map((c) => `${c[0]}=${notTraversed.filter((r) => r[stroke].category === c).length}`).join(' ')}]) | not directionally supported=${notSup.length} (of which traversed correctly anyway=${notSup.filter((r) => r[stroke].category === 'A_correct').length})`,
    );
  };
  cross('diagonal', (r) => r.connectivity.topToDiagonal.connected);
  cross('bottom', (r) => r.connectivity.diagonalToBottom.connected);
  const both = zRecords.filter((r) => r.connectivity.topToDiagonal.connected && r.connectivity.diagonalToBottom.connected && r.shadow.diagonal.directionallySupported && r.shadow.bottom.directionallySupported);
  console.log(`  fully supported (both connections + both strokes directionally supported)=${both.length}/${zRecords.length}; of these diagonal A=${both.filter((r) => r.diagonal.category === 'A_correct').length} bottom A=${both.filter((r) => r.bottom.category === 'A_correct').length} both A=${both.filter((r) => r.diagonal.category === 'A_correct' && r.bottom.category === 'A_correct').length}`);
  console.log('  diagonal graph edges (13): allBidirectional on ' + zRecords.filter((r) => r.diagonalEdges.allBidirectional).length + `/${zRecords.length}; mean acuteΔ=${f(mean(zRecords.filter((r) => r.diagonalEdges.meanAcuteDeltaDeg != null).map((r) => r.diagonalEdges.meanAcuteDeltaDeg!)), 0)}° aligned≤30°=${f(mean(zRecords.map((r) => r.diagonalEdges.alignedFraction30)))} aligned≤45°=${f(mean(zRecords.map((r) => r.diagonalEdges.alignedFraction45)))} forwardCopyHeadingConsistency=${f(mean(zRecords.filter((r) => r.diagonalEdges.forwardCopyHeadingConsistency != null).map((r) => r.diagonalEdges.forwardCopyHeadingConsistency!)))}`);

  deepDive('ROBZ #1 (Zamalek/4000 sf-r315-s0.6-e-905.1-n905.1)', zRecords.find((r) => r.caseLabel === ROBZ1.case && r.placementId === ROBZ1.placementId));
  deepDive('ROBZ #2 (Alexandria/2000 sf-r315-s0.8-e0-n-400)', zRecords.find((r) => r.caseLabel === ROBZ2.case && r.placementId === ROBZ2.placementId));

  console.log('');
  console.log('=== H. R/C/I CONTROLS (whole-letter window, identical thresholds) vs Z ===');
  const groups: Array<[string, StrokeTraversal[], DirectionalFeasibility[]]> = [
    ['Z diagonal', zRecords.map((r) => r.diagonal), zRecords.map((r) => r.shadow.diagonal)],
    ['Z bottom', zRecords.map((r) => r.bottom), zRecords.map((r) => r.shadow.bottom)],
    ['Z whole', zRecords.map((r) => r.wholeZ), []],
    ...(['R', 'C', 'I', 'O'] as const).map((L) => [L, controls.filter((c) => c.letter === L).map((c) => c.traversal), controls.filter((c) => c.letter === L).map((c) => c.shadow)] as [string, StrokeTraversal[], DirectionalFeasibility[]]),
  ];
  console.log('  group        n   signedAg mean/med   correct%  reverse%  cross%  missing%  mixed%   fwdRun mean  route/target mean  dirSupported%');
  for (const [label, ts, shadows] of groups) {
    const pct = (c: DiagonalCategory) => ((100 * ts.filter((t) => t.category === c).length) / Math.max(1, ts.length)).toFixed(0).padStart(5);
    const signed = ts.filter((t) => t.signedAgreement != null).map((t) => t.signedAgreement!);
    console.log(
      `  ${label.padEnd(11)} ${String(ts.length).padStart(3)}   ${f(mean(signed))}/${f(median(signed))}        ${pct('A_correct')}    ${pct('B_reverse')}   ${pct('C_crossing_grazing')}    ${pct('D_missing')}   ${pct('E_mixed_ambiguous')}      ${f(mean(ts.map((t) => t.longestForwardRunT)))}          ${f(mean(ts.map((t) => t.routeTargetRatio)))}             ${shadows.length ? ((100 * shadows.filter((s) => s.directionallySupported).length) / shadows.length).toFixed(0) : '  -'}`,
    );
  }

  console.log('  route stop relative to letter end (final route point progress − letter end progress):');
  for (const L of ['R', 'C', 'I', 'O'] as const) {
    const rows = controls.filter((c) => c.letter === L);
    const beyond = rows.filter((c) => (c.stop.finalPieceProgress ?? 0) >= c.letterEndProgress - 0.005).length;
    console.log(`    ${L}: route continues to/past letter end on ${beyond}/${rows.length}`);
  }
  console.log(`    Z: route continues to/past letter end on ${zRecords.filter((r) => (r.stop.finalPieceProgress ?? 0) >= r.windows.p3 - 0.005).length}/${zRecords.length}`);
  const oRows = controls.filter((c) => c.letter === 'O');
  if (oRows.length) {
    const oEnd = oRows[0]!.letterEndProgress;
    const oStart = oEnd - (oRows[0]!.traversal.window.end - oRows[0]!.traversal.window.start);
    console.log(`    O window=[${oStart.toFixed(4)},${oEnd.toFixed(4)}] goalProgress=${GRAPH_SHAPE.goalProgress} → goal lies at O t=${f((GRAPH_SHAPE.goalProgress - oStart) / (oEnd - oStart))}; O physicallyCovered=${oRows.filter((c) => c.physicallyCovered).length}/${oRows.length} mean rawInk=${f(mean(oRows.map((c) => c.rawInk)))} mean coverage=${f(mean(oRows.map((c) => c.coverage)))}`);
    const oStops = oRows.map((c) => ((c.stop.finalPieceProgress ?? 0) - oStart) / (oEnd - oStart));
    console.log(`    O: final route point at O t mean=${f(mean(oStops))} median=${f(median(oStops))}`);
  }
  for (const L of ['R', 'C', 'I'] as const) {
    const rows = controls.filter((c) => c.letter === L);
    console.log(`    ${L}: physicallyCovered=${rows.filter((c) => c.physicallyCovered).length}/${rows.length} mean rawInk=${f(mean(rows.map((c) => c.rawInk)))} mean coverage=${f(mean(rows.map((c) => c.coverage)))}`);
  }
  const zT = zRecords.map((r) => ((r.stop.finalPieceProgress ?? 0) - r.windows.p0) / (r.windows.p3 - r.windows.p0));
  console.log(`    Z: final route point at Z t mean=${f(mean(zT))} median=${f(median(zT))} (Z t: top 0–${f((zRecords[0]!.windows.p1 - zRecords[0]!.windows.p0) / (zRecords[0]!.windows.p3 - zRecords[0]!.windows.p0))}, diagonal to ${f((zRecords[0]!.windows.p2 - zRecords[0]!.windows.p0) / (zRecords[0]!.windows.p3 - zRecords[0]!.windows.p0))}, bottom to 1)`);

  console.log('');
  console.log('=== I. CORRELATION / SEPARATION (n=' + zRecords.length + ' Z) ===');
  const outcome = zRecords.map((r) => r.zCoverage);
  const features: Array<[string, (r: ZDirectionRecord) => number]> = [
    ['diag signedAgreement', (r) => r.diagonal.signedAgreement ?? 0],
    ['diag blind agreement', (r) => r.diagonal.meanAgreement ?? 0],
    ['diag forwardT', (r) => r.diagonal.forwardT],
    ['diag reverseT', (r) => r.diagonal.reverseT],
    ['diag longestFwdRun', (r) => r.diagonal.longestForwardRunT],
    ['diag route/target', (r) => r.diagonal.routeTargetRatio],
    ['diag coverage', (r) => r.diagonal.coverage],
    ['T1 continuesIntoDiag', (r) => (r.transition1.continuesIntoOutgoing ? 1 : 0)],
    ['T2 continuesIntoBottom', (r) => (r.transition2.continuesIntoOutgoing ? 1 : 0)],
    ['T2 outgoing signedAg', (r) => r.transition2.outgoingSignedAgreement ?? 0],
    ['diag dirSupported', (r) => (r.shadow.diagonal.directionallySupported ? 1 : 0)],
    ['bottom dirSupported', (r) => (r.shadow.bottom.directionallySupported ? 1 : 0)],
    ['diag shadow detour', (r) => r.shadow.diagonal.directionalDetourRatio ?? 9],
    ['T→D connected', (r) => (r.connectivity.topToDiagonal.connected ? 1 : 0)],
    ['D→B connected', (r) => (r.connectivity.diagonalToBottom.connected ? 1 : 0)],
    ['bottom forwardT', (r) => r.bottom.forwardT],
    ['bottom longestFwdRun', (r) => r.bottom.longestForwardRunT],
    ['max on-target progress', (r) => r.stop.maxOnTargetProgress ?? 0],
  ];
  const good = zRecords.filter((r) => r.zCoverage >= 0.25);
  const bad = zRecords.filter((r) => r.zCoverage < 0.25);
  console.log(`  outcome = Z coverage (target-identity). split: meaningful (zCoverage≥0.25) n=${good.length} vs not n=${bad.length}; zPhysicallyCovered=${zRecords.filter((r) => r.zPhysicallyCovered).length}`);
  console.log('  feature                    spearman(vs zCov)   mean[meaningful]  mean[not]');
  for (const [name, fn] of features) {
    console.log(`  ${name.padEnd(26)} ${f(spearman(zRecords.map(fn), outcome)).padStart(8)}           ${f(mean(good.map(fn))).padStart(6)}          ${f(mean(bad.map(fn))).padStart(6)}`);
  }

  const outPath = resolve(DIAGNOSTIC_DIR, 'z-diagonal-direction-diagnostic-results.json');
  const strip = (t: StrokeTraversal) => t; // bins kept intentionally (needed for per-bin review)
  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), thresholds: DIRECTION_THRESHOLDS, zRecords: zRecords.map((r) => ({ ...r, top: strip(r.top), diagonal: strip(r.diagonal), bottom: strip(r.bottom) })), controls }, null, 2),
    'utf8',
  );
  console.log('');
  console.log(`[z-diagonal-direction] done in ${Math.round((Date.now() - started) / 1000)}s; json: ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
