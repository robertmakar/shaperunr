/**
 * DEVELOPMENT ONLY. Runs the order-component decomposition and rescue
 * scenario analysis (see order-component-rescue.ts) against real
 * ROBZ/CAIRO requests plus single-letter controls, in-process (direct
 * pipeline calls, no HTTP, sequential by construction — no isolation
 * issues, no change to any production request timeout). Read-only:
 * computes mathematical what-if scenarios over already-computed real
 * order components — never changes which candidates are feasible/
 * routed/accepted, never changes the route returned to the user.
 *
 * Run with: npx tsx src/diagnostics/order-component-rescue.run.ts --prefix backend
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
import { computeLetterComponentDecomposition, type ComponentBoundClassification } from './order-component-rescue';
import { extractLetterOrderInputs } from './order-score-diagnostic';

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
  direction: string;
  dtwFit: number;
  progressFit: number;
  directionFit: number;
  monotonicFit: number;
  jumpFit: number;
  revisitFit: number;
  order: number;
  dtwContribution: number;
  progressContribution: number;
  directionContribution: number;
  meanAngularErrorDegrees: number | null;
  worstAngularErrorDegrees: number | null;
  scenarios: Record<string, number>;
  classification: ComponentBoundClassification;
};

type CandidateRecord = {
  candidateRank: number;
  geometryVariant: string;
  currentOccupiedSpan: number;
  inkOnlyOccupancy: number;
  letters: LetterRecord[];
  lettersTotal: number;
  lettersWithRawInkPassingCoverage: number;
  lettersPassingOrder: number;
  lettersRescueableByDtw: number;
  lettersRescueableByProgress: number;
  lettersRescueableByDirection: number;
  lettersRequiringMultiple: number;
  lettersGeometryBound: number;
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

  const letters: LetterRecord[] = orderInputs.map((input, index) => {
    const decomposition = computeLetterComponentDecomposition(input);
    return {
      letter: input.letter,
      index,
      rawInkCoverage: inkResult.perLetterOccupancy[index]?.occupancy ?? 0,
      existingCoverage: identity.letters[index]?.coverage ?? 0,
      direction: decomposition.direction,
      dtwFit: decomposition.order.dtwFit,
      progressFit: decomposition.order.progressFit,
      directionFit: decomposition.order.directionFit,
      monotonicFit: decomposition.order.monotonicFit,
      jumpFit: decomposition.order.jumpFit,
      revisitFit: decomposition.order.revisitFit,
      order: decomposition.order.order,
      dtwContribution: decomposition.dtwContribution,
      progressContribution: decomposition.progressContribution,
      directionContribution: decomposition.directionContribution,
      meanAngularErrorDegrees: decomposition.directionStats.meanAngularErrorDegrees,
      worstAngularErrorDegrees: decomposition.directionStats.worstAngularErrorDegrees,
      scenarios: decomposition.scenarios,
      classification: decomposition.classification,
    };
  });

  return {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    currentOccupiedSpan: identity.targetSpan,
    inkOnlyOccupancy: inkResult.inkOnlyOccupancy,
    letters,
    lettersTotal: letters.length,
    lettersWithRawInkPassingCoverage: letters.filter((l) => l.existingCoverage >= 0.32).length,
    lettersPassingOrder: letters.filter((l) => l.order >= 0.45).length,
    lettersRescueableByDtw: letters.filter((l) => l.classification === 'dtw_bound').length,
    lettersRescueableByProgress: letters.filter((l) => l.classification === 'progress_bound').length,
    lettersRescueableByDirection: letters.filter((l) => l.classification === 'direction_bound').length,
    lettersRequiringMultiple: letters.filter((l) => l.classification === 'mixed').length,
    lettersGeometryBound: letters.filter((l) => l.classification === 'geometry_bound').length,
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
    console.log(`[order-component-rescue] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m (${testCase.role})...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[order-component-rescue] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'order-component-rescue-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[order-component-rescue] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[order-component-rescue] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
