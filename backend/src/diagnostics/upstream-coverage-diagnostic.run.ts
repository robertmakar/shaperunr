/**
 * DEVELOPMENT ONLY. Runs the upstream physical-coverage diagnostics (see
 * upstream-coverage-diagnostic.ts) against real ROBZ/CAIRO requests plus
 * single-letter controls, in-process (direct pipeline calls, no HTTP,
 * sequential by construction — no isolation issues, no change to any
 * production request timeout). Read-only: measures how much of each
 * letter's own target ink the ALREADY-CAPTURED nearby graph geometry
 * (FeasibilityRecord.graphLines, produced by the unmodified production
 * pipeline) supports at several distance thresholds — never touches graph
 * search, street-fit ranking, or beam-search code, never changes which
 * candidates are feasible/routed/accepted, never changes the route
 * returned to the user.
 *
 * Run with: npx tsx src/diagnostics/upstream-coverage-diagnostic.run.ts --prefix backend
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
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { extractLetterOrderInputs } from './order-score-diagnostic';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  buildLetterTraceableProfile,
  classifyUpstreamFailure,
  PRODUCTION_DISTANCE_THRESHOLDS,
  type LetterTraceableProfile,
  type UpstreamFailureClass,
} from './upstream-coverage-diagnostic';

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
  rawInkCoverage: number;
  existingCoverage: number;
  meaningfullyVisited: boolean;
  profile: LetterTraceableProfile;
  classification: UpstreamFailureClass;
};

type CandidateRecord = {
  candidateRank: number;
  geometryVariant: string;
  streetFitScore: number;
  currentOccupiedSpan: number;
  inkOnlyOccupancy: number;
  graphEdgeCount: number;
  candidateEdgeCount: number;
  statesExplored: number;
  failure: string | null;
  failureReason: string | null;
  letters: LetterRecord[];
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  role: 'multi-letter' | 'control';
  status: string;
  graphFeasibleCount: number;
  candidates: CandidateRecord[];
};

function buildCandidateRecord(word: string, item: FeasibilityRecord): CandidateRecord | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) {
    return null;
  }
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const identity = analyzeTargetIdentity({ route: item.pathPoints, target: item.target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const inkResult = computeInkOnlyOccupancy({
    route: item.pathPoints,
    target: item.target,
    boundarySet,
    letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited),
  });
  const orderInputs = extractLetterOrderInputs(word, item.target, item.pathPoints, geometryVariant);

  const letters: LetterRecord[] = orderInputs.map((input, index) => {
    const rawInkCoverage = inkResult.perLetterOccupancy[index]?.occupancy ?? 0;
    const existingCoverage = identity.letters[index]?.coverage ?? 0;
    const meaningfullyVisited = identity.letters[index]?.meaningfullyVisited ?? false;
    const profile = buildLetterTraceableProfile(input.letter, input.letterTarget, item.graphLines, input.coverageThreshold);
    return {
      letter: input.letter,
      index,
      rawInkCoverage,
      existingCoverage,
      meaningfullyVisited,
      profile,
      classification: classifyUpstreamFailure(profile, rawInkCoverage, meaningfullyVisited),
    };
  });

  return {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    streetFitScore: item.streetFitScore,
    currentOccupiedSpan: identity.targetSpan,
    inkOnlyOccupancy: inkResult.inkOnlyOccupancy,
    graphEdgeCount: item.result.search.graphEdgeCount,
    candidateEdgeCount: item.result.search.candidateEdgeCount,
    statesExplored: item.result.search.statesExplored,
    failure: item.result.failure,
    failureReason: item.result.failureReason,
    letters,
  };
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const candidates = feasible
    .map((item) => buildCandidateRecord(testCase.word, item))
    .filter((record): record is CandidateRecord => record !== null);

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    role: testCase.role,
    status: report.status,
    graphFeasibleCount: feasible.length,
    candidates,
  };
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of CASES) {
    console.log(`[upstream-coverage] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m (${testCase.role})...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[upstream-coverage] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'upstream-coverage-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), thresholds: PRODUCTION_DISTANCE_THRESHOLDS, cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[upstream-coverage] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[upstream-coverage] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
