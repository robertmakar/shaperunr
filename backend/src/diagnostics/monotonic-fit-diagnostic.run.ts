/**
 * DEVELOPMENT ONLY. Runs the monotonicFit root-cause diagnostic (see
 * monotonic-fit-diagnostic.ts) against the exact real 78-candidate
 * multi-letter corpus, for checkpoint-v1's route on every candidate
 * (production's route too, for the forensic comparison tables).
 *
 * Persists, per letter: the real progress sequence, negative-step
 * statistics, all 8 shadow monotonicity variants, and route-length /
 * point-count metadata for the sensitivity analyses. Combined-variant
 * recombination happens in the aggregate analysis pass.
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate; never touches dedupeRoutes/dedupeMeters.
 *
 * Run with: npx tsx src/diagnostics/monotonic-fit-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import {
  extractProgressSequence,
  summarizeProgressSequence,
  findNegativeSteps,
  evaluateMonotonicVariant,
  extractLetterOrderInputs,
  computeLetterOrderDecomposition,
} from './monotonic-fit-diagnostic';
import type { MonotonicVariantKey } from './monotonic-fit-diagnostic';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
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

const MONOTONIC_VARIANT_KEYS: MonotonicVariantKey[] = ['A_current', 'B_quadratic', 'C_eps01', 'C_eps02', 'C_eps03', 'C_eps05', 'D_cumulative', 'E_smoothed'];

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type LetterMonotonicRecord = {
  letter: string;
  index: number;
  rawInk: number;
  coverage: number;
  order: number;
  dtwFit: number;
  monotonicFit: number;
  jumpFit: number;
  revisitFit: number;
  progressFit: number;
  directionFit: number;
  letterRoutePointCount: number;
  letterRouteLengthUnits: number;
  letterTargetLengthUnits: number;
  progressSequence: number[];
  negativeSteps: Array<{ index: number; previousProgress: number; currentProgress: number; delta: number; magnitude: number }>;
  stats: ReturnType<typeof summarizeProgressSequence>;
  monotonicVariants: Record<MonotonicVariantKey, number>;
};

function buildLetterMonotonicRecords(word: string, target: readonly Vec2[], route: Vec2[], geometryVariant: 'smooth' | 'angular' | 'hybrid'): LetterMonotonicRecord[] {
  if (route.length < 2) return [];
  const identity = analyzeTargetIdentity({ route, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const ink = computeInkOnlyOccupancy({ route, target, boundarySet, letterMeaningfullyVisited: identity.letters.map((l) => l.meaningfullyVisited) });
  const orderInputs = extractLetterOrderInputs(word, target, route, geometryVariant);
  const decompositions = orderInputs.map(computeLetterOrderDecomposition);

  return identity.letters.map((letterIdentity, index) => {
    const decomposition = decompositions[index]!;
    const input = orderInputs[index]!;
    const rawInk = ink.perLetterOccupancy[index]?.occupancy ?? 0;
    const progressSequence = input.letterRoute.length >= 2 ? extractProgressSequence(input.letterRoute, input.letterTarget) : [];
    const negativeSteps = findNegativeSteps(progressSequence);
    const stats = summarizeProgressSequence(progressSequence);

    const monotonicVariants = {} as Record<MonotonicVariantKey, number>;
    for (const key of MONOTONIC_VARIANT_KEYS) {
      monotonicVariants[key] = progressSequence.length >= 2 ? evaluateMonotonicVariant(progressSequence, key) : 1;
    }

    return {
      letter: letterIdentity.letter,
      index,
      rawInk,
      coverage: letterIdentity.coverage,
      order: letterIdentity.order,
      dtwFit: decomposition.forward.dtwFit,
      monotonicFit: decomposition.forward.monotonicFit,
      jumpFit: decomposition.forward.jumpFit,
      revisitFit: decomposition.forward.revisitFit,
      progressFit: decomposition.forward.progressFit,
      directionFit: decomposition.forward.directionFit,
      letterRoutePointCount: input.letterRoute.length,
      letterRouteLengthUnits: polylineLength(input.letterRoute),
      letterTargetLengthUnits: polylineLength(input.letterTarget),
      progressSequence,
      negativeSteps,
      stats,
      monotonicVariants,
    };
  });
}

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  production: LetterMonotonicRecord[];
  checkpointV1: LetterMonotonicRecord[];
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateReport[];
};

function analyzeCandidate(word: string, item: FeasibilityRecord, start: { latitude: number; longitude: number }): CandidateReport | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) return null;
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const graph = reconstructGraph(item.graphLines);
  const kind = shapeKindFromWord(word);
  const multiLetter = word.length > 1;

  const productionResult = routeGraphConstrainedShape({ target: item.target, kind, graph, multiLetter });
  const production = buildLetterMonotonicRecords(word, item.target, productionResult.pathPoints, geometryVariant);

  const checkpointResult = generateCheckpointRoutes({
    word,
    target: item.target,
    graph,
    kind,
    geometryVariant,
    targetDistanceMeters: item.shapeRouteMeters > 0 ? item.shapeRouteMeters : 2000,
    searchOrigin: start,
    placement: { rotationDegrees: item.rotationDegrees, scale: item.scale, eastMeters: item.eastMeters, northMeters: item.northMeters, distanceFromUserMeters: 0 },
  });
  const best = checkpointResult.candidates[0] ?? null;
  const checkpointPathPoints = best ? coordinatesToLocalMeters(start, best.route.shapeCoordinates ?? best.route.coordinates) : [];
  const checkpointV1 = buildLetterMonotonicRecords(word, item.target, checkpointPathPoints, geometryVariant);

  return { candidateRank: item.variantRank ?? -1, geometryVariant, production, checkpointV1 };
}

async function runCase(testCase: (typeof MULTI_LETTER_CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const candidates = feasible
    .map((item) => analyzeCandidate(testCase.word, item, testCase.start))
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
  const cases: CaseReport[] = [];
  for (const testCase of MULTI_LETTER_CASES) {
    console.log(`[monotonic-fit-diagnostic] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[monotonic-fit-diagnostic] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'monotonic-fit-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), variantKeys: MONOTONIC_VARIANT_KEYS, cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[monotonic-fit-diagnostic] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[monotonic-fit-diagnostic] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
