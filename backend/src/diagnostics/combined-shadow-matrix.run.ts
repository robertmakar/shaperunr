/**
 * DEVELOPMENT ONLY. Runs the combined shadow evaluation matrix (see
 * combined-shadow-matrix.ts) against real ROBZ/CAIRO requests plus
 * single-letter controls (I/O/R/Z), in-process (direct pipeline calls, no
 * HTTP, sequential by construction — no isolation issues, no change to any
 * production request timeout). Read-only: evaluates four shadow conditions
 * (A_current / B_inkOnly / C_dtw2x / D_combined) alongside the existing,
 * unmodified TargetIdentity result — never changes which candidates are
 * feasible/routed/accepted, never changes the route returned to the user.
 *
 * Run with: npx tsx src/diagnostics/combined-shadow-matrix.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';

import {
  buildLetterShadowRecords,
  classifyCandidate,
  computeConditionResults,
  type CandidateClassification,
  type ConditionResult,
  type LetterShadowRecord,
} from './combined-shadow-matrix';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape, type LetterBoundarySet } from './multi-letter-trace';
import { extractLetterOrderInputs } from './order-score-diagnostic';
import { scorePolylines } from '../scoring/shape-match';

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

type CandidateRecord = {
  candidateRank: number;
  geometryVariant: string;
  currentOccupiedSpan: number;
  currentSpanOccupancy: number;
  inkOnlyOccupancy: number;
  currentCompletedLetterCount: number;
  currentShapeScore: number | null;
  currentCoverage: number | null;
  currentOrder: number | null;
  letters: LetterShadowRecord[];
  conditions: ConditionResult[];
  classification: CandidateClassification;
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
  const scored = scorePolylines(item.pathPoints, item.target);

  const letters = buildLetterShadowRecords(identity, inkResult, orderInputs);
  const conditions = computeConditionResults(identity, letters, identity.targetSpan, inkResult.inkOnlyOccupancy);
  const classification = classifyCandidate(conditions);

  return {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    currentOccupiedSpan: identity.targetSpan,
    currentSpanOccupancy: identity.spanOccupancy,
    inkOnlyOccupancy: inkResult.inkOnlyOccupancy,
    currentCompletedLetterCount: identity.lettersVisited,
    currentShapeScore: scored?.score ?? null,
    currentCoverage: scored?.coverage ?? null,
    currentOrder: scored?.breakdown.order ?? null,
    letters,
    conditions,
    classification,
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
    candidates,
  };
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of CASES) {
    console.log(`[combined-shadow] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m (${testCase.role})...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[combined-shadow] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'combined-shadow-matrix-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[combined-shadow] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[combined-shadow] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
