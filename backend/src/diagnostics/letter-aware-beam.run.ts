/**
 * DEVELOPMENT ONLY. Runs the letter-aware beam-state shadow experiment
 * (see letter-aware-beam.ts) across OLD/NEW_40/NEW_50/NEW_60 against the
 * same real 8-config multi-letter corpus used throughout this
 * investigation, plus mandatory single-letter controls (L, I, O, R),
 * in-process, sequential.
 *
 * For every multi-letter candidate: runs the beam search once per
 * variant, records search-behavior metrics (expansions, letters entered/
 * completed, state-machine transitions, final currentLetterIndex) and
 * route-quality metrics (shapeScore, coverage, order, targetSpan,
 * backtrack, rawInkCoverage, wordTraversal, allLettersCoveredAndOrdered),
 * then compares OLD vs each NEW variant.
 *
 * Run with: npx tsx src/diagnostics/letter-aware-beam.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';

import { LETTER_AWARE_VARIANTS, traceLetterAwareBeam, type LetterTransitionEvent } from './letter-aware-beam';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { scorePolylines } from '../scoring/shape-match';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

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

const SINGLE_LETTER_CASES: Array<{ word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number }> = [
  { word: 'L', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'I', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'O', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'R', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
];

const VARIANT_KEYS = Object.keys(LETTER_AWARE_VARIANTS);

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type VariantResult = {
  shapeScore: number | null;
  coverage: number | null;
  order: number | null;
  backtrack: number | null;
  targetSpan: number;
  distanceRatio: number;
  wordTraversal: boolean;
  allLettersCoveredAndOrdered: boolean;
  rawInkCoverageMean: number;
  perLetterRawInk: number[];
  expansions: number;
  runtimeMs: number;
  edgeIds: string[];
  lettersEntered: number;
  lettersCompleted: number;
  completionOrder: number[];
  currentLetterIndexMax: number;
  transitions: LetterTransitionEvent[];
};

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  variants: Record<string, VariantResult>;
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateReport[];
};

function computeVariantResult(word: string, item: FeasibilityRecord, graph: ShapeGraph, geometryVariant: 'smooth' | 'angular' | 'hybrid', variantKey: string): VariantResult {
  const kind = shapeKindFromWord(word);
  const multiLetter = word.length > 1;
  const started = performance.now();
  const { result, expansions, transitions, lettersCompletedMax, finalCurrentLetterIndex } = traceLetterAwareBeam(
    { word, target: item.target, graph, kind, multiLetter, geometryVariant },
    LETTER_AWARE_VARIANTS[variantKey]!,
  );
  const runtimeMs = performance.now() - started;

  const identity = analyzeTargetIdentity({ route: result.pathPoints, target: item.target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const inkResult =
    result.pathPoints.length >= 2
      ? computeInkOnlyOccupancy({ route: result.pathPoints, target: item.target, boundarySet, letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited) })
      : null;
  const scored = result.pathPoints.length >= 2 ? scorePolylines(result.pathPoints, item.target) : null;
  const perLetterRawInk = inkResult ? inkResult.perLetterOccupancy.map((l) => l.occupancy) : [];
  const rawInkMean = perLetterRawInk.length ? perLetterRawInk.reduce((s, v) => s + v, 0) / perLetterRawInk.length : 0;
  const allLettersCoveredAndOrdered = identity.letters.every((l) => l.meaningfullyVisited) && identity.lettersVisitedInOrder;
  const completionOrder = transitions.map((t) => t.toLetterIndex);

  return {
    shapeScore: scored?.score ?? null,
    coverage: scored?.coverage ?? null,
    order: scored?.breakdown.order ?? null,
    backtrack: scored?.details.backtrackRatio ?? null,
    targetSpan: identity.targetSpan,
    distanceRatio: result.metrics.distanceRatio,
    wordTraversal: identity.traversesMostOfWord,
    allLettersCoveredAndOrdered,
    rawInkCoverageMean: rawInkMean,
    perLetterRawInk,
    expansions,
    runtimeMs,
    edgeIds: result.edgeIds,
    lettersEntered: finalCurrentLetterIndex + 1,
    lettersCompleted: lettersCompletedMax,
    completionOrder,
    currentLetterIndexMax: finalCurrentLetterIndex,
    transitions,
  };
}

function analyzeCandidate(word: string, item: FeasibilityRecord): CandidateReport | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) return null;
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const graph = reconstructGraph(item.graphLines);

  const variants: Record<string, VariantResult> = {};
  for (const variantKey of VARIANT_KEYS) {
    variants[variantKey] = computeVariantResult(word, item, graph, geometryVariant, variantKey);
  }

  return { candidateRank: item.variantRank ?? -1, geometryVariant, variants };
}

async function runCase(testCase: (typeof MULTI_LETTER_CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const candidates = feasible
    .map((item) => analyzeCandidate(testCase.word, item))
    .filter((record): record is CandidateReport => record !== null);

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    graphFeasibleCount: feasible.length,
    candidates,
  };
}

async function main() {
  const started = Date.now();
  const multiLetterCases: CaseReport[] = [];
  for (const testCase of MULTI_LETTER_CASES) {
    console.log(`[letter-aware-beam] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    multiLetterCases.push(result);
    console.log(`[letter-aware-beam] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  const singleLetterCases: CaseReport[] = [];
  for (const testCase of SINGLE_LETTER_CASES) {
    console.log(`[letter-aware-beam] running single-letter control ${testCase.word}...`);
    const result = await runCase(testCase);
    singleLetterCases.push(result);
    console.log(`[letter-aware-beam] done ${testCase.word} -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'letter-aware-beam-results.json');
  writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), variants: Object.keys(LETTER_AWARE_VARIANTS), multiLetterCases, singleLetterCases }, null, 2),
    'utf8',
  );

  console.log('');
  console.log(`[letter-aware-beam] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[letter-aware-beam] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
