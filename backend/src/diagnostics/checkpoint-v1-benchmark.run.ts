/**
 * DEVELOPMENT ONLY. Benchmarks the new checkpoint-v1 candidate generator
 * (backend/src/generation/checkpoint-route-generator.ts, NOT wired into
 * any live traffic path) against the CURRENT PRODUCTION generator
 * (routeGraphConstrainedShape, unmodified) on the exact same 78
 * graph-feasible multi-letter candidates and 4 single-letter controls
 * used throughout this session's investigation, in-process, sequential.
 *
 * For every candidate: reconstructs the SAME graph used by production
 * (from FeasibilityRecord.graphLines), runs the real, unmodified
 * production search on that reconstructed graph, runs checkpoint-v1 on
 * the SAME target/graph/placement, scores both with the SAME existing
 * scoring functions, and applies the SAME existing product gate
 * (experimentalProductRejectionReasons) to both.
 *
 * Run with: npx tsx src/diagnostics/checkpoint-v1-benchmark.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';
import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import { CHECKPOINT_V1, generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { experimentalProductRejectionReasons } from '../generation/experimental-product';
import { scorePolylines } from '../scoring/shape-match';
import { analyzeTargetIdentity, type TargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import type { GeneratedRoute } from '../types';

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

type RouteQuality = {
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
};

function scoreRoute(word: string, pathPoints: Vec2[], target: readonly Vec2[], geometryVariant: 'smooth' | 'angular' | 'hybrid'): RouteQuality {
  if (pathPoints.length < 2) {
    return { shapeScore: null, coverage: null, order: null, backtrack: null, targetSpan: 0, distanceRatio: 0, wordTraversal: false, allLettersCoveredAndOrdered: false, rawInkCoverageMean: 0, perLetterRawInk: [] };
  }
  const identity: TargetIdentity = analyzeTargetIdentity({ route: pathPoints, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const inkResult = computeInkOnlyOccupancy({ route: pathPoints, target, boundarySet, letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited) });
  const scored = scorePolylines(pathPoints, target);
  const perLetterRawInk = inkResult.perLetterOccupancy.map((l) => l.occupancy);
  const rawInkMean = perLetterRawInk.length ? perLetterRawInk.reduce((s, v) => s + v, 0) / perLetterRawInk.length : 0;
  const allLettersCoveredAndOrdered = identity.letters.every((l) => l.meaningfullyVisited) && identity.lettersVisitedInOrder;
  const routeLength = polylineLengthLocal(pathPoints);
  const targetLength = polylineLengthLocal(target);
  return {
    shapeScore: scored.score,
    coverage: scored.coverage,
    order: scored.breakdown.order,
    backtrack: scored.details.backtrackRatio,
    targetSpan: identity.targetSpan,
    distanceRatio: targetLength > 0 ? routeLength / targetLength : 0,
    wordTraversal: identity.traversesMostOfWord,
    allLettersCoveredAndOrdered,
    rawInkCoverageMean: rawInkMean,
    perLetterRawInk,
  };
}
function polylineLengthLocal(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

type GeneratorOutcome = {
  routeQuality: RouteQuality;
  passesProductGate: boolean;
  productGateRejectionReasons: string[];
};

type CheckpointOutcome = GeneratorOutcome & {
  checkpointsAttempted: number;
  candidateCount: number;
  fullyConnectedBest: boolean;
  connectedSegmentCount: number;
  totalSegmentCount: number;
  generationRuntimeMs: number;
  acceptedCandidateCount: number;
};

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  production: GeneratorOutcome;
  checkpointV1: CheckpointOutcome;
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

  // --- Production (unmodified, on the SAME reconstructed graph) ---
  const productionResult = routeGraphConstrainedShape({ target: item.target, kind, graph, multiLetter });
  const productionQuality = scoreRoute(word, productionResult.pathPoints, item.target, geometryVariant);
  const productionRoute = buildGeneratedRouteForGate(word, productionResult.pathPoints, item.target, geometryVariant, productionResult.metrics.connected);
  const productionRejections = productionRoute ? experimentalProductRejectionReasons(productionRoute, { word }) : ['no_route'];

  // --- Checkpoint-v1 (new module, NOT wired into production) ---
  const started = performance.now();
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
  const runtimeMs = performance.now() - started;
  const best = checkpointResult.candidates[0] ?? null;
  const checkpointQuality = best ? scoreRoute(word, localPathFromRoute(best.route, start), item.target, geometryVariant) : scoreRoute(word, [], item.target, geometryVariant);
  const acceptedCandidateCount = checkpointResult.candidates.filter((c) => c.passesProductGate).length;

  return {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    production: { routeQuality: productionQuality, passesProductGate: productionRejections.length === 0, productGateRejectionReasons: productionRejections },
    checkpointV1: {
      routeQuality: checkpointQuality,
      passesProductGate: best?.passesProductGate ?? false,
      productGateRejectionReasons: best?.productGateRejectionReasons ?? ['no_candidates'],
      checkpointsAttempted: checkpointResult.checkpointsAttempted,
      candidateCount: checkpointResult.candidates.length,
      fullyConnectedBest: best?.fullyConnected ?? false,
      connectedSegmentCount: best?.connectedSegmentCount ?? 0,
      totalSegmentCount: best?.totalSegmentCount ?? 0,
      generationRuntimeMs: runtimeMs,
      acceptedCandidateCount,
    },
  };
}

/** Rebuilds production's own route into the SAME GeneratedRoute shape checkpoint-v1 candidates use, purely so the SAME experimentalProductRejectionReasons() gate can be applied to both — mirrors runExperimentalPipeline's own route construction (scorePolylines + local->geo via an arbitrary consistent anchor; the product gate only reads relative geometry). */
function buildGeneratedRouteForGate(word: string, pathPoints: Vec2[], target: readonly Vec2[], geometryVariant: 'smooth' | 'angular' | 'hybrid', connected: boolean): GeneratedRoute | null {
  if (pathPoints.length < 2) return null;
  const anchor = { latitude: 30.0, longitude: 31.0 };
  const toGeo = (p: Vec2) => ({ latitude: anchor.latitude + p.y / 111320, longitude: anchor.longitude + p.x / (111320 * Math.cos((anchor.latitude * Math.PI) / 180)) });
  const shapeGeo = pathPoints.map(toGeo);
  const targetGeo = target.map(toGeo);
  const scored = scorePolylines(pathPoints, target);
  const identity = analyzeTargetIdentity({ route: pathPoints, target, word, geometryVariant });
  const routeDistanceMeters = polylineLengthLocal(pathPoints);
  return {
    id: 'production-gate-check',
    source: 'valhalla',
    developmentOnly: true,
    coordinates: shapeGeo,
    targetCoordinates: targetGeo,
    shapeCoordinates: shapeGeo,
    connectorCoordinates: [],
    distanceMeters: routeDistanceMeters,
    shapeScore: scored.score,
    coverage: scored.coverage,
    scoreBreakdown: scored.breakdown,
    metadata: {
      rotationDegrees: 0,
      scale: 1,
      placement: 'start-anchored',
      offsetAcrossMeters: 0,
      method: 'graph_constrained',
      connectedFromStart: connected,
      connected,
      backtrackRatio: scored.details.backtrackRatio,
      score: scored,
      startSnapDistanceMeters: 0,
      lengthError: 0,
      distanceError: 0,
      detourRatio: 0,
      largestGap: identity.largestTargetGap,
      shapeRouteDistanceMeters: routeDistanceMeters,
      totalDistanceMeters: routeDistanceMeters,
      geometryVariant,
    },
  };
}

/** Reconstructs the checkpoint-v1 route's own local-meter pathPoints from its geo coordinates, using the EXACT SAME origin (`searchOrigin`) that generateCheckpointRoutes used to build them — must match, since the geo conversion is only a valid round-trip relative to the same anchor. */
function localPathFromRoute(route: GeneratedRoute, origin: Coordinate): Vec2[] {
  const shape = route.shapeCoordinates ?? route.coordinates;
  return coordinatesToLocalMeters(origin, shape);
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
    console.log(`[checkpoint-v1-benchmark] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[checkpoint-v1-benchmark] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'checkpoint-v1-benchmark-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), config: CHECKPOINT_V1, cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[checkpoint-v1-benchmark] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[checkpoint-v1-benchmark] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
