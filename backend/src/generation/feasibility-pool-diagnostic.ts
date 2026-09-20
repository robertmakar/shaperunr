/**
 * DEVELOPMENT ONLY. Deeper graph-feasibility pool experiment.
 *
 * Does not change the experimental generator, product thresholds,
 * snapping, or graph-search. Locate/graph search only — no Valhalla
 * /route or /trace_route.
 */
import type { Coordinate } from '@/lib/geo';
import type { Vec2 } from '@/lib/geometry';
import { buildWordShape } from '@/lib/word-shape';

import type { GeneratedRoute } from '../types';
import { productRejectionReasons, type ProductRuleName } from './experimental-diagnostics';
import { EXPERIMENTAL_PRODUCT } from './experimental-product';
import { EXPERIMENTAL_PIPELINE } from './graph-constrained-pipeline';
import {
  buildShapeGraph,
  routeGraphConstrainedShape,
  type GraphSegment,
} from './graph-shape';
import {
  collectNeighborhoodShapeGraph,
  shapeKindFromWord,
  type ShapeGraphCollection,
} from './graph-shape-router';
import { discoveryScore, filterCorridorSegments, isFeasible } from './shape-discovery';
import {
  getPlacementRingsForTargetDistance,
  getSearchRadiusForTargetDistance,
} from './search-radius';
import { scorePolylines, shapeScoreBreakdown } from '../scoring/shape-match';
import {
  buildStreetFitPlacements,
  projectWordPlacement,
  rankStreetFitPlacements,
  type StreetFitPlacement,
  type StreetGraphWay,
} from './street-fit-search';

export const FEASIBILITY_POOL_DIAGNOSTIC = {
  currentPool: EXPERIMENTAL_PIPELINE.feasibilityTop,
  poolSizes: [32, 64, 96, 128, 256] as const,
} as const;

export type FeasibilityPoolCandidate = {
  placementId: string;
  streetFitRank: number;
  streetFitScore: number;
  feasible: boolean;
  failureReason: string | null;
  graphCoverage: number;
  largestGap: number;
  headingAgreementDegrees: number;
  forwardProgress: number;
  backtracking: number;
  connected: boolean;
  discoveryScore: number;
  rotationDegrees: number;
  scale: number;
  eastMeters: number;
  northMeters: number;
  pathPoints: Vec2[];
  target: Vec2[];
};

export type ScoredPoolCandidate = FeasibilityPoolCandidate & {
  shapeScore: number | null;
  shapeCoverage: number | null;
  order: number | null;
  wouldPassProduct: boolean;
  productRejections: ProductRuleName[];
  beyondCurrentPool: boolean;
};

export type FeasibilityPoolSlice = {
  poolSize: number;
  evaluated: number;
  graphFeasible: number;
  best: FeasibilityPoolCandidate | null;
};

export type FeasibilityPoolReport = {
  name: string;
  word: string;
  targetDistanceMeters: number;
  searchOrigin: Coordinate;
  currentPool: number;
  placementsRanked: number;
  neighborhoodRadiusMeters: number;
  graphEdges: number;
  slices: FeasibilityPoolSlice[];
  scoredFeasible: ScoredPoolCandidate[];
};

