/**
 * DEVELOPMENT ONLY. Runs the checkpoint-anchored graph routing feasibility
 * experiment (see checkpoint-route-experiment.ts) at C8/C12/C16 against
 * the same real 8-config multi-letter corpus used throughout this
 * investigation, plus the same single-letter controls (L, I, O, R),
 * in-process, sequential.
 *
 * For every candidate: reconstructs the SAME graph used by the current
 * production beam (from FeasibilityRecord.graphLines), runs the real,
 * unmodified production search on that reconstructed graph as the
 * comparison baseline (per this session's established lesson: compare
 * against production run on the reconstructed graph, not the original
 * FeasibilityRecord.result, to avoid false "parity failure" from the
 * reconstruction's own geometric node-snapping), then runs the checkpoint
 * experiment at each of C8/C12/C16 and scores the assembled route with
 * the SAME, unmodified downstream scoring functions.
 *
 * Run with: npx tsx src/diagnostics/checkpoint-route-experiment.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';

import { CHECKPOINT_VARIANTS, traceCheckpointRoute, type CheckpointRouteTrace, type CheckpointVariantKey } from './checkpoint-route-experiment';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { scorePolylines } from '../scoring/shape-match';
import { analyzeTargetIdentity, type TargetIdentity } from '../generation/target-identity';
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

const SINGLE_LETTER_CASES: Array<{ word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number }> = [
  { word: 'L', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'I', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'O', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'R', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
];

const VARIANT_KEYS = Object.keys(CHECKPOINT_VARIANTS) as CheckpointVariantKey[];
/** "No graph node within range" threshold for snap-quality reporting — reuses the existing GRAPH_SHAPE.corridorMeters constant (the same 70m corridor radius production already uses to decide which street segments are even eligible), rather than inventing a new number. */
const SNAP_IN_RANGE_METERS = GRAPH_SHAPE.corridorMeters;

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
  return {
    shapeScore: scored.score,
    coverage: scored.coverage,
    order: scored.breakdown.order,
    backtrack: scored.details.backtrackRatio,
    targetSpan: identity.targetSpan,
    distanceRatio: pathPointsRatio(pathPoints, target),
    wordTraversal: identity.traversesMostOfWord,
    allLettersCoveredAndOrdered,
    rawInkCoverageMean: rawInkMean,
    perLetterRawInk,
  };
}

function pathPointsRatio(pathPoints: readonly Vec2[], target: readonly Vec2[]): number {
  const routeLength = polylineLengthLocal(pathPoints);
  const targetLength = polylineLengthLocal(target);
  return targetLength > 0 ? routeLength / targetLength : 0;
}
function polylineLengthLocal(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

type SnapQuality = {
  meanDistanceMeters: number;
  medianDistanceMeters: number;
  maxDistanceMeters: number;
  checkpointsWithNoNodeInRange: number;
};

function summarizeSnapQuality(trace: CheckpointRouteTrace): SnapQuality {
  const distances = trace.snaps.map((s) => s.nearestDistanceMeters).filter((d) => Number.isFinite(d));
  const sorted = [...distances].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const max = sorted.length ? sorted[sorted.length - 1]! : 0;
  const outOfRange = trace.snaps.filter((s) => !(s.nearestDistanceMeters <= SNAP_IN_RANGE_METERS)).length;
  return { meanDistanceMeters: mean, medianDistanceMeters: median, maxDistanceMeters: max, checkpointsWithNoNodeInRange: outOfRange };
}

type SegmentGeometry = {
  meanPerpendicularDistanceMeters: number;
  maxPerpendicularDistanceMeters: number;
  meanHeadingAgreement: number;
  routeTargetRatio: number;
};

function summarizeSegmentGeometry(trace: CheckpointRouteTrace): SegmentGeometry {
  const segments = trace.best?.segments.filter((s) => s.connected) ?? [];
  if (segments.length === 0) return { meanPerpendicularDistanceMeters: 0, maxPerpendicularDistanceMeters: 0, meanHeadingAgreement: 0, routeTargetRatio: 0 };
  const meanPerp = segments.reduce((s, seg) => s + seg.meanPerpendicularDistanceMeters, 0) / segments.length;
  const maxPerp = Math.max(...segments.map((seg) => seg.maxPerpendicularDistanceMeters));
  const meanHeading = segments.reduce((s, seg) => s + seg.headingAgreement, 0) / segments.length;
  const totalRoute = segments.reduce((s, seg) => s + seg.routeDistanceMeters, 0);
  const totalStraight = segments.reduce((s, seg) => s + seg.straightTargetDistanceMeters, 0);
  return { meanPerpendicularDistanceMeters: meanPerp, maxPerpendicularDistanceMeters: maxPerp, meanHeadingAgreement: meanHeading, routeTargetRatio: totalStraight > 0 ? totalRoute / totalStraight : 0 };
}

type CheckpointVariantReport = {
  fullyConnected: boolean;
  connectedSegmentCount: number;
  totalSegmentCount: number;
  snapQuality: SnapQuality;
  segmentGeometry: SegmentGeometry;
  routeQuality: RouteQuality;
};

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  production: RouteQuality;
  checkpointVariants: Record<CheckpointVariantKey, CheckpointVariantReport>;
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateReport[];
};

function analyzeCandidate(word: string, item: FeasibilityRecord): CandidateReport | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) return null;
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const graph = reconstructGraph(item.graphLines);
  const kind = shapeKindFromWord(word);
  const multiLetter = word.length > 1;
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));

  const productionOnReconstructed = routeGraphConstrainedShape({ target: item.target, kind, graph, multiLetter });
  const production = scoreRoute(word, productionOnReconstructed.pathPoints, item.target, geometryVariant);

  const checkpointVariants = {} as Record<CheckpointVariantKey, CheckpointVariantReport>;
  for (const variantKey of VARIANT_KEYS) {
    const trace = traceCheckpointRoute({ word, target: item.target, graph, kind, multiLetter, boundaries: boundarySet.boundaries }, CHECKPOINT_VARIANTS[variantKey]);
    const routeQuality = scoreRoute(word, trace.pathPoints, item.target, geometryVariant);
    checkpointVariants[variantKey] = {
      fullyConnected: trace.fullyConnected,
      connectedSegmentCount: trace.connectedSegmentCount,
      totalSegmentCount: trace.totalSegmentCount,
      snapQuality: summarizeSnapQuality(trace),
      segmentGeometry: summarizeSegmentGeometry(trace),
      routeQuality,
    };
  }

  return { candidateRank: item.variantRank ?? -1, geometryVariant, production, checkpointVariants };
}

async function runCase(testCase: (typeof MULTI_LETTER_CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const candidates = feasible
    .map((item) => analyzeCandidate(testCase.word, item))
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
  const multiLetterCases: CaseReport[] = [];
  for (const testCase of MULTI_LETTER_CASES) {
    console.log(`[checkpoint-route] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    multiLetterCases.push(result);
    console.log(`[checkpoint-route] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  const singleLetterCases: CaseReport[] = [];
  for (const testCase of SINGLE_LETTER_CASES) {
    console.log(`[checkpoint-route] running single-letter control ${testCase.word}...`);
    const result = await runCase(testCase);
    singleLetterCases.push(result);
    console.log(`[checkpoint-route] done ${testCase.word} -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'checkpoint-route-experiment-results.json');
  writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), variants: CHECKPOINT_VARIANTS, multiLetterCases, singleLetterCases }, null, 2),
    'utf8',
  );

  console.log('');
  console.log(`[checkpoint-route] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[checkpoint-route] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
