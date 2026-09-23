/**
 * DEVELOPMENT ONLY. Runs the shadow DTW-tolerance evaluator (see
 * dtw-tolerance-diagnostic.ts) against real ROBZ/CAIRO requests plus
 * single-letter controls (I/O/R/Z), in-process (direct pipeline calls, no
 * HTTP, sequential by construction — no isolation issues, no change to any
 * production request timeout). Read-only: computes shadow order values at
 * several orderDistanceScale multipliers alongside the existing,
 * unmodified TargetIdentity/scoreOrderedPath results — never changes which
 * candidates are feasible/routed/accepted, never changes the route
 * returned to the user.
 *
 * Run with: npx tsx src/diagnostics/dtw-tolerance-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';

import {
  computeLetterDtwToleranceRecord,
  computeShadowCandidateSummaries,
  computeShadowOrderAtMultiplier,
  DTW_TOLERANCE_MULTIPLIERS,
  type ShadowCandidateMultiplierSummary,
} from './dtw-tolerance-diagnostic';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape, type LetterBoundarySet } from './multi-letter-trace';
import { extractLetterOrderInputs } from './order-score-diagnostic';
import { buildWalkableWordShape } from '../generation/walkable-target';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK: Coordinate = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA: Coordinate = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CASES: Array<{ word: string; locationName: string; start: Coordinate; targetDistanceMeters: number; role: 'multi-letter' | 'control' }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'multi-letter' },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'multi-letter' },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000, role: 'multi-letter' },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000, role: 'multi-letter' },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'multi-letter' },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'multi-letter' },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000, role: 'multi-letter' },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000, role: 'multi-letter' },
  { word: 'I', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'control' },
  { word: 'I', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'control' },
  { word: 'O', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000, role: 'control' },
  { word: 'O', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000, role: 'control' },
  { word: 'R', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'control' },
  { word: 'R', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'control' },
  { word: 'Z', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'control' },
  { word: 'Z', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'control' },
];

type LetterRecord = {
  letter: string;
  index: number;
  direction: string;
  rawInkOccupancy: number;
  existingCoverage: number;
  existingOrder: number;
  existingDtwFit: number;
  existingProgressFit: number;
  existingDirectionFit: number;
  shadowOrderByMultiplier: Record<string, number>;
  shadowDtwFitByMultiplier: Record<string, number>;
};

type CandidateRecord = {
  candidateRank: number;
  geometryVariant: string;
  currentWordTraversal: boolean;
  currentLettersVisitedInOrder: boolean;
  currentCompletedLetterCount: number;
  currentOccupiedSpan: number;
  letters: LetterRecord[];
  shadowByMultiplier: ShadowCandidateMultiplierSummary[];
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  role: 'multi-letter' | 'control';
  status: string;
  graphFeasibleCount: number;
  routedCount: number;
  candidates: CandidateRecord[];
};

function buildCandidateRecord(word: string, item: FeasibilityRecord, boundarySet: LetterBoundarySet): CandidateRecord | null {
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

  const letters: LetterRecord[] = orderInputs.map((input, index) => {
    const toleranceRecord = computeLetterDtwToleranceRecord(input);
    const shadowOrderByMultiplier: Record<string, number> = {};
    const shadowDtwFitByMultiplier: Record<string, number> = {};
    for (const multiplier of DTW_TOLERANCE_MULTIPLIERS) {
      const key = String(multiplier);
      shadowOrderByMultiplier[key] = toleranceRecord.shadowByMultiplier[key]!.order;
      shadowDtwFitByMultiplier[key] = toleranceRecord.shadowByMultiplier[key]!.dtwFit;
    }
    return {
      letter: input.letter,
      index,
      direction: toleranceRecord.direction,
      rawInkOccupancy: inkResult.perLetterOccupancy[index]?.occupancy ?? 0,
      existingCoverage: identity.letters[index]?.coverage ?? 0,
      existingOrder: identity.letters[index]?.order ?? 0,
      existingDtwFit: shadowOrderByMultiplier['1'] !== undefined ? toleranceRecord.shadowByMultiplier['1']!.dtwFit : 0,
      existingProgressFit: toleranceRecord.shadowByMultiplier['1']!.progressFit,
      existingDirectionFit: toleranceRecord.shadowByMultiplier['1']!.directionFit,
      shadowOrderByMultiplier,
      shadowDtwFitByMultiplier,
    };
  });

  const letterShadowOrders = DTW_TOLERANCE_MULTIPLIERS.map((multiplier) => orderInputs.map((input) => computeShadowOrderAtMultiplier(input, multiplier).order));
  const shadowByMultiplier = computeShadowCandidateSummaries(identity, letterShadowOrders);

  return {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    currentWordTraversal: identity.traversesMostOfWord,
    currentLettersVisitedInOrder: identity.lettersVisitedInOrder,
    currentCompletedLetterCount: identity.lettersVisited,
    currentOccupiedSpan: identity.targetSpan,
    letters,
    shadowByMultiplier,
  };
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const wordShape = buildWalkableWordShape(testCase.word, { letterVariant: 'smooth' });
  const boundarySet = letterBoundariesFromWordShape(wordShape);
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);
  const routedCount = report.diagnostics.placementsRouted ?? 0;

  const candidates = feasible
    .map((item) => buildCandidateRecord(testCase.word, item, boundarySet))
    .filter((record): record is CandidateRecord => record !== null);

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    role: testCase.role,
    status: report.status,
    graphFeasibleCount: feasible.length,
    routedCount,
    candidates,
  };
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of CASES) {
    console.log(`[dtw-tolerance] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m (${testCase.role})...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[dtw-tolerance] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount} routed=${result.routedCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'dtw-tolerance-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[dtw-tolerance] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[dtw-tolerance] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
