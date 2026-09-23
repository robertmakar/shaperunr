/**
 * DEVELOPMENT ONLY. Forensic causal diagnosis of why Z is categorically
 * unrepairable while R/C/I are meaningfully repairable — diagnostic only,
 * never wired into production. graph-shape.ts is never touched.
 *
 * Reuses, unmodified: explodeDirected/indexOutgoing (beam-search-trace.ts),
 * findShortestConnectingPath (letter-transition-diagnostic.ts),
 * evaluatePhysicalWordTraversal (physical-word-traversal-evaluator.ts),
 * scorePolylines. The only new code is letter-street-support-diagnostic.ts
 * (stroke decomposition + distance/orientation measurement) — a pure
 * measurement layer with no search, no routing, no cost function.
 *
 * Run with: npx tsx src/diagnostics/z-letter-forensic-analysis.run.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import {
  decomposeZStrokes,
  measureStreetSupport,
  measureOrientationSupport,
  buildDirected,
  testConnectivity,
  type DistanceDistribution,
  type OrientationDistribution,
  type ConnectivityResult,
  type ZStrokes,
} from './letter-street-support-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { routeGraphConstrainedShapeMirror, REAL_ISGOAL } from './graph-shape-goal-mirror';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

function sliceLetterPolyline(target: readonly Vec2[], boundary: LetterBoundary): Vec2[] {
  return sliceByProgress(target, boundary.projectedStartProgress, boundary.projectedEndProgress);
}
function sliceByProgress(target: readonly Vec2[], start: number, end: number): Vec2[] {
  const samples: Vec2[] = [];
  const n = 96;
  for (let i = 0; i <= n; i += 1) {
    const progress = i / n;
    if (progress < start - 0.005 || progress > end + 0.005) continue;
    const idx = Math.min(target.length - 1, Math.max(0, Math.round(progress * (target.length - 1))));
    samples.push(target[idx]!);
  }
  return samples.length >= 2 ? samples : target.slice(0, 2);
}

// ---------------------------------------------------------------------------
// Z forensic record.
// ---------------------------------------------------------------------------

type ZForensicRecord = {
  placementId: string;
  topSupport: DistanceDistribution;
  diagonalSupport: DistanceDistribution;
  bottomSupport: DistanceDistribution;
  topOrientation: Record<number, OrientationDistribution>;
  diagonalOrientation: Record<number, OrientationDistribution>;
  bottomOrientation: Record<number, OrientationDistribution>;
  topToDiagonal: Record<number, ConnectivityResult>;
  diagonalToBottom: Record<number, ConnectivityResult>;
  observedRawInk: number;
  observedCoverage: number;
  observedPhysicallyCovered: number; // 0 or 1
  classification: 'A_graph_unsupported' | 'B_search_failure' | 'C_geometry_mismatch' | 'AMBIGUOUS';
};

type ComparisonLetterRecord = {
  word: string;
  placementId: string;
  letter: string;
  support: DistanceDistribution;
  orientation: Record<number, OrientationDistribution>;
  observedRawInk: number;
  observedCoverage: number;
  observedPhysicallyCovered: number;
};

const RADII = [20, 30, 50];
const CONNECTIVITY_K = [1, 3, 5];

function classifyZ(record: Omit<ZForensicRecord, 'classification'>): ZForensicRecord['classification'] {
  const topBottomWellSupported = record.topSupport.fractionWithin.at30 >= 0.5 && record.bottomSupport.fractionWithin.at30 >= 0.5;
  const diagonalWellSupported = record.diagonalSupport.fractionWithin.at30 >= 0.5;
  const diagonalOrientationOk = (record.diagonalOrientation[30]?.fractionWithin.deg45 ?? 0) >= 0.3;
  const topToDiagConnected = record.topToDiagonal[3]?.connected ?? false;
  const diagToBotConnected = record.diagonalToBottom[3]?.connected ?? false;

  if (!diagonalWellSupported || !topToDiagConnected || !diagToBotConnected) {
    return 'A_graph_unsupported';
  }
  if (diagonalWellSupported && topToDiagConnected && diagToBotConnected && topBottomWellSupported) {
    // Structurally feasible by every measured signal — but does the ACTUAL baseline route achieve it?
    if (record.observedPhysicallyCovered === 0 && record.observedCoverage < 0.4) {
      return 'B_search_failure';
    }
    if (!diagonalOrientationOk) {
      return 'C_geometry_mismatch'; // supported in proximity but the required orientation is a poor match for available streets
    }
    return record.observedPhysicallyCovered === 1 ? 'AMBIGUOUS' : 'B_search_failure';
  }
  return 'AMBIGUOUS';
}

async function analyzeZCandidate(record: FeasibilityRecord): Promise<ZForensicRecord | null> {
  const shape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const zBoundary = boundaries[3]!;
  const strokes: ZStrokes = decomposeZStrokes(record.target, zBoundary);
  const corridorLines = record.graphLines;

  const topSupport = measureStreetSupport(strokes.top, corridorLines);
  const diagonalSupport = measureStreetSupport(strokes.diagonal, corridorLines);
  const bottomSupport = measureStreetSupport(strokes.bottom, corridorLines);

  const topOrientation: Record<number, OrientationDistribution> = {};
  const diagonalOrientation: Record<number, OrientationDistribution> = {};
  const bottomOrientation: Record<number, OrientationDistribution> = {};
  for (const radius of RADII) {
    topOrientation[radius] = measureOrientationSupport(strokes.top, corridorLines, radius);
    diagonalOrientation[radius] = measureOrientationSupport(strokes.diagonal, corridorLines, radius);
    bottomOrientation[radius] = measureOrientationSupport(strokes.bottom, corridorLines, radius);
  }

  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord('ROBZ');
  const { directed, outgoing } = buildDirected(graph, record.target, kind, false);
  // IMPORTANT: use each stroke's MIDPOINT, not its shared boundary/corner
  // point with the adjacent stroke — top's end and diagonal's start are
  // (near-)identical target points, so their K-nearest-node sets would
  // heavily overlap, and findShortestConnectingPath deliberately EXCLUDES
  // any node present in BOTH the from-set and to-set from counting as a
  // valid destination (it's designed to avoid a trivial same-node short-
  // circuit for its original checkpoint-sequence use case, where
  // checkpoints are normally far apart). Using midpoints gives two
  // genuinely separated representative points, avoiding that false
  // "not connected" artifact entirely — confirmed by first observing a
  // systematic 0/38 connectivity result with boundary points, tracing it
  // to this exact guard, and switching to midpoints before trusting any
  // connectivity conclusion.
  const topMid = strokes.top[Math.floor(strokes.top.length / 2)]!;
  const diagonalMid = strokes.diagonal[Math.floor(strokes.diagonal.length / 2)]!;
  const bottomMid = strokes.bottom[Math.floor(strokes.bottom.length / 2)]!;
  const topToDiagonal: Record<number, ConnectivityResult> = {};
  const diagonalToBottom: Record<number, ConnectivityResult> = {};
  for (const k of CONNECTIVITY_K) {
    topToDiagonal[k] = testConnectivity(directed, outgoing, graph, topMid, diagonalMid, k);
    diagonalToBottom[k] = testConnectivity(directed, outgoing, graph, diagonalMid, bottomMid, k);
  }

  // Observed baseline route Z coverage — reuse the real, unmodified mirror + physical evaluator.
  const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
  if (baselineResult.pathPoints.length < 2) return null;
  const physical = evaluatePhysicalWordTraversal('ROBZ', record.target, baselineResult.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const zLetter = physical.letters[3]!;

  const partial = {
    placementId: record.placementId,
    topSupport, diagonalSupport, bottomSupport,
    topOrientation, diagonalOrientation, bottomOrientation,
    topToDiagonal, diagonalToBottom,
    observedRawInk: zLetter.rawInkCoverage,
    observedCoverage: zLetter.coverage,
    observedPhysicallyCovered: zLetter.physicallyCovered ? 1 : 0,
  };
  return { ...partial, classification: classifyZ(partial) };
}

async function analyzeComparisonLetter(word: string, record: FeasibilityRecord, letterIndex: number): Promise<ComparisonLetterRecord | null> {
  const shape = buildWalkableWordShape(word, { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const boundary = boundaries[letterIndex]!;
  const strokePolyline = sliceLetterPolyline(record.target, boundary);
  const support = measureStreetSupport(strokePolyline, record.graphLines);
  const orientation: Record<number, OrientationDistribution> = {};
  for (const radius of RADII) orientation[radius] = measureOrientationSupport(strokePolyline, record.graphLines, radius);

  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
  if (baselineResult.pathPoints.length < 2) return null;
  const physical = evaluatePhysicalWordTraversal(word, record.target, baselineResult.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const letter = physical.letters[letterIndex]!;

  return { word, placementId: record.placementId, letter: boundary.letter, support, orientation, observedRawInk: letter.rawInkCoverage, observedCoverage: letter.coverage, observedPhysicallyCovered: letter.physicallyCovered ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const CASES: Array<{ word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function summarizeSupport(label: string, records: readonly DistanceDistribution[]) {
  const valid = records.filter((r) => r.n > 0);
  console.log(
    `  ${label}: n=${valid.length} meanOfMin=${mean(valid.map((r) => r.min)).toFixed(1)}m meanOfMean=${mean(valid.map((r) => r.mean)).toFixed(1)}m meanOfP90=${mean(valid.map((r) => r.p90)).toFixed(1)}m ` +
      `frac@10=${mean(valid.map((r) => r.fractionWithin.at10)).toFixed(3)} @20=${mean(valid.map((r) => r.fractionWithin.at20)).toFixed(3)} @30=${mean(valid.map((r) => r.fractionWithin.at30)).toFixed(3)} @50=${mean(valid.map((r) => r.fractionWithin.at50)).toFixed(3)}`,
  );
}
function summarizeOrientation(label: string, records: readonly OrientationDistribution[]) {
  const valid = records.filter((r) => r.n > 0);
  if (valid.length === 0) {
    console.log(`  ${label}: no edges found within radius`);
    return;
  }
  console.log(`  ${label}: n=${valid.length} meanDelta=${mean(valid.map((r) => r.mean)).toFixed(1)}deg frac<=30deg=${mean(valid.map((r) => r.fractionWithin.deg30)).toFixed(3)} frac<=45deg=${mean(valid.map((r) => r.fractionWithin.deg45)).toFixed(3)}`);
}

async function main() {
  const started = Date.now();
  const zRecords: ZForensicRecord[] = [];
  const comparisonRecords: ComparisonLetterRecord[] = [];

  for (const testCase of CASES) {
    const report = await runExperimentalPipelineMultiVariant({ word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters }, ['smooth']);
    const feasible = (report.diagnostics.feasibility ?? []).filter((f) => f.feasible && f.pathPoints.length >= 2);
    console.log(`[corpus] ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m: feasible=${feasible.length}`);
    for (const record of feasible) {
      if (testCase.word === 'ROBZ') {
        const z = await analyzeZCandidate(record);
        if (z) zRecords.push(z);
        const r = await analyzeComparisonLetter('ROBZ', record, 0); // R = index 0
        if (r) comparisonRecords.push(r);
      } else {
        const c = await analyzeComparisonLetter('CAIRO', record, 0); // C = index 0
        if (c) comparisonRecords.push(c);
        const i = await analyzeComparisonLetter('CAIRO', record, 2); // I = index 2
        if (i) comparisonRecords.push(i);
      }
    }
  }

  console.log('');
  console.log(`=== Z STROKE-LEVEL STREET SUPPORT (n=${zRecords.length} Z candidates) ===`);
  summarizeSupport('top', zRecords.map((r) => r.topSupport));
  summarizeSupport('diagonal', zRecords.map((r) => r.diagonalSupport));
  summarizeSupport('bottom', zRecords.map((r) => r.bottomSupport));

  console.log('');
  console.log('=== Z ORIENTATION SUPPORT ===');
  for (const radius of RADII) {
    console.log(` @${radius}m:`);
    summarizeOrientation('  top', zRecords.map((r) => r.topOrientation[radius]!));
    summarizeOrientation('  diagonal', zRecords.map((r) => r.diagonalOrientation[radius]!));
    summarizeOrientation('  bottom', zRecords.map((r) => r.bottomOrientation[radius]!));
  }

  console.log('');
  console.log('=== Z COMPONENT CONNECTIVITY ===');
  for (const k of CONNECTIVITY_K) {
    const topDiag = zRecords.map((r) => r.topToDiagonal[k]!);
    const diagBot = zRecords.map((r) => r.diagonalToBottom[k]!);
    const topDiagConnected = topDiag.filter((c) => c.connected);
    const diagBotConnected = diagBot.filter((c) => c.connected);
    console.log(
      `  K=${k}: top->diagonal connected=${topDiagConnected.length}/${topDiag.length} meanRatio=${mean(topDiagConnected.map((c) => c.graphStraightRatio ?? 0)).toFixed(2)} | diagonal->bottom connected=${diagBotConnected.length}/${diagBot.length} meanRatio=${mean(diagBotConnected.map((c) => c.graphStraightRatio ?? 0)).toFixed(2)}`,
    );
  }

  console.log('');
  console.log('=== Z OBSERVED BASELINE COVERAGE vs STRUCTURAL EVIDENCE ===');
  console.log(`  mean observed rawInk=${mean(zRecords.map((r) => r.observedRawInk)).toFixed(3)} mean observed coverage=${mean(zRecords.map((r) => r.observedCoverage)).toFixed(3)} physicallyCovered=${zRecords.filter((r) => r.observedPhysicallyCovered === 1).length}/${zRecords.length}`);

  console.log('');
  console.log('=== Z vs R/C/I COMPARISON (whole-letter street support) ===');
  const byLetter: Record<string, ComparisonLetterRecord[]> = {};
  for (const r of comparisonRecords) (byLetter[r.letter] ??= []).push(r);
  byLetter['Z'] = zRecords.map((r) => ({ word: 'ROBZ', placementId: r.placementId, letter: 'Z', support: { n: r.topSupport.n + r.diagonalSupport.n + r.bottomSupport.n, min: Math.min(r.topSupport.min, r.diagonalSupport.min, r.bottomSupport.min), mean: mean([r.topSupport.mean, r.diagonalSupport.mean, r.bottomSupport.mean]), p90: Math.max(r.topSupport.p90, r.diagonalSupport.p90, r.bottomSupport.p90), fractionWithin: { at10: mean([r.topSupport.fractionWithin.at10, r.diagonalSupport.fractionWithin.at10, r.bottomSupport.fractionWithin.at10]), at20: mean([r.topSupport.fractionWithin.at20, r.diagonalSupport.fractionWithin.at20, r.bottomSupport.fractionWithin.at20]), at30: mean([r.topSupport.fractionWithin.at30, r.diagonalSupport.fractionWithin.at30, r.bottomSupport.fractionWithin.at30]), at50: mean([r.topSupport.fractionWithin.at50, r.diagonalSupport.fractionWithin.at50, r.bottomSupport.fractionWithin.at50]) } }, orientation: r.topOrientation, observedRawInk: r.observedRawInk, observedCoverage: r.observedCoverage, observedPhysicallyCovered: r.observedPhysicallyCovered }));
  for (const letter of ['Z', 'R', 'C', 'I']) {
    const records = byLetter[letter] ?? [];
    if (records.length === 0) continue;
    console.log(`--- ${letter} (n=${records.length}) ---`);
    summarizeSupport('  wholeLetter', records.map((r) => r.support));
    console.log(`    mean observedRawInk=${mean(records.map((r) => r.observedRawInk)).toFixed(3)} mean observedCoverage=${mean(records.map((r) => r.observedCoverage)).toFixed(3)} physicallyCovered=${records.filter((r) => r.observedPhysicallyCovered === 1).length}/${records.length}`);
  }

  console.log('');
  console.log('=== HYPOTHESIS CLASSIFICATION (per Z candidate) ===');
  const classCounts: Record<string, number> = {};
  for (const r of zRecords) {
    classCounts[r.classification] = (classCounts[r.classification] ?? 0) + 1;
    console.log(`  ${r.placementId}: ${r.classification} (topSupport@30=${r.topSupport.fractionWithin.at30.toFixed(2)} diagSupport@30=${r.diagonalSupport.fractionWithin.at30.toFixed(2)} botSupport@30=${r.bottomSupport.fractionWithin.at30.toFixed(2)} topDiagConn(K3)=${r.topToDiagonal[3]?.connected} diagBotConn(K3)=${r.diagonalToBottom[3]?.connected} observedCoverage=${r.observedCoverage.toFixed(3)})`);
  }
  console.log(`classification distribution: ${JSON.stringify(classCounts)}`);

  console.log('');
  console.log('=== FORENSIC: ROBZ #1 and ROBZ #2 ===');
  const robz1 = zRecords.find((r) => r.placementId === 'sf-r315-s0.6-e-905.1-n905.1');
  if (robz1) console.log(`ROBZ #1: ${JSON.stringify(robz1)}`);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'z-letter-forensic-analysis-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), zRecords, comparisonRecords }, null, 2), 'utf8');

  console.log('');
  console.log(`[z-letter-forensic-analysis] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[z-letter-forensic-analysis] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