export async function evaluateFeasibilityPools(input: {
  name: string;
  word: string;
  searchOrigin: Coordinate;
  targetDistanceMeters: number;
  collection?: ShapeGraphCollection;
  placements?: StreetFitPlacement[];
  poolSizes?: readonly number[];
  currentPool?: number;
}): Promise<FeasibilityPoolReport> {
  const currentPool = input.currentPool ?? FEASIBILITY_POOL_DIAGNOSTIC.currentPool;
  const poolSizes = [...(input.poolSizes ?? FEASIBILITY_POOL_DIAGNOSTIC.poolSizes)].sort((a, b) => a - b);
  const maxPool = poolSizes[poolSizes.length - 1] ?? currentPool;
  const wordShape = buildWordShape(input.word);
  const kind = shapeKindFromWord(wordShape.word);
  const collection =
    input.collection ??
    (await collectNeighborhoodShapeGraph(input.searchOrigin, {
      radiusMeters: getSearchRadiusForTargetDistance(input.targetDistanceMeters),
    }));
  const placements =
    input.placements ??
    buildStreetFitPlacements({
      translationRingsMeters: getPlacementRingsForTargetDistance(input.targetDistanceMeters),
    });
  const ranked = rankStreetFitPlacements({
    word: wordShape,
    targetDistanceMeters: input.targetDistanceMeters,
    graph: segmentsToWays(collection.segments),
    placements,
  });

  const candidates: FeasibilityPoolCandidate[] = [];
  for (const [streetFitRank, item] of ranked.slice(0, maxPool).entries()) {
    const projected = projectWordPlacement(wordShape, input.targetDistanceMeters, item.placement);
    const corridor = filterCorridorSegments(collection.segments, projected.target);
    const result = routeGraphConstrainedShape({
      target: projected.target,
      kind,
      graph: buildShapeGraph(corridor),
    });
    candidates.push({
      placementId: item.placement.id,
      streetFitRank,
      streetFitScore: item.score,
      feasible: isFeasible(result),
      failureReason: result.failureReason,
      graphCoverage: result.metrics.targetCoverage,
      largestGap: result.metrics.largestTargetProgressGap,
      headingAgreementDegrees: result.metrics.headingAgreementDegrees,
      forwardProgress: result.metrics.forwardProgress,
      backtracking: result.metrics.backtracking,
      connected: result.metrics.connected,
      discoveryScore: discoveryScore(result),
      rotationDegrees: item.placement.rotationDegrees,
      scale: item.placement.scale,
      eastMeters: item.placement.eastMeters,
      northMeters: item.placement.northMeters,
      pathPoints: result.pathPoints,
      target: projected.target,
    });
  }

  const slices = poolSizes.map((poolSize) => {
    const pool = candidates.slice(0, poolSize);
    const feasible = pool.filter((item) => item.feasible);
    return {
      poolSize,
      evaluated: pool.length,
      graphFeasible: feasible.length,
      best: pickBestGraphCandidate(feasible.length > 0 ? feasible : pool),
    };
  });

  const scoredFeasible = candidates.filter((item) => item.feasible).map((item) => scoreFeasibleCandidate(item, currentPool));

  return {
    name: input.name,
    word: wordShape.word,
    targetDistanceMeters: input.targetDistanceMeters,
    searchOrigin: input.searchOrigin,
    currentPool,
    placementsRanked: ranked.length,
    neighborhoodRadiusMeters: getSearchRadiusForTargetDistance(input.targetDistanceMeters),
    graphEdges: collection.segments.length,
    slices,
    scoredFeasible,
  };
}

export function formatFeasibilityPoolReport(report: FeasibilityPoolReport): string {
  const additional = report.scoredFeasible.filter((item) => item.beyondCurrentPool);
  const productValidBeyond = additional.filter((item) => item.wouldPassProduct);
  const productValidAny = report.scoredFeasible.filter((item) => item.wouldPassProduct);
  const lines = [
    `DEVELOPMENT / feasibility-pool diagnostic  (${report.name})`,
    '(graph feasibility + existing shape-match scoring — no Valhalla routing, generator unchanged)',
    `word ${report.word}  target ${report.targetDistanceMeters} m  search origin ${report.searchOrigin.latitude}, ${report.searchOrigin.longitude}`,
    `current generator pool ${report.currentPool}  ranked placements ${report.placementsRanked}  graph edges ${report.graphEdges}  neighborhood ${report.neighborhoodRadiusMeters} m`,
    `product thresholds unchanged: shapeScore>=${EXPERIMENTAL_PRODUCT.minShapeScore} coverage>=${EXPERIMENTAL_PRODUCT.minCoverage} order>=${EXPERIMENTAL_PRODUCT.minOrder} backtrack<=${EXPERIMENTAL_PRODUCT.maxBacktrack} gap<=${EXPERIMENTAL_PRODUCT.maxLargestGap}`,
    '',
  ];
  for (const slice of report.slices) {
    lines.push(
      `pool ${String(slice.poolSize).padStart(3, ' ')}  evaluated ${slice.evaluated}  graph-feasible ${slice.graphFeasible}  best ${formatBest(slice.best)}`,
    );
  }
  lines.push('');
  lines.push(
    `graph-feasible in current top ${report.currentPool}: ${report.scoredFeasible.filter((item) => !item.beyondCurrentPool).length}`,
  );
  lines.push(`additional graph-feasible beyond rank ${report.currentPool}: ${additional.length}`);
  lines.push(`product-valid in current pool: ${productValidAny.filter((item) => !item.beyondCurrentPool).length}`);
  lines.push(`product-valid beyond rank ${report.currentPool}: ${productValidBeyond.length}`);
  if (report.scoredFeasible.length === 0) {
    lines.push('no graph-feasible candidates in the evaluated pools');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('All graph-feasible candidates (shape-match scoring, existing product rules):');
  for (const item of [...report.scoredFeasible].sort(compareScored)) {
    lines.push(
      `  ${item.beyondCurrentPool ? 'beyond' : 'in-pool'} rank ${item.streetFitRank}  ${item.placementId}  rot ${item.rotationDegrees} scale ${item.scale} e ${item.eastMeters} n ${item.northMeters}`,
    );
    lines.push(
      `    graphCov ${pct(item.graphCoverage)} gap ${pct(item.largestGap)} head ${item.headingAgreementDegrees.toFixed(1)}° fwd ${pct(item.forwardProgress)} connected=${item.connected}`,
    );
    lines.push(
      `    shapeScore ${fmt(item.shapeScore)} shapeCov ${fmt(item.shapeCoverage)} order ${fmt(item.order)} product=${item.wouldPassProduct ? 'PASS' : `reject ${item.productRejections.join(',') || 'n/a'}`}`,
    );
  }
  return lines.join('\n');
}

function scoreFeasibleCandidate(item: FeasibilityPoolCandidate, currentPool: number): ScoredPoolCandidate {
  const scored =
    item.pathPoints.length >= 2 ? scorePolylines(item.pathPoints, item.target) : null;
  const breakdown = scored ? shapeScoreBreakdown(scored) : null;
  const route = scored
    ? stubRoute({
        id: item.placementId,
        shapeScore: scored.score,
        coverage: scored.coverage,
        order: breakdown?.order ?? 0,
        backtrack: item.backtracking,
        gap: item.largestGap,
        connected: item.connected,
      })
    : null;
  const productRejections = route ? productRejectionReasons(route) : (['connected'] as ProductRuleName[]);
  return {
    ...item,
    shapeScore: scored?.score ?? null,
    shapeCoverage: scored?.coverage ?? null,
    order: breakdown?.order ?? null,
    wouldPassProduct: Boolean(route) && productRejections.length === 0,
    productRejections,
    beyondCurrentPool: item.streetFitRank >= currentPool,
  };
}

function pickBestGraphCandidate(items: FeasibilityPoolCandidate[]): FeasibilityPoolCandidate | null {
  return [...items].sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      b.discoveryScore - a.discoveryScore ||
      b.graphCoverage - a.graphCoverage,
  )[0] ?? null;
}

