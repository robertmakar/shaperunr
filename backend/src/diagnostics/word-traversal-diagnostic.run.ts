/**
 * DEVELOPMENT ONLY. Runs the word-traversal recognition diagnostic (see
 * word-traversal-diagnostic.ts) against the exact real 78-candidate
 * multi-letter corpus used throughout this session, for BOTH the current
 * production route and the checkpoint-v1 route on the same candidate —
 * plus the 4 mandatory forensic cases (ROBZ #1, ROBZ #2, CAIRO missed-O,
 * strongest CAIRO).
 *
 * Pure observation: this script never modifies production, never feeds
 * anything back into scoring or the product gate, and does not touch
 * checkpoint-v1's own deduplication (explicitly out of scope this task).
 *
 * Run with: npx tsx src/diagnostics/word-traversal-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';

import {
  buildWordTraversalReport,
  buildLetterBoundaryReport,
  buildRouteProgressTrace,
  evaluateShadowLetterVisited,
  evaluateShadowTraversalVariants,
  type WordTraversalReport,
} from './word-traversal-diagnostic';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';
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

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

function summarizeReport(report: WordTraversalReport) {
  const letters = report.letters.map((l) => ({
    index: l.index,
    letter: l.letter,
    targetStartProgress: l.targetStartProgress,
    targetEndProgress: l.targetEndProgress,
    routeStartProgress: l.routeStartProgress,
    routeEndProgress: l.routeEndProgress,
    rawInk: l.rawInk,
    coverage: l.coverage,
    order: l.order,
    dtwFit: l.dtwFit,
    progressFit: l.progressFit,
    directionFit: l.directionFit,
    meaningfullyVisited: l.meaningfullyVisited,
    bindingFailure: l.bindingFailure,
    recognitionByThreshold: l.recognitionByThreshold,
    shadow: evaluateShadowLetterVisited(l),
  }));
  const variants = evaluateShadowTraversalVariants(report.letters);
  const allVisited = report.allLettersVisitedFraction >= 1;
  const inOrder = report.lettersVisitedInOrder;
  const spanOk = report.occupiedSpan >= 0.7;
  let failureCategory: 'A_not_all_visited' | 'B_wrong_order' | 'C_both' | 'D_span_too_low' | 'PASS';
  if (report.traversesMostOfWord) failureCategory = 'PASS';
  else if (!allVisited && inOrder && spanOk) failureCategory = 'A_not_all_visited';
  else if (allVisited && !inOrder) failureCategory = 'B_wrong_order';
  else if (!allVisited && !inOrder) failureCategory = 'C_both';
  else failureCategory = 'D_span_too_low';

  return {
    letters,
    occupiedSpan: report.occupiedSpan,
    spanOccupancy: report.spanOccupancy,
    largestTargetGap: report.largestTargetGap,
    allLettersVisitedFraction: report.allLettersVisitedFraction,
    lettersVisitedInOrder: report.lettersVisitedInOrder,
    traversesMostOfWord: report.traversesMostOfWord,
    failureCategory,
    shadowVariants: variants,
  };
}

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  production: ReturnType<typeof summarizeReport>;
  checkpointV1: ReturnType<typeof summarizeReport> | null;
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
  const productionReport = buildWordTraversalReport(word, item.target, productionResult.pathPoints, geometryVariant);

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
  const checkpointPathPoints = best ? coordinatesToLocalMeters(start, best.route.shapeCoordinates ?? best.route.coordinates) : null;
  const checkpointReport = checkpointPathPoints ? buildWordTraversalReport(word, item.target, checkpointPathPoints, geometryVariant) : null;

  return {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    production: summarizeReport(productionReport),
    checkpointV1: checkpointReport ? summarizeReport(checkpointReport) : null,
  };
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
    console.log(`[word-traversal-diagnostic] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[word-traversal-diagnostic] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  // Boundary reports for the 3 forensic words (Step 5).
  const boundaryReports = {
    ROBZ: buildLetterBoundaryReport('ROBZ', buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' }).points, 'smooth'),
    CAIRO: buildLetterBoundaryReport('CAIRO', buildWalkableWordShape('CAIRO', { letterVariant: 'smooth' }).points, 'smooth'),
  };

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'word-traversal-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), boundaryReports, cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[word-traversal-diagnostic] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[word-traversal-diagnostic] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

// Route-progress traces for the forensic cases are computed separately in the aggregate/forensic analysis pass (needs the exact same candidate objects re-identified by profile-matching, per this session's established index-alignment convention) rather than stored in bulk here.
export { buildRouteProgressTrace };
