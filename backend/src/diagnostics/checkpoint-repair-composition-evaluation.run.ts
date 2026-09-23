/**
 * DEVELOPMENT ONLY. Determines whether independently-safe single-letter
 * checkpoint repairs COMPOSE — diagnostic only, never wired into
 * production. Expands the prior task's "repair only the most-deficient
 * letter" experiment to EVERY weak letter, then tests pair/triple
 * combinations of the independently-safe ones via a single combined beam
 * search (never a sequential restart — the mirror architecture has no
 * such concept, as established in the prior task).
 *
 * Reuses, unmodified: graph-shape-goal-mirror.ts,
 * checkpoint-anchoring-diagnostic.ts (incl. buildSingleLetterCheckpoint
 * from the prior task), checkpoint-repair-gate-diagnostic.ts (both
 * evaluateRepairGate and the new evaluateCombinedRepairGate added this
 * task with the SAME guardrail constants, unchanged).
 *
 * Run with: npx tsx src/diagnostics/checkpoint-repair-composition-evaluation.run.ts
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
import { evaluateRepairGate, evaluateCombinedRepairGate, type RouteMetricsForGate, type LetterQuality } from './checkpoint-repair-gate-diagnostic';
import { scorePolylines } from '../scoring/shape-match';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { decomposeContinuity } from './continuity-decomposition-diagnostic';
import { decomposeTargetSpan } from './target-span-decomposition-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const CHECKPOINT_PENALTY = 60;
const CONFIGS: Array<[number, CheckpointMode]> = [[1, 'midpoint'], [3, 'midpoint'], [5, 'midpoint'], [3, 'startEnd']];

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

function computeGateMetrics(word: string, target: Vec2[], pathPoints: Vec2[]): RouteMetricsForGate | null {
  if (pathPoints.length < 2) return null;
  const scored = scorePolylines(pathPoints, target);
  const continuity = decomposeContinuity(word, target, pathPoints, 'smooth');
  const physical = evaluatePhysicalWordTraversal(word, target, pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const targetSpanDecomp = decomposeTargetSpan(word, target, pathPoints, 'smooth');
  const letters: LetterQuality[] = physical.letters.map((l) => ({ letter: l.letter, rawInkCoverage: l.rawInkCoverage, coverage: l.coverage, physicallyCovered: l.physicallyCovered }));
  return { shapeScore: scored.score, coverage: scored.coverage, backtrack: scored.details.backtrackRatio, lengthRatio: targetSpanDecomp.lengthRatioProjected, continuityValid: continuity.continuityValid, letters };
}
function coveredCount(gate: RouteMetricsForGate): number {
  return gate.letters.filter((l) => l.physicallyCovered).length;
}
function identifyWeakLetters(gate: RouteMetricsForGate): number[] {
  const weak: number[] = [];
  gate.letters.forEach((l, i) => { if (l.rawInkCoverage < 0.6 || l.coverage < 0.4) weak.push(i); });
  return weak;
}

function runTargetedRepair(word: string, record: FeasibilityRecord, boundaries: LetterBoundary[], targetIndex: number, k: number, mode: CheckpointMode) {
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const checkpoints = buildSingleLetterCheckpoint(boundaries, targetIndex, record.target, graph, k, mode);
  if (checkpoints.length === 0) return null;
  const { nodeToBits, bitToLetterIndex } = indexCheckpointBits(checkpoints);
  const augmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, checkpoints, { penaltyPerMissedCheckpoint: CHECKPOINT_PENALTY });
  return routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL, extraCost: augmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits) });
}
function runCombinedRepair(word: string, record: FeasibilityRecord, boundaries: LetterBoundary[], targetIndices: number[], k: number, mode: CheckpointMode) {
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const checkpoints: LetterCheckpoint[] = targetIndices.flatMap((index) => buildSingleLetterCheckpoint(boundaries, index, record.target, graph, k, mode));
  if (checkpoints.length === 0) return null;
  const { nodeToBits, bitToLetterIndex } = indexCheckpointBits(checkpoints);
  const augmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, checkpoints, { penaltyPerMissedCheckpoint: CHECKPOINT_PENALTY });
  return routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL, extraCost: augmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits) });
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
// Per-letter repair attempt record (kept in full, not summarized away).
// ---------------------------------------------------------------------------

type ConfigAttempt = { config: string; failure: string | null; accepted: boolean; targetImproved: boolean; crossedThreshold: boolean; regressed: string[]; deltaShapeScore: number; deltaCoverage: number; deltaBacktrack: number; deltaLengthRatio: number };
type LetterRepairRecord = { letterIndex: number; letter: string; rawInkBefore: number; coverageBefore: number; attempts: ConfigAttempt[]; bestAcceptedConfig: string | null; safe: boolean; rawInkAfter: number | null; coverageAfter: number | null };

function repairOneLetter(word: string, record: FeasibilityRecord, boundaries: LetterBoundary[], baselineGate: RouteMetricsForGate, letterIndex: number): LetterRepairRecord {
  const letter = baselineGate.letters[letterIndex]!;
  const attempts: ConfigAttempt[] = [];
  let bestAcceptedConfig: string | null = null;
  let bestAcceptedShapeScore = -Infinity;
  let rawInkAfter: number | null = null;
  let coverageAfter: number | null = null;

  for (const [k, mode] of CONFIGS) {
    const configName = `K=${k} ${mode}`;
    const result = runTargetedRepair(word, record, boundaries, letterIndex, k, mode);
    if (!result) {
      attempts.push({ config: configName, failure: 'no-checkpoint', accepted: false, targetImproved: false, crossedThreshold: false, regressed: [], deltaShapeScore: 0, deltaCoverage: 0, deltaBacktrack: 0, deltaLengthRatio: 0 });
      continue;
    }
    const repairedGate = computeGateMetrics(word, record.target, result.pathPoints);
    if (!repairedGate) {
      attempts.push({ config: configName, failure: result.failure ?? 'no-route', accepted: false, targetImproved: false, crossedThreshold: false, regressed: [], deltaShapeScore: 0, deltaCoverage: 0, deltaBacktrack: 0, deltaLengthRatio: 0 });
      continue;
    }
    const gateResult = evaluateRepairGate(baselineGate, repairedGate, letterIndex);
    attempts.push({
      config: configName, failure: result.failure, accepted: gateResult.accepted, targetImproved: gateResult.targetLetterImproved, crossedThreshold: gateResult.targetLetterCrossedThreshold, regressed: gateResult.regressedLetters,
      deltaShapeScore: repairedGate.shapeScore - baselineGate.shapeScore, deltaCoverage: repairedGate.coverage - baselineGate.coverage, deltaBacktrack: repairedGate.backtrack - baselineGate.backtrack, deltaLengthRatio: repairedGate.lengthRatio - baselineGate.lengthRatio,
    });
    if (gateResult.accepted && repairedGate.shapeScore > bestAcceptedShapeScore) {
      bestAcceptedShapeScore = repairedGate.shapeScore;
      bestAcceptedConfig = configName;
      rawInkAfter = repairedGate.letters[letterIndex]!.rawInkCoverage;
      coverageAfter = repairedGate.letters[letterIndex]!.coverage;
    }
  }

  return { letterIndex, letter: letter.letter, rawInkBefore: letter.rawInkCoverage, coverageBefore: letter.coverage, attempts, bestAcceptedConfig, safe: bestAcceptedConfig !== null, rawInkAfter, coverageAfter };
}

// ---------------------------------------------------------------------------
// Pair / triple composition.
// ---------------------------------------------------------------------------

type CompositionClass = 'SUPERADDITIVE' | 'ADDITIVE' | 'COMPETITIVE' | 'DOMINATED' | 'FAILED' | 'AMBIGUOUS';

type CompositionResult = {
  letters: string[];
  letterIndices: number[];
  accepted: boolean;
  classification: CompositionClass;
  shapeScore: number | null;
  coverage: number | null;
  coveredLetterCount: number | null;
  deltaShapeScoreVsBaseline: number | null;
  targetedLettersImproved: boolean[];
  targetedLettersCrossedThreshold: boolean[];
  regressedLetters: string[];
};

function classifyComposition(individualBestShapeScores: number[], combinedGate: RouteMetricsForGate | null, baselineGate: RouteMetricsForGate, gateResult: ReturnType<typeof evaluateCombinedRepairGate> | null): CompositionClass {
  if (!combinedGate || !gateResult) return 'FAILED';
  if (!gateResult.accepted) return gateResult.allTargetedLettersImproved ? 'FAILED' : 'COMPETITIVE';
  const combinedShapeScore = combinedGate.shapeScore;
  const bestIndividual = Math.max(...individualBestShapeScores);
  if (combinedShapeScore > bestIndividual + 0.005) return 'SUPERADDITIVE';
  if (combinedShapeScore >= bestIndividual - 0.01) return 'ADDITIVE';
  if (combinedShapeScore < baselineGate.shapeScore) return 'DOMINATED';
  return 'AMBIGUOUS';
}

function runComposition(word: string, record: FeasibilityRecord, boundaries: LetterBoundary[], baselineGate: RouteMetricsForGate, letterIndices: number[], individualBestShapeScores: number[]): CompositionResult {
  const result = runCombinedRepair(word, record, boundaries, letterIndices, 3, 'midpoint');
  const combinedGate = result ? computeGateMetrics(word, record.target, result.pathPoints) : null;
  const gateResult = combinedGate ? evaluateCombinedRepairGate(baselineGate, combinedGate, letterIndices) : null;
  const classification = classifyComposition(individualBestShapeScores, combinedGate, baselineGate, gateResult);
  return {
    letters: letterIndices.map((i) => baselineGate.letters[i]!.letter),
    letterIndices,
    accepted: gateResult?.accepted ?? false,
    classification,
    shapeScore: combinedGate?.shapeScore ?? null,
    coverage: combinedGate?.coverage ?? null,
    coveredLetterCount: combinedGate ? coveredCount(combinedGate) : null,
    deltaShapeScoreVsBaseline: combinedGate ? combinedGate.shapeScore - baselineGate.shapeScore : null,
    targetedLettersImproved: gateResult?.targetedLettersImproved ?? [],
    targetedLettersCrossedThreshold: gateResult?.targetedLettersCrossedThreshold ?? [],
    regressedLetters: gateResult?.regressedLetters ?? [],
  };
}

// ---------------------------------------------------------------------------
// Per-candidate orchestration.
// ---------------------------------------------------------------------------

type CandidateResult = {
  word: string;
  placementId: string;
  baselineCoveredCount: number;
  baselinePhysicalWordTraversal: boolean;
  weakLetters: string[];
  letterRepairs: LetterRepairRecord[];
  safeLetters: string[];
  pairResults: CompositionResult[];
  tripleResult: CompositionResult | null;
  bestIndividualCoveredCount: number;
  bestPairCoveredCount: number;
  bestTripleCoveredCount: number;
  unconditionalCoveredCount: number;
  unconditionalRegressed: string[];
};

async function processCandidate(word: string, record: FeasibilityRecord, boundaries: LetterBoundary[]): Promise<CandidateResult | null> {
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
  const baselineGate = computeGateMetrics(word, record.target, baselineResult.pathPoints);
  if (!baselineGate) return null;
  const baselinePhysical = evaluatePhysicalWordTraversal(word, record.target, baselineResult.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS).wordTraversalPhysical;

  const weakIndices = identifyWeakLetters(baselineGate);
  const letterRepairs = weakIndices.map((index) => repairOneLetter(word, record, boundaries, baselineGate, index));
  const safeRepairs = letterRepairs.filter((r) => r.safe);
  const safeIndices = safeRepairs.map((r) => r.letterIndex);

  let bestIndividualCoveredCount = baselineCoveredCountFrom(baselineGate);
  for (const r of safeRepairs) {
    // Recompute the covered count for the best-accepted config's route to know completeness progression.
    const [k, mode] = parseConfig(r.bestAcceptedConfig!);
    const repairResult = runTargetedRepair(word, record, boundaries, r.letterIndex, k, mode);
    const gate = repairResult ? computeGateMetrics(word, record.target, repairResult.pathPoints) : null;
    if (gate) bestIndividualCoveredCount = Math.max(bestIndividualCoveredCount, coveredCount(gate));
  }

  const pairResults: CompositionResult[] = [];
  let bestPairCoveredCount = bestIndividualCoveredCount;
  if (safeIndices.length >= 2) {
    for (let i = 0; i < safeIndices.length; i += 1) {
      for (let j = i + 1; j < safeIndices.length; j += 1) {
        const a = safeIndices[i]!;
        const b = safeIndices[j]!;
        const scoreA = safeRepairs.find((r) => r.letterIndex === a)!.coverageAfter ?? 0;
        const scoreB = safeRepairs.find((r) => r.letterIndex === b)!.coverageAfter ?? 0;
        const pair = runComposition(word, record, boundaries, baselineGate, [a, b], [scoreA, scoreB]);
        pairResults.push(pair);
        if (pair.coveredLetterCount !== null) bestPairCoveredCount = Math.max(bestPairCoveredCount, pair.coveredLetterCount);
      }
    }
  }

  let tripleResult: CompositionResult | null = null;
  let bestTripleCoveredCount = bestPairCoveredCount;
  if (safeIndices.length >= 3) {
    let tripleIndices: number[];
    if (safeIndices.length === 3) {
      tripleIndices = safeIndices;
    } else {
      // 4+ safe letters: prioritize the 3 with the highest individual Δcoverage (documented selection rule — see file header discussion; a simple, defensible proxy for "most promising" without an exhaustive pairwise search).
      tripleIndices = [...safeRepairs].sort((a, b) => (b.coverageAfter ?? 0) - (b.coverageBefore) - ((a.coverageAfter ?? 0) - a.coverageBefore)).slice(0, 3).map((r) => r.letterIndex);
    }
    const scores = tripleIndices.map((idx) => safeRepairs.find((r) => r.letterIndex === idx)!.coverageAfter ?? 0);
    tripleResult = runComposition(word, record, boundaries, baselineGate, tripleIndices, scores);
    if (tripleResult.coveredLetterCount !== null) bestTripleCoveredCount = Math.max(bestTripleCoveredCount, tripleResult.coveredLetterCount);
  }

  const unconditionalResult = runUnconditionalCheckpoint(word, record, boundaries, 3, 'midpoint');
  const unconditionalGate = computeGateMetrics(word, record.target, unconditionalResult.pathPoints);
  const unconditionalCoveredCount = unconditionalGate ? coveredCount(unconditionalGate) : coveredCount(baselineGate);
  const unconditionalRegressed = unconditionalGate ? baselineGate.letters.filter((l, i) => l.physicallyCovered && !unconditionalGate.letters[i]?.physicallyCovered).map((l) => l.letter) : [];

  return {
    word,
    placementId: record.placementId,
    baselineCoveredCount: coveredCount(baselineGate),
    baselinePhysicalWordTraversal: baselinePhysical,
    weakLetters: weakIndices.map((i) => baselineGate.letters[i]!.letter),
    letterRepairs,
    safeLetters: safeRepairs.map((r) => r.letter),
    pairResults,
    tripleResult,
    bestIndividualCoveredCount,
    bestPairCoveredCount,
    bestTripleCoveredCount,
    unconditionalCoveredCount,
    unconditionalRegressed,
  };
}
function baselineCoveredCountFrom(gate: RouteMetricsForGate): number {
  return coveredCount(gate);
}
function parseConfig(config: string): [number, CheckpointMode] {
  const match = /K=(\d+) (midpoint|startEnd)/.exec(config);
  return [Number(match![1]), match![2] as CheckpointMode];
}

// ---------------------------------------------------------------------------
// Main.
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

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

async function main() {
  const started = Date.now();
  const results: CandidateResult[] = [];

  for (const testCase of MULTI_LETTER_CASES) {
    const report = await runExperimentalPipelineMultiVariant({ word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters }, ['smooth']);
    const feasible = (report.diagnostics.feasibility ?? []).filter((f) => f.feasible && f.pathPoints.length >= 2);
    console.log(`[corpus] ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m: feasible=${feasible.length}`);
    const shape = buildWalkableWordShape(testCase.word, { letterVariant: 'smooth' });
    const boundaries = letterBoundariesFromWordShape(shape).boundaries;
    for (const record of feasible) {
      const result = await processCandidate(testCase.word, record, boundaries);
      if (result) results.push(result);
    }
    console.log(`[corpus] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m, cumulative candidates=${results.length}`);
  }

  console.log('');
  console.log(`=== AGGREGATE (n=${results.length}) ===`);
  const safeCounts: Record<number, number> = {};
  for (const r of results) safeCounts[r.safeLetters.length] = (safeCounts[r.safeLetters.length] ?? 0) + 1;
  console.log(`safe-repair-count distribution: ${JSON.stringify(safeCounts)}`);

  const totalWeak = results.reduce((s, r) => s + r.weakLetters.length, 0);
  const totalAttempts = results.reduce((s, r) => s + r.letterRepairs.reduce((s2, lr) => s2 + lr.attempts.length, 0), 0);
  const totalAccepted = results.reduce((s, r) => s + r.safeLetters.length, 0);
  console.log(`total weak letters: ${totalWeak}, total repair attempts (all configs): ${totalAttempts}, total independently-accepted repairs: ${totalAccepted}`);

  const pairAttempts = results.flatMap((r) => r.pairResults);
  const pairAccepted = pairAttempts.filter((p) => p.accepted);
  const pairClassCounts: Record<string, number> = {};
  for (const p of pairAttempts) pairClassCounts[p.classification] = (pairClassCounts[p.classification] ?? 0) + 1;
  console.log(`pair attempts: ${pairAttempts.length}, accepted: ${pairAccepted.length}, classifications: ${JSON.stringify(pairClassCounts)}`);

  const tripleAttempts = results.filter((r) => r.tripleResult !== null).map((r) => r.tripleResult!);
  const tripleAccepted = tripleAttempts.filter((t) => t.accepted);
  const tripleClassCounts: Record<string, number> = {};
  for (const t of tripleAttempts) tripleClassCounts[t.classification] = (tripleClassCounts[t.classification] ?? 0) + 1;
  console.log(`triple attempts: ${tripleAttempts.length}, accepted: ${tripleAccepted.length}, classifications: ${JSON.stringify(tripleClassCounts)}`);

  console.log('');
  console.log('--- Completeness progression ---');
  console.log(`mean baseline covered letters: ${mean(results.map((r) => r.baselineCoveredCount)).toFixed(3)}`);
  console.log(`mean best-individual covered letters: ${mean(results.map((r) => r.bestIndividualCoveredCount)).toFixed(3)}`);
  console.log(`mean best-pair covered letters: ${mean(results.map((r) => r.bestPairCoveredCount)).toFixed(3)}`);
  console.log(`mean best-triple covered letters: ${mean(results.map((r) => r.bestTripleCoveredCount)).toFixed(3)}`);
  console.log(`mean unconditional-checkpoint covered letters: ${mean(results.map((r) => r.unconditionalCoveredCount)).toFixed(3)}`);

  const gainDistribution: Record<number, number> = {};
  for (const r of results) {
    const gain = r.bestPairCoveredCount - r.baselineCoveredCount;
    gainDistribution[gain] = (gainDistribution[gain] ?? 0) + 1;
  }
  console.log(`letter-count gain distribution (best-pair vs baseline): ${JSON.stringify(gainDistribution)}`);

  // Full-completeness check: candidate's word length equals bestPairCoveredCount or bestTripleCoveredCount.
  const wordLengths = new Map<string, number>();
  for (const r of results) {
    if (!wordLengths.has(r.word)) wordLengths.set(r.word, r.word.length);
  }
  const fullViaPair = results.filter((r) => r.bestPairCoveredCount >= (wordLengths.get(r.word) ?? 99));
  const fullViaTriple = results.filter((r) => r.bestTripleCoveredCount >= (wordLengths.get(r.word) ?? 99));
  const fullViaIndividual = results.filter((r) => r.bestIndividualCoveredCount >= (wordLengths.get(r.word) ?? 99));
  const fullViaBaseline = results.filter((r) => r.baselineCoveredCount >= (wordLengths.get(r.word) ?? 99));
  console.log(`full letter-coverage count: baseline=${fullViaBaseline.length} bestIndividual=${fullViaIndividual.length} bestPair=${fullViaPair.length} bestTriple=${fullViaTriple.length}`);
  console.log(`full physicalWordTraversal: baseline=${results.filter((r) => r.baselinePhysicalWordTraversal).length}/${results.length}`);
  if (fullViaPair.length > 0) console.log(`candidates reaching full letter coverage via pair: ${JSON.stringify(fullViaPair.map((r) => `${r.word}/${r.placementId}`))}`);
  if (fullViaTriple.length > 0) console.log(`candidates reaching full letter coverage via triple: ${JSON.stringify(fullViaTriple.map((r) => `${r.word}/${r.placementId}`))}`);

  console.log('');
  console.log('--- Letter-level repairability ---');
  const letterStats: Record<string, { weak: number; attempts: number; safe: number; crossed: number; deltaCoverages: number[]; deltaRawInks: number[]; deltaShapeScores: number[] }> = {};
  for (const r of results) {
    for (const lr of r.letterRepairs) {
      const stats = (letterStats[lr.letter] ??= { weak: 0, attempts: 0, safe: 0, crossed: 0, deltaCoverages: [], deltaRawInks: [], deltaShapeScores: [] });
      stats.weak += 1;
      stats.attempts += lr.attempts.length;
      if (lr.safe) {
        stats.safe += 1;
        const bestAttempt = lr.attempts.find((a) => a.config === lr.bestAcceptedConfig);
        if (bestAttempt) {
          stats.deltaCoverages.push(bestAttempt.deltaCoverage);
          stats.deltaShapeScores.push(bestAttempt.deltaShapeScore);
        }
        if (lr.rawInkAfter !== null) stats.deltaRawInks.push(lr.rawInkAfter - lr.rawInkBefore);
        if (lr.attempts.some((a) => a.accepted && a.crossedThreshold)) stats.crossed += 1;
      }
    }
  }
  for (const [letter, stats] of Object.entries(letterStats).sort()) {
    console.log(`  ${letter}: weakOccurrences=${stats.weak} attempts=${stats.attempts} safeRepairs=${stats.safe} thresholdCrossings=${stats.crossed} meanΔcoverage=${mean(stats.deltaCoverages).toFixed(4)} meanΔrawInk=${mean(stats.deltaRawInks).toFixed(4)} meanΔshapeScore=${mean(stats.deltaShapeScores).toFixed(4)}`);
  }

  console.log('');
  console.log('--- Forensic: ROBZ #1, ROBZ #2, CAIRO strongest ---');
  const robz1 = results.find((r) => r.placementId === 'sf-r315-s0.6-e-905.1-n905.1');
  const cairoStrongest = results.find((r) => r.placementId === 'sf-r22.5-s1.0-e282.8-n-282.8');
  if (robz1) console.log(`ROBZ #1 (${robz1.placementId}): weak=${JSON.stringify(robz1.weakLetters)} safe=${JSON.stringify(robz1.safeLetters)} pairResults=${JSON.stringify(robz1.pairResults)}`);
  if (cairoStrongest) console.log(`CAIRO strongest (${cairoStrongest.placementId}): weak=${JSON.stringify(cairoStrongest.weakLetters)} safe=${JSON.stringify(cairoStrongest.safeLetters)} pairResults=${JSON.stringify(cairoStrongest.pairResults)} tripleResult=${JSON.stringify(cairoStrongest.tripleResult)}`);
  const robz2Candidates = results.filter((r) => r.word === 'ROBZ' && r.safeLetters.length > 0);
  console.log(`ROBZ candidates with >=1 safe repair: ${robz2Candidates.length} -> ${JSON.stringify(robz2Candidates.map((r) => ({ id: r.placementId, safe: r.safeLetters })))}`);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'checkpoint-repair-composition-evaluation-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8');

  console.log('');
  console.log(`[checkpoint-repair-composition-evaluation] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[checkpoint-repair-composition-evaluation] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
