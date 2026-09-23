/**
 * DEVELOPMENT ONLY. Baseline-first, targeted (single-letter) checkpoint
 * repair search, with a strict do-no-harm gate — diagnostic only, never
 * wired into production. Uses the parity-proven graph-shape-goal-
 * mirror.ts and the checkpoint-anchoring-diagnostic.ts infrastructure
 * from the two prior tasks, unmodified in their core mechanics (only
 * checkpoint-anchoring-diagnostic.ts gained one small additive helper,
 * buildSingleLetterCheckpoint, in this task).
 *
 * Architecture note on Step 12 (repair ordering), documented honestly:
 * the beam search always starts fresh from graph start states — it has no
 * concept of "continuing" from a previously-repaired route. So "repair A
 * then B" cannot literally mean a sequential two-pass search restart; the
 * closest faithful adaptation is a SINGLE combined search anchoring BOTH
 * letters' checkpoints simultaneously. Under that adaptation, "A then B"
 * and "B then A" are the same combined constraint set and are IDENTICAL
 * by construction — this is reported as a finding (order is not a
 * meaningful axis in a single-shot beam search), not concealed.
 *
 * Run with: npx tsx src/diagnostics/targeted-checkpoint-repair-evaluation.run.ts
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
import { routeGraphConstrainedShapeMirror, REAL_ISGOAL } from './graph-shape-goal-mirror';
import {
  buildLetterCheckpoints,
  buildSingleLetterCheckpoint,
  indexCheckpointBits,
  makeCheckpointExtraMaskUpdate,
  makeCheckpointAnchoringAugmenter,
  type CheckpointMode,
  type LetterCheckpoint,
} from './checkpoint-anchoring-diagnostic';
import { evaluateRepairGate, type RouteMetricsForGate, type LetterQuality } from './checkpoint-repair-gate-diagnostic';
import { scorePolylines } from '../scoring/shape-match';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { decomposeContinuity } from './continuity-decomposition-diagnostic';
import { decomposeTargetSpan } from './target-span-decomposition-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CHECKPOINT_PENALTY = 60;

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

// ---------------------------------------------------------------------------
// Quality computation (real, unmodified evaluators only).
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

function fullQuality(word: string, target: Vec2[], pathPoints: Vec2[]) {
  const gate = computeGateMetrics(word, target, pathPoints);
  if (!gate) return null;
  const identity = analyzeTargetIdentity({ route: pathPoints, target, word, geometryVariant: 'smooth' });
  const physical = evaluatePhysicalWordTraversal(word, target, pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const targetSpanDecomp = decomposeTargetSpan(word, target, pathPoints, 'smooth');
  return { gate, currentWordTraversal: identity.traversesMostOfWord, physicalWordTraversal: physical.wordTraversalPhysical, targetSpan: targetSpanDecomp.targetSpan, largestGap: targetSpanDecomp.largestTargetGap };
}

function identifyWeakLetters(gate: RouteMetricsForGate): number[] {
  const weak: number[] = [];
  gate.letters.forEach((l, i) => {
    if (l.rawInkCoverage < 0.6 || l.coverage < 0.4) weak.push(i);
  });
  return weak;
}

// ---------------------------------------------------------------------------
// Single-letter targeted repair.
// ---------------------------------------------------------------------------

function runTargetedRepair(word: string, record: FeasibilityRecord, boundaries: LetterBoundary[], targetIndex: number, k: number, mode: CheckpointMode) {
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const checkpoints = buildSingleLetterCheckpoint(boundaries, targetIndex, record.target, graph, k, mode);
  if (checkpoints.length === 0) return null;
  const { nodeToBits, bitToLetterIndex } = indexCheckpointBits(checkpoints);
  const augmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, checkpoints, { penaltyPerMissedCheckpoint: CHECKPOINT_PENALTY });
  const result = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL, extraCost: augmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits) });
  return result;
}

function runCombinedRepair(word: string, record: FeasibilityRecord, boundaries: LetterBoundary[], targetIndices: number[], k: number, mode: CheckpointMode) {
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const checkpoints: LetterCheckpoint[] = targetIndices.flatMap((index) => buildSingleLetterCheckpoint(boundaries, index, record.target, graph, k, mode));
  if (checkpoints.length === 0) return null;
  const { nodeToBits, bitToLetterIndex } = indexCheckpointBits(checkpoints);
  const augmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, checkpoints, { penaltyPerMissedCheckpoint: CHECKPOINT_PENALTY });
  const result = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL, extraCost: augmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits) });
  return result;
}

function runUnconditionalCheckpoint(word: string, record: FeasibilityRecord, boundaries: LetterBoundary[], k: number, mode: CheckpointMode) {
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const checkpoints = buildLetterCheckpoints(boundaries, record.target, graph, k, mode);
  const { nodeToBits, bitToLetterIndex } = indexCheckpointBits(checkpoints);
  const augmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, checkpoints, { penaltyPerMissedCheckpoint: CHECKPOINT_PENALTY });
  return routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL, extraCost: augmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits) });
}

// ---------------------------------------------------------------------------
// Deep dive (forensic cases).
// ---------------------------------------------------------------------------

async function fetchRecord(word: string, start: typeof ZAMALEK, targetDistanceMeters: number, preferId?: string): Promise<FeasibilityRecord | null> {
  const report = await runExperimentalPipelineMultiVariant({ word, start, targetDistanceMeters }, ['smooth']);
  const feasibility = report.diagnostics.feasibility ?? [];
  let chosenId: string | null = null;
  if (preferId && report.routes.some((r) => r.id === preferId)) chosenId = preferId;
  if (!chosenId) chosenId = [...report.routes].sort((a, b) => b.shapeScore - a.shapeScore)[0]?.id ?? null;
  return chosenId ? feasibility.find((f) => f.placementId === chosenId) ?? null : null;
}

async function deepDive(label: string, word: string, record: FeasibilityRecord) {
  console.log('');
  console.log(`=== DEEP DIVE: ${label} (${word}) ===`);
  const shape = buildWalkableWordShape(word, { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;

  const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph: reconstructGraph(record.graphLines), kind: shapeKindFromWord(word), multiLetter: true, goalCheck: REAL_ISGOAL });
  const baselineGate = computeGateMetrics(word, record.target, baselineResult.pathPoints);
  if (!baselineGate) {
    console.log('  baseline produced no usable route.');
    return null;
  }
  console.log(`  baseline: shapeScore=${baselineGate.shapeScore.toFixed(3)} coverage=${baselineGate.coverage.toFixed(3)} backtrack=${baselineGate.backtrack.toFixed(3)} lengthRatio=${baselineGate.lengthRatio.toFixed(3)} continuity=${baselineGate.continuityValid}`);
  console.log(`  baseline per-letter: ${JSON.stringify(baselineGate.letters.map((l) => ({ letter: l.letter, rawInk: Number(l.rawInkCoverage.toFixed(3)), cov: Number(l.coverage.toFixed(3)), physCov: l.physicallyCovered })))}`);

  const weakLetters = identifyWeakLetters(baselineGate);
  console.log(`  weak letters (rawInk<0.6 OR coverage<0.4): ${JSON.stringify(weakLetters.map((i) => baselineGate.letters[i]!.letter))}`);

  const acceptedRepairs: Array<{ letterIndex: number; config: string }> = [];

  for (const letterIndex of weakLetters) {
    const letter = baselineGate.letters[letterIndex]!.letter;
    console.log(`  --- repairing ${letter} (index ${letterIndex}) ---`);
    for (const [k, mode] of [[1, 'midpoint'], [3, 'midpoint'], [5, 'midpoint'], [3, 'startEnd']] as Array<[number, CheckpointMode]>) {
      const repairResult = runTargetedRepair(word, record, boundaries, letterIndex, k, mode);
      if (!repairResult) {
        console.log(`    K=${k} ${mode}: no checkpoint could be built (letter geometry degenerate)`);
        continue;
      }
      const repairedGate = computeGateMetrics(word, record.target, repairResult.pathPoints);
      if (!repairedGate) {
        console.log(`    K=${k} ${mode}: repair produced no route (failure=${repairResult.failure})`);
        continue;
      }
      const gateResult = evaluateRepairGate(baselineGate, repairedGate, letterIndex);
      console.log(
        `    K=${k} ${mode}: failure=${repairResult.failure ?? 'null'} shapeScore=${repairedGate.shapeScore.toFixed(3)} (Δ${(repairedGate.shapeScore - baselineGate.shapeScore).toFixed(3)}) coverage=${repairedGate.coverage.toFixed(3)} backtrack=${repairedGate.backtrack.toFixed(3)} lengthRatio=${repairedGate.lengthRatio.toFixed(3)} continuity=${repairedGate.continuityValid} ` +
          `targetImproved=${gateResult.targetLetterImproved} crossedThreshold=${gateResult.targetLetterCrossedThreshold} regressed=${JSON.stringify(gateResult.regressedLetters)} ACCEPTED=${gateResult.accepted}`,
      );
      if (gateResult.accepted) acceptedRepairs.push({ letterIndex, config: `K=${k} ${mode}` });
    }
  }

  // Two-letter combined repair, only if 2+ independent repairs were accepted.
  const distinctAcceptedLetters = [...new Set(acceptedRepairs.map((r) => r.letterIndex))];
  if (distinctAcceptedLetters.length >= 2) {
    const [a, b] = distinctAcceptedLetters;
    console.log(`  --- combined repair of ${baselineGate.letters[a!]!.letter} + ${baselineGate.letters[b!]!.letter} (both independently accepted; order-independent, see file header) ---`);
    const combined = runCombinedRepair(word, record, boundaries, [a!, b!], 3, 'midpoint');
    if (combined) {
      const combinedGate = computeGateMetrics(word, record.target, combined.pathPoints);
      if (combinedGate) {
        const gateResultA = evaluateRepairGate(baselineGate, combinedGate, a!);
        const gateResultB = evaluateRepairGate(baselineGate, combinedGate, b!);
        console.log(`    combined: shapeScore=${combinedGate.shapeScore.toFixed(3)} regressed=${JSON.stringify(gateResultA.regressedLetters)} ${baselineGate.letters[a!]!.letter}improved=${gateResultA.targetLetterImproved} ${baselineGate.letters[b!]!.letter}improved=${gateResultB.targetLetterImproved} bothAccepted=${gateResultA.accepted && gateResultB.accepted}`);
      }
    }
  } else {
    console.log('  fewer than 2 independently-accepted repairs — combined repair not applicable.');
  }

  return { baselineGate, weakLetters, acceptedRepairs };
}

// ---------------------------------------------------------------------------
// 78-candidate corpus run.
// ---------------------------------------------------------------------------

const MULTI_LETTER_CASES: Array<{ word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];

type CorpusRow = {
  word: string;
  placementId: string;
  weakLetterCount: number;
  baselinePhysicalWordTraversal: boolean;
  repairAttempted: boolean;
  targetLetter: string | null;
  repairRouteGenerated: boolean;
  repairAccepted: boolean;
  targetImproved: boolean;
  crossedThreshold: boolean;
  regressedLetters: string[];
  deltaShapeScore: number | null;
  deltaCoverage: number | null;
  deltaBacktrack: number | null;
  deltaLengthRatio: number | null;
  unconditionalPhysicalWordTraversal: boolean | null;
  unconditionalShapeScore: number | null;
  unconditionalRegressedLetters: string[] | null;
  targetedFinalPhysicalWordTraversal: boolean | null;
};

async function runCorpus(): Promise<CorpusRow[]> {
  console.log('');
  console.log('=== 78-CANDIDATE CORPUS: TARGETED REPAIR vs UNCONDITIONAL CHECKPOINT ===');
  const rows: CorpusRow[] = [];
  for (const testCase of MULTI_LETTER_CASES) {
    const report = await runExperimentalPipelineMultiVariant({ word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters }, ['smooth']);
    const feasible = (report.diagnostics.feasibility ?? []).filter((f) => f.feasible && f.pathPoints.length >= 2);
    console.log(`[corpus] ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m: feasible=${feasible.length}`);
    const shape = buildWalkableWordShape(testCase.word, { letterVariant: 'smooth' });
    const boundaries = letterBoundariesFromWordShape(shape).boundaries;

    for (const record of feasible) {
      const graph = reconstructGraph(record.graphLines);
      const kind = shapeKindFromWord(testCase.word);
      const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
      const baselineGate = computeGateMetrics(testCase.word, record.target, baselineResult.pathPoints);
      if (!baselineGate) continue;
      const baselinePhysical = evaluatePhysicalWordTraversal(testCase.word, record.target, baselineResult.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS).wordTraversalPhysical;

      const weakLetters = identifyWeakLetters(baselineGate);
      const unconditionalResult = runUnconditionalCheckpoint(testCase.word, record, boundaries, 3, 'midpoint');
      const unconditionalGate = computeGateMetrics(testCase.word, record.target, unconditionalResult.pathPoints);
      const unconditionalPhysical = unconditionalGate ? evaluatePhysicalWordTraversal(testCase.word, record.target, unconditionalResult.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS).wordTraversalPhysical : null;
      const unconditionalRegressed = unconditionalGate ? baselineGate.letters.filter((l, i) => l.physicallyCovered && !unconditionalGate.letters[i]?.physicallyCovered).map((l) => l.letter) : null;

      if (weakLetters.length === 0) {
        rows.push({
          word: testCase.word, placementId: record.placementId, weakLetterCount: 0, baselinePhysicalWordTraversal: baselinePhysical,
          repairAttempted: false, targetLetter: null, repairRouteGenerated: false, repairAccepted: false, targetImproved: false, crossedThreshold: false, regressedLetters: [],
          deltaShapeScore: null, deltaCoverage: null, deltaBacktrack: null, deltaLengthRatio: null,
          unconditionalPhysicalWordTraversal: unconditionalPhysical, unconditionalShapeScore: unconditionalGate?.shapeScore ?? null, unconditionalRegressedLetters: unconditionalRegressed,
          targetedFinalPhysicalWordTraversal: baselinePhysical,
        });
        continue;
      }

      // Most deficient by coverage.
      const mostDeficientIndex = [...weakLetters].sort((a, b) => baselineGate.letters[a]!.coverage - baselineGate.letters[b]!.coverage)[0]!;
      const repairResult = runTargetedRepair(testCase.word, record, boundaries, mostDeficientIndex, 3, 'midpoint');
      const repairedGate = repairResult ? computeGateMetrics(testCase.word, record.target, repairResult.pathPoints) : null;
      const gateResult = repairedGate ? evaluateRepairGate(baselineGate, repairedGate, mostDeficientIndex) : null;
      const finalPathPoints = gateResult?.accepted ? repairResult!.pathPoints : baselineResult.pathPoints;
      const finalPhysical = evaluatePhysicalWordTraversal(testCase.word, record.target, finalPathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS).wordTraversalPhysical;

      rows.push({
        word: testCase.word,
        placementId: record.placementId,
        weakLetterCount: weakLetters.length,
        baselinePhysicalWordTraversal: baselinePhysical,
        repairAttempted: true,
        targetLetter: baselineGate.letters[mostDeficientIndex]!.letter,
        repairRouteGenerated: !!repairedGate,
        repairAccepted: gateResult?.accepted ?? false,
        targetImproved: gateResult?.targetLetterImproved ?? false,
        crossedThreshold: gateResult?.targetLetterCrossedThreshold ?? false,
        regressedLetters: gateResult?.regressedLetters ?? [],
        deltaShapeScore: repairedGate ? repairedGate.shapeScore - baselineGate.shapeScore : null,
        deltaCoverage: repairedGate ? repairedGate.coverage - baselineGate.coverage : null,
        deltaBacktrack: repairedGate ? repairedGate.backtrack - baselineGate.backtrack : null,
        deltaLengthRatio: repairedGate ? repairedGate.lengthRatio - baselineGate.lengthRatio : null,
        unconditionalPhysicalWordTraversal: unconditionalPhysical,
        unconditionalShapeScore: unconditionalGate?.shapeScore ?? null,
        unconditionalRegressedLetters: unconditionalRegressed,
        targetedFinalPhysicalWordTraversal: finalPhysical,
      });
    }
  }
  return rows;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function summarizeCorpus(rows: CorpusRow[]) {
  console.log('');
  console.log(`=== CORPUS SUMMARY (n=${rows.length}) ===`);
  const withWeak = rows.filter((r) => r.weakLetterCount > 0);
  const attempted = rows.filter((r) => r.repairAttempted);
  const routeGenerated = attempted.filter((r) => r.repairRouteGenerated);
  const improved = attempted.filter((r) => r.targetImproved);
  const accepted = attempted.filter((r) => r.repairAccepted);
  const nowFullyTraversal = attempted.filter((r) => !r.baselinePhysicalWordTraversal && r.targetedFinalPhysicalWordTraversal);

  console.log(`candidates with weak letters: ${withWeak.length}/${rows.length}`);
  console.log(`repair attempts: ${attempted.length}`);
  console.log(`repair routes generated: ${routeGenerated.length}`);
  console.log(`repairs that improve target letter: ${improved.length}`);
  console.log(`repairs that pass do-no-harm: ${accepted.length}`);
  console.log(`repairs that flip a candidate to full physicalWordTraversal: ${nowFullyTraversal.length}`);

  const weakLetterCounts: Record<string, number> = {};
  for (const r of rows) if (r.repairAttempted && r.targetLetter) weakLetterCounts[r.targetLetter] = (weakLetterCounts[r.targetLetter] ?? 0) + 1;
  console.log(`most-deficient-letter frequency: ${JSON.stringify(weakLetterCounts)}`);

  const weakCountDistribution: Record<number, number> = {};
  for (const r of rows) weakCountDistribution[r.weakLetterCount] = (weakCountDistribution[r.weakLetterCount] ?? 0) + 1;
  console.log(`weak-letter-count distribution: ${JSON.stringify(weakCountDistribution)}`);

  for (const [label, subset] of [['repair improved', improved], ['repair accepted', accepted]] as const) {
    console.log(`[${label}] n=${subset.length} meanΔshapeScore=${mean(subset.map((r) => r.deltaShapeScore ?? 0)).toFixed(4)} meanΔcoverage=${mean(subset.map((r) => r.deltaCoverage ?? 0)).toFixed(4)} meanΔbacktrack=${mean(subset.map((r) => r.deltaBacktrack ?? 0)).toFixed(4)} meanΔlengthRatio=${mean(subset.map((r) => r.deltaLengthRatio ?? 0)).toFixed(4)}`);
  }

  console.log('');
  console.log('--- Comparison: baseline vs unconditional checkpoint vs targeted repair ---');
  const baselinePhysicalCount = rows.filter((r) => r.baselinePhysicalWordTraversal).length;
  const unconditionalPhysicalCount = rows.filter((r) => r.unconditionalPhysicalWordTraversal).length;
  const targetedPhysicalCount = rows.filter((r) => r.targetedFinalPhysicalWordTraversal).length;
  const unconditionalRegressedCount = rows.filter((r) => (r.unconditionalRegressedLetters?.length ?? 0) > 0).length;
  const targetedRegressedCount = rows.filter((r) => r.regressedLetters.length > 0).length;
  console.log(`physicalWordTraversal: baseline=${baselinePhysicalCount}/${rows.length} unconditionalCheckpoint=${unconditionalPhysicalCount}/${rows.length} targetedRepair=${targetedPhysicalCount}/${rows.length}`);
  console.log(`candidates with >=1 regressed (previously-covered-now-uncovered) letter: unconditionalCheckpoint=${unconditionalRegressedCount}/${rows.length} targetedRepair=${targetedRegressedCount}/${rows.length}`);
}

async function main() {
  const started = Date.now();

  const cairoRecord = await fetchRecord('CAIRO', ALEXANDRIA, 2000, 'sf-r22.5-s1.0-e282.8-n-282.8');
  const robz1Record = await fetchRecord('ROBZ', ZAMALEK, 4000, 'sf-r315-s0.6-e-905.1-n905.1');
  const robz2Record = await fetchRecord('ROBZ', ALEXANDRIA, 2000);

  const cairoDive = cairoRecord ? await deepDive('CAIRO strongest', 'CAIRO', cairoRecord) : null;
  const robz1Dive = robz1Record ? await deepDive('ROBZ #1', 'ROBZ', robz1Record) : null;
  const robz2Dive = robz2Record ? await deepDive('ROBZ #2', 'ROBZ', robz2Record) : null;
  void cairoDive;
  void robz1Dive;
  void robz2Dive;

  const corpusRows = await runCorpus();
  summarizeCorpus(corpusRows);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'targeted-checkpoint-repair-evaluation-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), corpusRows }, null, 2), 'utf8');

  console.log('');
  console.log(`[targeted-checkpoint-repair-evaluation] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[targeted-checkpoint-repair-evaluation] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
