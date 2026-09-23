/**
 * DEVELOPMENT ONLY. Runs the order-score diagnostic decomposition (see
 * order-score-diagnostic.ts) against real ROBZ/CAIRO requests, in-process
 * (direct pipeline calls, no HTTP, sequential by construction). Read-only:
 * computes diagnostic order-score components alongside the existing,
 * unmodified TargetIdentity/scoreOrderedPath results — never changes which
 * candidates are feasible/routed/accepted, never changes the route
 * returned to the user.
 *
 * Run with: npx tsx src/diagnostics/order-score-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';

import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape, type LetterBoundarySet } from './multi-letter-trace';
import {
  computeLetterOrderDecomposition,
  extractLetterOrderInputs,
  type DirectionClass,
} from './order-score-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK: Coordinate = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA: Coordinate = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CASES: Array<{ word: string; locationName: string; start: Coordinate; targetDistanceMeters: number }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];

type LetterOrderRecord = {
  letter: string;
  index: number;
  rawInkOccupancy: number;
  existingCoverage: number;
  existingOrder: number;
  meaningfullyVisited: boolean;
  direction: DirectionClass;
  dtwFit: number;
  monotonicFit: number;
  jumpFit: number;
  revisitFit: number;
  directionFit: number;
  progressFit: number;
  reverseOrder: number;
  shadowCoherentProgressFit: number;
  shadowBidirectionalOrder: number;
  routeProgressSequence: number[];
};

type CandidateOrderRecord = {
  word: string;
  geometryVariant: string;
  candidateRank: number;
  currentWordTraversal: boolean;
  currentOccupiedSpan: number;
  inkOnlyOccupancy: number;
  letters: LetterOrderRecord[];
};

function buildRecord(word: string, item: FeasibilityRecord, boundarySet: LetterBoundarySet): CandidateOrderRecord | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) {
    return null;
  }
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const identity = analyzeTargetIdentity({ route: item.pathPoints, target: item.target, word, geometryVariant });
  const inkResult = computeInkOnlyOccupancy({
    route: item.pathPoints,
    target: item.target,
    boundarySet,
    letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited),
  });
  const orderInputs = extractLetterOrderInputs(word, item.target, item.pathPoints, geometryVariant);

  const letters: LetterOrderRecord[] = orderInputs.map((input, index) => {
    const decomposition = computeLetterOrderDecomposition(input);
    return {
      letter: input.letter,
      index,
      rawInkOccupancy: inkResult.perLetterOccupancy[index]?.occupancy ?? 0,
      existingCoverage: identity.letters[index]?.coverage ?? 0,
      existingOrder: identity.letters[index]?.order ?? 0,
      meaningfullyVisited: identity.letters[index]?.meaningfullyVisited ?? false,
      direction: decomposition.direction,
      dtwFit: decomposition.forward.dtwFit,
      monotonicFit: decomposition.forward.monotonicFit,
      jumpFit: decomposition.forward.jumpFit,
      revisitFit: decomposition.forward.revisitFit,
      directionFit: decomposition.forward.directionFit,
      progressFit: decomposition.forward.progressFit,
      reverseOrder: decomposition.reverse.order,
      shadowCoherentProgressFit: decomposition.shadowCoherentProgressFit,
      shadowBidirectionalOrder: decomposition.shadowBidirectionalOrder,
      routeProgressSequence: decomposition.routeProgressSequence.map((p) => Number(p.toFixed(3))),
    };
  });

  return {
    word,
    geometryVariant,
    candidateRank: item.variantRank ?? -1,
    currentWordTraversal: identity.traversesMostOfWord,
    currentOccupiedSpan: identity.targetSpan,
    inkOnlyOccupancy: inkResult.inkOnlyOccupancy,
    letters,
  };
}

async function runCase(testCase: (typeof CASES)[number]) {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const wordShape = buildWalkableWordShape(testCase.word, { letterVariant: 'smooth' });
  const boundarySet = letterBoundariesFromWordShape(wordShape);
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const candidates = feasible
    .map((item) => buildRecord(testCase.word, item, boundarySet))
    .filter((record): record is CandidateOrderRecord => record !== null);

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    status: report.status,
    graphFeasibleCount: feasible.length,
    candidates,
  };
}

async function main() {
  const started = Date.now();
  const cases: Array<Awaited<ReturnType<typeof runCase>>> = [];
  for (const testCase of CASES) {
    console.log(`[order-score] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[order-score] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'order-score-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[order-score] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[order-score] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
