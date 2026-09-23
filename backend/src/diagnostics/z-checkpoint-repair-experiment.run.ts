/**
 * DEVELOPMENT ONLY. Tests whether targeted, SUB-LETTER checkpoint anchoring
 * (z-checkpoint-repair-experiment.ts) can repair the dominant Z B_search_
 * failure candidates identified by the prior Z Letter Forensic Analysis
 * (z-letter-forensic-analysis.run.ts) — diagnostic only, never wired into
 * production, never changing route generation, scoring, gates, or
 * thresholds. graph-shape.ts is never touched.
 *
 * Reused, unmodified: routeGraphConstrainedShapeMirror/REAL_ISGOAL (graph-
 * shape-goal-mirror.ts), makeCheckpointExtraMaskUpdate (checkpoint-
 * anchoring-diagnostic.ts), evaluateRepairGate/REPAIR_GUARDRAILS
 * (checkpoint-repair-gate-diagnostic.ts), evaluatePhysicalWordTraversal,
 * decomposeContinuity, decomposeTargetSpan, scorePolylines. New (this
 * task): z-checkpoint-repair-experiment.ts's sub-letter progress-
 * checkpoint mechanism, and this script's own bookkeeping/reporting.
 *
 * No hindsight tuning: K in {1,3,5} and CHECKPOINT_PENALTY=60 (the SAME
 * value used unchanged across every prior checkpoint-anchoring task) are
 * both fixed BEFORE looking at any result below and never adjusted after.
 *
 * Run with: npx tsx src/diagnostics/z-checkpoint-repair-experiment.run.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, REAL_ISGOAL } from './graph-shape-goal-mirror';
import { scorePolylines } from '../scoring/shape-match';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { decomposeContinuity } from './continuity-decomposition-diagnostic';
import { decomposeTargetSpan } from './target-span-decomposition-diagnostic';
import { evaluateRepairGate, type RouteMetricsForGate, type LetterQuality } from './checkpoint-repair-gate-diagnostic';
import { makeCheckpointExtraMaskUpdate } from './checkpoint-anchoring-diagnostic';
import {
  buildZLandmarks,
  buildGenericThreeWayLandmarks,
  buildProgressCheckpoints,
  indexProgressCheckpointBits,
  makeProgressCheckpointAugmenter,
  checkpointReachedByRoute,
  measureSubStrokeCoverage,
  zStrokeRanges,
  classifyZFailureMode,
  type ProgressLandmark,
  type ZFailureMode,
} from './z-checkpoint-repair-experiment';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CHECKPOINT_PENALTY = 60;
const K_VALUES = [1, 3, 5] as const;
const INK_THRESHOLD = PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold;

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// Whole-word gate metrics (unchanged pattern reused from targeted-
// checkpoint-repair-evaluation.run.ts).
// ---------------------------------------------------------------------------

function computeGateMetrics(word: string, target: Vec2[], pathPoints: Vec2[]): RouteMetricsForGate | null {
  if (pathPoints.length < 2) return null;
  const scored = scorePolylines(pathPoints, target);
  const continuity = decomposeContinuity(word, target, pathPoints, 'smooth');
  const physical = evaluatePhysicalWordTraversal(word, target, pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const targetSpanDecomp = decomposeTargetSpan(word, target, pathPoints, 'smooth');
  const letters: LetterQuality[] = physical.letters.map((l) => ({ letter: l.letter, rawInkCoverage: l.rawInkCoverage, coverage: l.coverage, physicallyCovered: l.physicallyCovered }));
  return { shapeScore: scored.score, coverage: scored.coverage, backtrack: scored.details.backtrackRatio, lengthRatio: targetSpanDecomp.lengthRatioProjected, continuityValid: continuity.continuityValid, letters };
}

// ---------------------------------------------------------------------------
// Per-candidate stroke-level snapshot (shared shape for baseline & treatment).
// ---------------------------------------------------------------------------

type StrokeSnapshot = {
  shapeScore: number;
  targetCoverage: number;
  backtrack: number;
  lengthRatio: number;
  routeDistanceMeters: number;
  zRawInk: number;
  zCoverage: number;
  zPhysicallyCovered: boolean;
  topInk: number;
  diagonalInk: number;
  bottomInk: number;
  strokesMeaningfullyCovered: number;
  checkpoint1Reached: boolean;
  checkpoint2Reached: boolean;
  checkpoint3Reached: boolean;
  transitionsInOrder: boolean;
  failureMode: ZFailureMode;
};

function snapshotZ(word: string, record: FeasibilityRecord, zBoundary: LetterBoundary, zLetterIndex: number, landmarks: ProgressLandmark[], pathPoints: Vec2[]): StrokeSnapshot | null {
  if (pathPoints.length < 2) return null;
  const scored = scorePolylines(pathPoints, record.target);
  const targetSpanDecomp = decomposeTargetSpan(word, record.target, pathPoints, 'smooth');
  const physical = evaluatePhysicalWordTraversal(word, record.target, pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const zLetter = physical.letters[zLetterIndex]!;
  const ranges = zStrokeRanges(zBoundary);
  const strokeCoverage = measureSubStrokeCoverage(pathPoints, record.target, ranges);
  const topInk = strokeCoverage.find((s) => s.label === 'top')?.occupancy ?? 0;
  const diagonalInk = strokeCoverage.find((s) => s.label === 'diagonal')?.occupancy ?? 0;
  const bottomInk = strokeCoverage.find((s) => s.label === 'bottom')?.occupancy ?? 0;
  const strokesMeaningfullyCovered = [topInk, diagonalInk, bottomInk].filter((v) => v >= INK_THRESHOLD).length;

  const r1 = checkpointReachedByRoute(pathPoints, landmarks[0]!.coordinate);
  const r2 = checkpointReachedByRoute(pathPoints, landmarks[1]!.coordinate);
  const r3 = checkpointReachedByRoute(pathPoints, landmarks[2]!.coordinate);
  const transitionsInOrder = r1.reached && r2.reached && r3.reached && r1.nearestIndex <= r2.nearestIndex && r2.nearestIndex <= r3.nearestIndex;

  const failureMode = classifyZFailureMode({
    topInk, diagonalInk, bottomInk,
    checkpoint1Reached: r1.reached, checkpoint2Reached: r2.reached, checkpoint3Reached: r3.reached,
    wholeZPhysicallyCovered: zLetter.physicallyCovered,
    inkThreshold: INK_THRESHOLD,
  });

  return {
    shapeScore: scored.score,
    targetCoverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    lengthRatio: targetSpanDecomp.lengthRatioProjected,
    routeDistanceMeters: polylineLength(pathPoints),
    zRawInk: zLetter.rawInkCoverage,
    zCoverage: zLetter.coverage,
    zPhysicallyCovered: zLetter.physicallyCovered,
    topInk, diagonalInk, bottomInk, strokesMeaningfullyCovered,
    checkpoint1Reached: r1.reached, checkpoint2Reached: r2.reached, checkpoint3Reached: r3.reached,
    transitionsInOrder,
    failureMode,
  };
}

// ---------------------------------------------------------------------------
// Z per-candidate, per-K record.
// ---------------------------------------------------------------------------

type SuccessCategory = 'strong' | 'partial' | 'weak_cosmetic' | 'none' | 'rejected_by_gate';

type ZCandidateKRecord = {
  placementId: string;
  k: number;
  priorClassification: string;
  baseline: StrokeSnapshot;
  treatment: StrokeSnapshot;
  gateAccepted: boolean;
  regressedLetters: string[];
  successCategory: SuccessCategory;
};

function classifySuccess(baseline: StrokeSnapshot, treatment: StrokeSnapshot, gateAccepted: boolean): SuccessCategory {
  if (!gateAccepted) return 'rejected_by_gate';
  const baselineAllThree = baseline.strokesMeaningfullyCovered === 3 && baseline.transitionsInOrder;
  const treatmentAllThree = treatment.strokesMeaningfullyCovered === 3 && treatment.transitionsInOrder;
  if (treatmentAllThree && !baselineAllThree) return 'strong';

  const strokeCovered = (s: StrokeSnapshot) => [s.topInk >= INK_THRESHOLD, s.diagonalInk >= INK_THRESHOLD, s.bottomInk >= INK_THRESHOLD];
  const before = strokeCovered(baseline);
  const after = strokeCovered(treatment);
  const anyNewlyCovered = after.some((v, i) => v && !before[i]);
  const anyRegressed = before.some((v, i) => v && !after[i]);
  if (anyNewlyCovered && !anyRegressed) return 'partial';

  if (treatment.shapeScore > baseline.shapeScore + 1e-6 && !anyNewlyCovered && !anyRegressed) return 'weak_cosmetic';
  return 'none';
}

async function runZExperiment(zClassifications: Map<string, string>): Promise<ZCandidateKRecord[]> {
  const ROBZ_CASES = [
    { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
    { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
    { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
    { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  ];
  const shape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const zBoundary = boundaries[3]!;
  const zLetterIndex = 3;
  const kind = shapeKindFromWord('ROBZ');

  const records: ZCandidateKRecord[] = [];
  for (const testCase of ROBZ_CASES) {
    const report = await runExperimentalPipelineMultiVariant({ word: 'ROBZ', start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters }, ['smooth']);
    const feasible = (report.diagnostics.feasibility ?? []).filter((f) => f.feasible && f.pathPoints.length >= 2);
    console.log(`[Z corpus] ROBZ ${testCase.locationName} ${testCase.targetDistanceMeters}m: feasible=${feasible.length}`);
    for (const record of feasible) {
      const graph = reconstructGraph(record.graphLines);
      const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
      const baselineGate = computeGateMetrics('ROBZ', record.target, baselineResult.pathPoints);
      const landmarks = buildZLandmarks(record.target, zBoundary);
      const baselineSnapshot = snapshotZ('ROBZ', record, zBoundary, zLetterIndex, landmarks, baselineResult.pathPoints);
      if (!baselineGate || !baselineSnapshot) continue;

      for (const k of K_VALUES) {
        const kLandmarks = buildZLandmarks(record.target, zBoundary);
        const checkpoints = buildProgressCheckpoints(kLandmarks, graph, k);
        const nodeToBits = indexProgressCheckpointBits(checkpoints);
        const augmenter = makeProgressCheckpointAugmenter(checkpoints, CHECKPOINT_PENALTY);
        const treatmentResult = routeGraphConstrainedShapeMirror({
          target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL,
          extraCost: augmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits),
        });
        const treatmentGate = computeGateMetrics('ROBZ', record.target, treatmentResult.pathPoints);
        const treatmentSnapshot = snapshotZ('ROBZ', record, zBoundary, zLetterIndex, kLandmarks, treatmentResult.pathPoints);
        if (!treatmentGate || !treatmentSnapshot) continue;

        const gateResult = evaluateRepairGate(baselineGate, treatmentGate, zLetterIndex);
        const successCategory = classifySuccess(baselineSnapshot, treatmentSnapshot, gateResult.accepted);

        records.push({
          placementId: record.placementId,
          k,
          priorClassification: zClassifications.get(record.placementId) ?? 'unknown',
          baseline: baselineSnapshot,
          treatment: treatmentSnapshot,
          gateAccepted: gateResult.accepted,
          regressedLetters: gateResult.regressedLetters,
          successCategory,
        });
      }
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Negative controls: R (from ROBZ), C and I (from CAIRO) — same mechanism,
// generic three-way progress split (buildGenericThreeWayLandmarks), same K
// sweep, same penalty, same gate.
// ---------------------------------------------------------------------------

type NegControlRecord = {
  letter: string;
  placementId: string;
  k: number;
  baselineShapeScore: number;
  treatmentShapeScore: number;
  baselinePhysicallyCovered: boolean;
  treatmentPhysicallyCovered: boolean;
  gateAccepted: boolean;
};

async function runNegativeControl(word: string, letterIndex: number, letterLabel: string): Promise<NegControlRecord[]> {
  const CASES =
    word === 'ROBZ'
      ? [
          { start: ALEXANDRIA, targetDistanceMeters: 2000 },
          { start: ALEXANDRIA, targetDistanceMeters: 4000 },
          { start: ZAMALEK, targetDistanceMeters: 2000 },
          { start: ZAMALEK, targetDistanceMeters: 4000 },
        ]
      : [
          { start: ALEXANDRIA, targetDistanceMeters: 2000 },
          { start: ALEXANDRIA, targetDistanceMeters: 4000 },
          { start: ZAMALEK, targetDistanceMeters: 2000 },
          { start: ZAMALEK, targetDistanceMeters: 4000 },
        ];
  const shape = buildWalkableWordShape(word, { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const boundary = boundaries[letterIndex]!;
  const kind = shapeKindFromWord(word);

  const records: NegControlRecord[] = [];
  for (const testCase of CASES) {
    const report = await runExperimentalPipelineMultiVariant({ word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters }, ['smooth']);
    const feasible = (report.diagnostics.feasibility ?? []).filter((f) => f.feasible && f.pathPoints.length >= 2);
    console.log(`[negctrl ${letterLabel}] ${word} ${testCase.targetDistanceMeters}m: feasible=${feasible.length}`);
    for (const record of feasible) {
      const graph = reconstructGraph(record.graphLines);
      const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
      const baselineGate = computeGateMetrics(word, record.target, baselineResult.pathPoints);
      if (!baselineGate) continue;
      const baselineLetter = baselineGate.letters[letterIndex]!;

      for (const k of K_VALUES) {
        const landmarks = buildGenericThreeWayLandmarks(record.target, boundary);
        const checkpoints = buildProgressCheckpoints(landmarks, graph, k);
        const nodeToBits = indexProgressCheckpointBits(checkpoints);
        const augmenter = makeProgressCheckpointAugmenter(checkpoints, CHECKPOINT_PENALTY);
        const treatmentResult = routeGraphConstrainedShapeMirror({
          target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL,
          extraCost: augmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits),
        });
        const treatmentGate = computeGateMetrics(word, record.target, treatmentResult.pathPoints);
        if (!treatmentGate) continue;
        const treatmentLetter = treatmentGate.letters[letterIndex]!;
        const gateResult = evaluateRepairGate(baselineGate, treatmentGate, letterIndex);
        records.push({
          letter: letterLabel,
          placementId: record.placementId,
          k,
          baselineShapeScore: baselineGate.shapeScore,
          treatmentShapeScore: treatmentGate.shapeScore,
          baselinePhysicallyCovered: baselineLetter.physicallyCovered,
          treatmentPhysicallyCovered: treatmentLetter.physicallyCovered,
          gateAccepted: gateResult.accepted,
        });
      }
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function printOverallTable(label: string, snapshots: readonly StrokeSnapshot[]) {
  const allThree = snapshots.filter((s) => s.strokesMeaningfullyCovered === 3 && s.transitionsInOrder).length;
  const atLeastTwo = snapshots.filter((s) => s.strokesMeaningfullyCovered >= 2).length;
  console.log(
    `  ${label}: n=${snapshots.length} all3StrokesCovered=${allThree} atLeast2Covered=${atLeastTwo} ` +
      `meanZCoverage=${mean(snapshots.map((s) => s.zCoverage)).toFixed(3)} medianZCoverage=${median(snapshots.map((s) => s.zCoverage)).toFixed(3)} ` +
      `meanShapeScore=${mean(snapshots.map((s) => s.shapeScore)).toFixed(3)} meanTargetCoverage=${mean(snapshots.map((s) => s.targetCoverage)).toFixed(3)} ` +
      `meanBacktrack=${mean(snapshots.map((s) => s.backtrack)).toFixed(3)} meanRouteTargetRatio=${mean(snapshots.map((s) => s.lengthRatio)).toFixed(3)}`,
  );
}

function printStrokeTable(k: number, records: readonly ZCandidateKRecord[]) {
  const treatments = records.filter((r) => r.k === k).map((r) => r.treatment);
  if (treatments.length === 0) return;
  const topDiagRate = mean(treatments.map((t) => (t.checkpoint1Reached ? 1 : 0)));
  const diagBotRate = mean(treatments.map((t) => (t.checkpoint3Reached ? 1 : 0)));
  console.log(
    `  K=${k}: n=${treatments.length} meanTopInk=${mean(treatments.map((t) => t.topInk)).toFixed(3)} meanDiagInk=${mean(treatments.map((t) => t.diagonalInk)).toFixed(3)} meanBottomInk=${mean(treatments.map((t) => t.bottomInk)).toFixed(3)} ` +
      `topToDiagReachRate=${topDiagRate.toFixed(3)} diagToBotReachRate=${diagBotRate.toFixed(3)}`,
  );
}

function printFailureModeTable(label: string, snapshots: readonly StrokeSnapshot[]) {
  const counts: Record<string, number> = {};
  for (const s of snapshots) counts[s.failureMode] = (counts[s.failureMode] ?? 0) + 1;
  console.log(`  ${label}: ${JSON.stringify(counts)}`);
}

async function fetchRecord(word: string, start: typeof ZAMALEK, targetDistanceMeters: number, preferId?: string): Promise<FeasibilityRecord | null> {
  const report = await runExperimentalPipelineMultiVariant({ word, start, targetDistanceMeters }, ['smooth']);
  const feasibility = report.diagnostics.feasibility ?? [];
  let chosenId: string | null = null;
  if (preferId && report.routes.some((r) => r.id === preferId)) chosenId = preferId;
  if (!chosenId) chosenId = [...report.routes].sort((a, b) => b.shapeScore - a.shapeScore)[0]?.id ?? null;
  return chosenId ? feasibility.find((f) => f.placementId === chosenId) ?? null : null;
}

async function deepDive(label: string, record: FeasibilityRecord) {
  console.log('');
  console.log(`=== DEEP DIVE: ${label} ===`);
  const shape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const zBoundary = boundaries[3]!;
  const kind = shapeKindFromWord('ROBZ');
  const graph = reconstructGraph(record.graphLines);

  const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
  const baselineGate = computeGateMetrics('ROBZ', record.target, baselineResult.pathPoints);
  const baselineLandmarks = buildZLandmarks(record.target, zBoundary);
  const baselineSnap = snapshotZ('ROBZ', record, zBoundary, 3, baselineLandmarks, baselineResult.pathPoints);
  if (!baselineGate || !baselineSnap) {
    console.log('  baseline produced no usable route.');
    return;
  }
  console.log(`  BEFORE: shapeScore=${baselineGate.shapeScore.toFixed(3)} zRawInk=${baselineSnap.zRawInk.toFixed(3)} zCoverage=${baselineSnap.zCoverage.toFixed(3)} zPhysCov=${baselineSnap.zPhysicallyCovered} topInk=${baselineSnap.topInk.toFixed(3)} diagInk=${baselineSnap.diagonalInk.toFixed(3)} bottomInk=${baselineSnap.bottomInk.toFixed(3)} cp1=${baselineSnap.checkpoint1Reached} cp2=${baselineSnap.checkpoint2Reached} cp3=${baselineSnap.checkpoint3Reached} failureMode=${baselineSnap.failureMode}`);

  for (const k of K_VALUES) {
    const landmarks = buildZLandmarks(record.target, zBoundary);
    const checkpoints = buildProgressCheckpoints(landmarks, graph, k);
    const nodeToBits = indexProgressCheckpointBits(checkpoints);
    const augmenter = makeProgressCheckpointAugmenter(checkpoints, CHECKPOINT_PENALTY);
    const treatmentResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL, extraCost: augmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits) });
    const treatmentGate = computeGateMetrics('ROBZ', record.target, treatmentResult.pathPoints);
    const treatmentSnap = snapshotZ('ROBZ', record, zBoundary, 3, landmarks, treatmentResult.pathPoints);
    if (!treatmentGate || !treatmentSnap) {
      console.log(`  K=${k}: treatment produced no usable route.`);
      continue;
    }
    const gateResult = evaluateRepairGate(baselineGate, treatmentGate, 3);
    const category = classifySuccess(baselineSnap, treatmentSnap, gateResult.accepted);
    console.log(
      `  AFTER K=${k}: shapeScore=${treatmentGate.shapeScore.toFixed(3)} (Δ${(treatmentGate.shapeScore - baselineGate.shapeScore).toFixed(3)}) zRawInk=${treatmentSnap.zRawInk.toFixed(3)} zCoverage=${treatmentSnap.zCoverage.toFixed(3)} zPhysCov=${treatmentSnap.zPhysicallyCovered} ` +
        `topInk=${treatmentSnap.topInk.toFixed(3)} diagInk=${treatmentSnap.diagonalInk.toFixed(3)} bottomInk=${treatmentSnap.bottomInk.toFixed(3)} cp1=${treatmentSnap.checkpoint1Reached} cp2=${treatmentSnap.checkpoint2Reached} cp3=${treatmentSnap.checkpoint3Reached} ` +
        `gateAccepted=${gateResult.accepted} regressed=${JSON.stringify(gateResult.regressedLetters)} category=${category}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();

  // Load the prior Z forensic classification (READ-ONLY, preserved exactly, never re-derived).
  const forensicJsonPath = resolve(DIAGNOSTIC_DIR, 'z-letter-forensic-analysis-results.json');
  const zClassifications = new Map<string, string>();
  if (existsSync(forensicJsonPath)) {
    const forensic = JSON.parse(readFileSync(forensicJsonPath, 'utf8')) as { zRecords: Array<{ placementId: string; classification: string }> };
    for (const r of forensic.zRecords) zClassifications.set(r.placementId, r.classification);
    console.log(`[setup] loaded ${zClassifications.size} prior Z classifications from ${forensicJsonPath}`);
  } else {
    console.log('[setup] WARNING: no prior forensic JSON found — priorClassification will be "unknown" for all candidates.');
  }

  const zRecords = await runZExperiment(zClassifications);

  console.log('');
  console.log('=== A. EXECUTIVE / B. OVERALL TABLE ===');
  printOverallTable('baseline', zRecords.filter((r) => r.k === K_VALUES[0]).map((r) => r.baseline));
  for (const k of K_VALUES) {
    const treatments = zRecords.filter((r) => r.k === k).map((r) => r.treatment);
    printOverallTable(`K=${k}`, treatments);
  }
  console.log(`  safe repairs (gateAccepted=true) per K: ${JSON.stringify(Object.fromEntries(K_VALUES.map((k) => [k, zRecords.filter((r) => r.k === k && r.gateAccepted).length])))}`);

  console.log('');
  console.log('=== C. STROKE TABLE (per K, treatment only) ===');
  for (const k of K_VALUES) printStrokeTable(k, zRecords);

  console.log('');
  console.log('=== D. FAILURE-MODE TRANSITION TABLE ===');
  printFailureModeTable('baseline', zRecords.filter((r) => r.k === K_VALUES[0]).map((r) => r.baseline));
  for (const k of K_VALUES) printFailureModeTable(`K=${k} treatment`, zRecords.filter((r) => r.k === k).map((r) => r.treatment));

  console.log('');
  console.log('=== SUCCESS CATEGORY DISTRIBUTION (per K) ===');
  for (const k of K_VALUES) {
    const counts: Record<string, number> = {};
    for (const r of zRecords.filter((r) => r.k === k)) counts[r.successCategory] = (counts[r.successCategory] ?? 0) + 1;
    console.log(`  K=${k}: ${JSON.stringify(counts)}`);
  }

  console.log('');
  console.log('=== SUCCESS CATEGORY BY PRIOR CLASSIFICATION (per K) ===');
  for (const k of K_VALUES) {
    const subset = zRecords.filter((r) => r.k === k);
    const byPrior: Record<string, Record<string, number>> = {};
    for (const r of subset) {
      byPrior[r.priorClassification] ??= {};
      byPrior[r.priorClassification]![r.successCategory] = (byPrior[r.priorClassification]![r.successCategory] ?? 0) + 1;
    }
    console.log(`  K=${k}: ${JSON.stringify(byPrior)}`);
  }

  // E/F deep dives.
  const robz1 = await fetchRecord('ROBZ', ZAMALEK, 4000, 'sf-r315-s0.6-e-905.1-n905.1');
  if (robz1) await deepDive('ROBZ #1 (Zamalek/4000m, sf-r315-s0.6-e-905.1-n905.1) — previously B_search_failure, both transitions connected at K=3', robz1);
  else console.log('ROBZ #1: could not be re-fetched (placementId not present in current run).');

  const robz2 = await fetchRecord('ROBZ', ALEXANDRIA, 2000);
  if (robz2) await deepDive(`ROBZ #2 (Alexandria/2000m, best-shapeScore candidate, id=${robz2.placementId})`, robz2);
  const robz2Specific = await fetchRecord('ROBZ', ALEXANDRIA, 2000, 'sf-r315-s0.8-e0-n-400');
  if (robz2Specific && robz2Specific.placementId !== robz2?.placementId) {
    await deepDive('ROBZ #2 specific case (sf-r315-s0.8-e0-n-400) — previously diagonal->bottom was the K=3 bottleneck', robz2Specific);
  }

  // G. Negative controls.
  console.log('');
  console.log('=== G. NEGATIVE CONTROLS (R / C / I) ===');
  const rRecords = await runNegativeControl('ROBZ', 0, 'R');
  const cRecords = await runNegativeControl('CAIRO', 0, 'C');
  const iRecords = await runNegativeControl('CAIRO', 2, 'I');
  for (const [label, records] of [['R', rRecords], ['C', cRecords], ['I', iRecords]] as const) {
    for (const k of K_VALUES) {
      const subset = records.filter((r) => r.k === k);
      const improved = subset.filter((r) => !r.baselinePhysicallyCovered && r.treatmentPhysicallyCovered).length;
      const degraded = subset.filter((r) => r.baselinePhysicallyCovered && !r.treatmentPhysicallyCovered).length;
      const meanShapeDelta = mean(subset.map((r) => r.treatmentShapeScore - r.baselineShapeScore));
      const meanCoverageDelta = mean(subset.map((r) => (r.treatmentPhysicallyCovered ? 1 : 0) - (r.baselinePhysicallyCovered ? 1 : 0)));
      const safeRepairs = subset.filter((r) => r.gateAccepted).length;
      console.log(`  ${label} K=${k}: n=${subset.length} improved=${improved} degraded=${degraded} meanShapeDelta=${meanShapeDelta.toFixed(4)} meanCoverageDelta=${meanCoverageDelta.toFixed(4)} safeRepairs=${safeRepairs}`);
    }
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'z-checkpoint-repair-experiment-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), zRecords, rRecords, cRecords, iRecords }, null, 2), 'utf8');

  console.log('');
  console.log(`[z-checkpoint-repair-experiment] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[z-checkpoint-repair-experiment] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