function compareScored(a: ScoredPoolCandidate, b: ScoredPoolCandidate): number {
  return (
    Number(b.wouldPassProduct) - Number(a.wouldPassProduct) ||
    (b.shapeScore ?? -1) - (a.shapeScore ?? -1) ||
    a.streetFitRank - b.streetFitRank
  );
}

function stubRoute(partial: {
  id: string;
  shapeScore: number;
  coverage: number;
  order: number;
  backtrack: number;
  gap: number;
  connected: boolean;
}): GeneratedRoute {
  return {
    id: partial.id,
    source: 'valhalla',
    developmentOnly: true,
    coordinates: [
      { latitude: 0, longitude: 0 },
      { latitude: 0.001, longitude: 0 },
    ],
    targetCoordinates: [],
    shapeCoordinates: [
      { latitude: 0, longitude: 0 },
      { latitude: 0.001, longitude: 0 },
    ],
    connectorCoordinates: [],
    distanceMeters: 1000,
    shapeScore: partial.shapeScore,
    coverage: partial.coverage,
    scoreBreakdown: {
      proximity: 0,
      coverage: partial.coverage,
      order: partial.order,
      lengthFit: 0,
      detour: 0,
      backtrack: 0,
      finalScore: partial.shapeScore,
    },
    metadata: {
      rotationDegrees: 0,
      scale: 1,
      placement: 'offset',
      offsetAcrossMeters: 0,
      method: 'graph_constrained',
      connectedFromStart: true,
      connected: partial.connected,
      startSnapDistanceMeters: 0,
      lengthError: 0,
      distanceError: 0,
      detourRatio: 0,
      backtrackRatio: partial.backtrack,
      score: { score: partial.shapeScore } as GeneratedRoute['metadata']['score'],
      largestGap: partial.gap,
    },
  };
}

function segmentsToWays(segments: Array<Omit<GraphSegment, 'from' | 'to'>>): StreetGraphWay[] {
  const byWay = new Map<string, Vec2[]>();
  for (const segment of segments) {
    const list = byWay.get(segment.wayId) ?? [];
    list.push(...segment.points);
    byWay.set(segment.wayId, list);
  }
  return [...byWay.entries()].map(([wayId, points]) => ({ wayId, points }));
}

function formatBest(item: FeasibilityPoolCandidate | null): string {
  if (!item) {
    return 'none';
  }
  return `${item.feasible ? 'PASS' : 'fail'} ${item.placementId} rank=${item.streetFitRank} cov=${pct(item.graphCoverage)} gap=${pct(item.largestGap)} head=${item.headingAgreementDegrees.toFixed(1)}° fwd=${pct(item.forwardProgress)} rot=${item.rotationDegrees} scale=${item.scale} e=${item.eastMeters} n=${item.northMeters}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmt(value: number | null): string {
  return value == null ? 'n/a' : value.toFixed(3);
}
