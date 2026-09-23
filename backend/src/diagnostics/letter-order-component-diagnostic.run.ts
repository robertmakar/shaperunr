/**
 * DEVELOPMENT ONLY. Runs the filtered-heading / jumpAllow / revisit
 * follow-up diagnostic (see letter-order-component-diagnostic.ts) against
 * the exact real 78-candidate multi-letter corpus, for checkpoint-v1's
 * route on every candidate (production's route too, for the forensic
 * comparison tables).
 *
 * Persists, per letter: real order components, gap statistics (from the
 * filtered-array heading construction), the real-segment (adjacency-safe)
 * direction shadow, and jumpAllow/revisit-threshold shadow component
 * values across every tested variant — combined-variant recombination and
 * "best variant" selection happen in the aggregate analysis pass, not
 * here, so no variant is prejudged as "best" ahead of the actual numbers.
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate; never touches dedupeRoutes/dedupeMeters.
 *
 * Run with: npx tsx src/diagnostics/letter-order-component-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import {
  auditFilteredHeadingSegments,
  computeRealSegmentDirectionFit,
  progressConsistencyShadow,
  extractLetterOrderInputs,
  computeLetterOrderDecomposition,
  JUMP_ALLOW_VARIANTS,
  REVISIT_THRESHOLD_VARIANTS,
} from './letter-order-component-diagnostic';
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

const JUMP_KEYS = Object.keys(JUMP_ALLOW_VARIANTS);
const REVISIT_KEYS = Object.keys(REVISIT_THRESHOLD_VARIANTS);

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type LetterComponentRecord = {
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
  gapSegmentCount: number;
  totalSegmentCount: number;
  meanGap: number;
  maxGap: number;
  realSegmentDirectionFit: number;
  realSegmentCount: number;
  jumpAllowVariants: Record<string, number>;
  revisitVariants: Record<string, number>;
};

function buildLetterComponentRecords(word: string, target: readonly Vec2[], route: Vec2[], geometryVariant: 'smooth' | 'angular' | 'hybrid'): LetterComponentRecord[] {
  if (route.length < 2) return [];
  const identity = analyzeTargetIdentity({ route, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const ink = computeInkOnlyOccupancy({ route, target, boundarySet, letterMeaningfullyVisited: identity.letters.map((l) => l.meaningfullyVisited) });
  const orderInputs = extractLetterOrderInputs(word, target, route, geometryVariant);
  const decompositions = orderInputs.map(computeLetterOrderDecomposition);
  const auditedSegments = auditFilteredHeadingSegments(word, target, route, geometryVariant);

  return identity.letters.map((letterIdentity, index) => {
    const decomposition = decompositions[index]!;
    const input = orderInputs[index]!;
    const rawInk = ink.perLetterOccupancy[index]?.occupancy ?? 0;
    const segments = auditedSegments[index] ?? [];
    const gapSegments = segments.filter((s) => s.originalIndexGap > 1);
    const gaps = segments.map((s) => s.originalIndexGap);

    const realSegment = computeRealSegmentDirectionFit(word, target, route, geometryVariant, index);

    const jumpAllowVariants: Record<string, number> = {};
    for (const key of JUMP_KEYS) {
      const numerator = JUMP_ALLOW_VARIANTS[key]!;
      const shadow = input.letterRoute.length >= 2 ? progressConsistencyShadow(input.letterRoute, input.letterTarget, numerator, 0.12) : { jumpFit: 0 };
      jumpAllowVariants[key] = shadow.jumpFit;
    }
    const revisitVariants: Record<string, number> = {};
    for (const key of REVISIT_KEYS) {
      const threshold = REVISIT_THRESHOLD_VARIANTS[key]!;
      const shadow = input.letterRoute.length >= 2 ? progressConsistencyShadow(input.letterRoute, input.letterTarget, 4, threshold) : { revisitFit: 0 };
      revisitVariants[key] = shadow.revisitFit;
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
      gapSegmentCount: gapSegments.length,
      totalSegmentCount: segments.length,
      meanGap: gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0,
      maxGap: gaps.length ? Math.max(...gaps) : 0,
      realSegmentDirectionFit: realSegment.directionFit,
      realSegmentCount: realSegment.segmentCount,
      jumpAllowVariants,
      revisitVariants,
    };
  });
}

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  production: LetterComponentRecord[];
  checkpointV1: LetterComponentRecord[];
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
  const production = buildLetterComponentRecords(word, item.target, productionResult.pathPoints, geometryVariant);

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
  const checkpointV1 = buildLetterComponentRecords(word, item.target, checkpointPathPoints, geometryVariant);

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
    console.log(`[letter-order-component-diagnostic] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[letter-order-component-diagnostic] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'letter-order-component-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), jumpAllowVariants: JUMP_ALLOW_VARIANTS, revisitThresholdVariants: REVISIT_THRESHOLD_VARIANTS, cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[letter-order-component-diagnostic] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[letter-order-component-diagnostic] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
