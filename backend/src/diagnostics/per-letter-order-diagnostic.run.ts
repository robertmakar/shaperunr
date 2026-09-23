/**
 * DEVELOPMENT ONLY. Runs the per-letter order root-cause diagnostic (see
 * per-letter-order-diagnostic.ts) against the exact real 78-candidate
 * multi-letter corpus, computing checkpoint-v1's route per candidate
 * (production's route too, for comparison), and for EVERY letter:
 *
 * - the current (production) window's exact inputs + gap detection
 * - 6 shadow window variants (Step 4)
 * - direction-consistency per-segment trace (Step 7)
 * - 4 shadow component compositions (Step 9)
 * - rawInk (for the correlation/top-20 analysis, Steps 11-12)
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate; never touches dedupeRoutes/dedupeMeters.
 *
 * Run with: npx tsx src/diagnostics/per-letter-order-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import {
  extractLetterRouteWindowInputs,
  evaluateShadowWindow,
  traceDirectionConsistency,
  composeShadowOrder,
  computeInkOnlyOccupancy,
  letterBoundariesFromWordShape,
  WINDOW_VARIANTS,
  type WindowVariantKey,
} from './per-letter-order-diagnostic';
import { extractLetterOrderInputs, computeLetterOrderDecomposition } from './order-score-diagnostic';
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

const WINDOW_KEYS = Object.keys(WINDOW_VARIANTS) as WindowVariantKey[];

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type LetterInstanceRecord = {
  letter: string;
  index: number;
  rawInk: number;
  coverage: number;
  order: number;
  dtwFit: number;
  progressFit: number;
  directionFit: number;
  monotonicFit: number;
  jumpFit: number;
  revisitFit: number;
  letterRoutePointCount: number;
  letterTargetPointCount: number;
  letterTargetLengthUnits: number;
  gapCount: number;
  maxGapSize: number;
  routeMinProgress: number | null;
  routeMaxProgress: number | null;
  targetStartProgress: number;
  targetEndProgress: number;
  shadowWindows: Record<WindowVariantKey, { order: number; progressFit: number; directionFit: number; letterRoutePointCount: number; gapCount: number }>;
  shadowComponents: { actual: number; perfectProgress: number; perfectDirection: number; perfectBoth: number };
};

function buildLetterInstanceRecords(word: string, target: readonly Vec2[], route: Vec2[], geometryVariant: 'smooth' | 'angular' | 'hybrid'): LetterInstanceRecord[] {
  if (route.length < 2) return [];
  const identity = analyzeTargetIdentity({ route, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const ink = computeInkOnlyOccupancy({ route, target, boundarySet, letterMeaningfullyVisited: identity.letters.map((l) => l.meaningfullyVisited) });
  const orderInputs = extractLetterOrderInputs(word, target, route, geometryVariant);
  const decompositions = orderInputs.map(computeLetterOrderDecomposition);
  const windowInputs = extractLetterRouteWindowInputs(word, target, route, geometryVariant);

  const shadowByVariant: Record<WindowVariantKey, ReturnType<typeof evaluateShadowWindow>> = {} as never;
  for (const key of WINDOW_KEYS) shadowByVariant[key] = evaluateShadowWindow(word, target, route, geometryVariant, key);

  return identity.letters.map((letterIdentity, index) => {
    const decomposition = decompositions[index]!;
    const windowInput = windowInputs[index]!;
    const rawInk = ink.perLetterOccupancy[index]?.occupancy ?? 0;

    const shadowWindows = {} as LetterInstanceRecord['shadowWindows'];
    for (const key of WINDOW_KEYS) {
      const r = shadowByVariant[key][index]!;
      shadowWindows[key] = { order: r.order.order, progressFit: r.order.progressFit, directionFit: r.order.directionFit, letterRoutePointCount: r.letterRoutePointCount, gapCount: r.gapCount };
    }

    const shadowComponents = {
      actual: composeShadowOrder(decomposition.forward, 'A_actual'),
      perfectProgress: composeShadowOrder(decomposition.forward, 'B_perfectProgress'),
      perfectDirection: composeShadowOrder(decomposition.forward, 'C_perfectDirection'),
      perfectBoth: composeShadowOrder(decomposition.forward, 'D_perfectBoth'),
    };

    return {
      letter: letterIdentity.letter,
      index,
      rawInk,
      coverage: letterIdentity.coverage,
      order: letterIdentity.order,
      dtwFit: decomposition.forward.dtwFit,
      progressFit: decomposition.forward.progressFit,
      directionFit: decomposition.forward.directionFit,
      monotonicFit: decomposition.forward.monotonicFit,
      jumpFit: decomposition.forward.jumpFit,
      revisitFit: decomposition.forward.revisitFit,
      letterRoutePointCount: windowInput.letterRoutePointCount,
      letterTargetPointCount: windowInput.letterTargetPointCount,
      letterTargetLengthUnits: windowInput.letterTargetLengthUnits,
      gapCount: windowInput.gapCount,
      maxGapSize: windowInput.maxGapSize,
      routeMinProgress: windowInput.routeMinProgress,
      routeMaxProgress: windowInput.routeMaxProgress,
      targetStartProgress: windowInput.targetStartProgress,
      targetEndProgress: windowInput.targetEndProgress,
      shadowWindows,
      shadowComponents,
    };
  });
}

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  production: LetterInstanceRecord[];
  checkpointV1: LetterInstanceRecord[];
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
  const production = buildLetterInstanceRecords(word, item.target, productionResult.pathPoints, geometryVariant);

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
  const checkpointV1 = buildLetterInstanceRecords(word, item.target, checkpointPathPoints, geometryVariant);

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
    console.log(`[per-letter-order-diagnostic] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[per-letter-order-diagnostic] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'per-letter-order-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), windowVariants: WINDOW_VARIANTS, cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[per-letter-order-diagnostic] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[per-letter-order-diagnostic] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

export { traceDirectionConsistency };
