/**
 * DEVELOPMENT ONLY. End-to-end experimental pipeline.
 *
 * placements → graph-constrained feasibility → route only viable
 * candidates → existing shape-match scoring → top 3.
 *
 * Does not change the graph-search scoring algorithm.
 * Shape scoring excludes the start connector.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';
import { resamplePolyline, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';
import {
  coordinatesToLocalMeters,
  distanceMeters,
  offsetCoordinate,
  polylineLengthMeters,
} from '@/lib/shape-projection';
import { buildWalkableWordShape } from './walkable-target';

import { config } from '../config';
import { summarizeNumbers, type NumberDistribution } from '../diagnostics/stats';
import { routePedestrianLeg, ValhallaRequestError } from '../routing/valhalla';
import { scorePolylines, shapeScoreBreakdown } from '../scoring/shape-match';
import type { GeneratedRoute, GenerateRoutesResponse, RouteFailure } from '../types';
import {
  buildShapeGraph,
  routeGraphConstrainedShape,
  type GraphSegment,
  type GraphShapeResult,
} from './graph-shape';
import {
  collectNeighborhoodShapeGraph,
  shapeKindFromWord,
  startConnector,
  type ShapeGraphCollection,
} from './graph-shape-router';
import { discoveryScore, filterCorridorSegments, isFeasible } from './shape-discovery';
import {
  getPlacementRadiusForTargetDistance,
  getPlacementRingsForTargetDistance,
  getSearchRadiusForTargetDistance,
} from './search-radius';
import {
  connectorEndpoints,
  identitySearchOrigin,
  originalLocation,
  placementDistanceFromUser,
  searchOriginFromSnap,
  snapSearchOrigin,
  type SearchOriginSnap,
} from './snap-search-origin';
import {
  buildStreetFitPlacements,
  projectWordPlacement,
  rankStreetFitPlacements,
  STREET_FIT_SEARCH,
  type StreetFitPlacement,
  type StreetFitPlacementResult,
  type StreetGraphWay,
} from './street-fit-search';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

export const EXPERIMENTAL_PIPELINE = {
  /** Street-fit prefilter sent to graph feasibility. 96 covers Alexandria L product-valid ranks 57–91. */
  feasibilityTop: 96,
  routeTop: 6,
  returnCount: 3,
  dedupeMeters: 80,
  minRotationSpreadDegrees: 22.5,
  minOffsetSpreadMeters: 180,
  strongShapeScore: 0.72,
  acceptableShapeScore: 0.58,
} as const;

export type PipelineStatus = 'ok' | 'weak_candidates' | 'no_viable_shape';
export type RouteQuality = 'excellent' | 'acceptable' | 'weak';

export type FeasibilityRecord = {
  placementId: string;
  rotationDegrees: number;
  scale: number;
  eastMeters: number;
  northMeters: number;
  streetFitScore: number;
  feasible: boolean;
  discoveryScore: number;
  coverage: number;
  headingAgreementDegrees: number;
  forwardProgress: number;
  backtracking: number;
  largestGap: number;
  meanPerpendicularError: number;
  connected: boolean;
  failureReason: string | null;
  shapeRouteMeters: number;
  target: Vec2[];
  pathPoints: Vec2[];
  graphLines: Vec2[][];
  result: GraphShapeResult;
  /** Which letter geometry this candidate was built from. Always present when produced by the shared-budget path (see runSharedBudgetGeometryPipeline); undefined on a plain single-variant report, where report.diagnostics.geometryVariant already names the one variant every candidate used. */
  geometryVariant?: LetterShapeVariant;
  /** This candidate's own rank (0-based) within its variant's independent 1360-placement street-fit ranking, before any cross-variant combining — lets diagnostics show whether a candidate earned its place in a shared pool on its own merits. Only meaningful alongside geometryVariant. */
  variantRank?: number;
};

export type RoutingStageAttempt = {
  placementId: string;
  streetFitRank: number;
  feasibilityPoolIndex: number;
  rotationDegrees: number;
  scale: number;
  eastMeters: number;
  northMeters: number;
  distanceFromUserMeters: number;
  graphCoverage: number;
  largestGap: number;
  connected: boolean;
  pathPointCount: number;
  firstLocal: Vec2 | null;
  lastLocal: Vec2 | null;
  firstGeo: Coordinate | null;
  lastGeo: Coordinate | null;
  selectedForRouting: boolean;
  excludedBeforeRoutingReason: string | null;
  shapeMethod: 'graph_constrained';
  connectorAttempted: boolean;
  connectorSkipReason: string | null;
  connectorValhalla: {
    path: string;
    from: Coordinate;
    to: Coordinate;
    httpStatus: number | null;
    ok: boolean;
    error: string | null;
    pointCount: number;
    usedStraightFallback: boolean;
  } | null;
  shapeScore: number | null;
  shapeMatchCoverage: number | null;
  quality: RouteQuality | null;
  excludedFromRoutedReason: string | null;
  /** See FeasibilityRecord.geometryVariant. */
  geometryVariant?: LetterShapeVariant;
};

/**
 * Lightweight, aggregate-only view of the 1360-placement street-fit funnel —
 * deliberately no per-placement objects, only distributions, so history
 * records stay small. See docs/audit notes: this exists to measure whether
 * `feasibilityTop` silently discards graph-feasible placements, not to
 * change which ones are searched.
 */
export type StreetFitFunnelDiagnostics = {
  totalPlacements: number;
  feasibilityTop: number;
  allScores: NumberDistribution;
  top96Scores: NumberDistribution;
  graphFeasibleCount: number;
  graphRejectedCount: number;
  /** Street-fit rank (0-based index into the full ranked pool) of the graph-feasible candidates only. */
  feasibleStreetFitRank: NumberDistribution;
};

/** Aggregate graph-search metrics across a set of feasibility-pool candidates (feasible or rejected). */
export type GraphSearchMetricStats = {
  count: number;
  targetCoverage: NumberDistribution;
  headingAgreementDegrees: NumberDistribution;
  forwardProgress: NumberDistribution;
  backtracking: NumberDistribution;
  routeDistanceMeters: NumberDistribution;
  discoveryScore: NumberDistribution;
  streetFitScore: NumberDistribution;
  streetFitRank: NumberDistribution;
};

/** One routed candidate's length breakdown, captured regardless of whether it later passed classifyQuality. */
export type RouteLengthSample = {
  placementId: string;
  targetDistanceMeters: number;
  shapeRouteMeters: number;
  connectorDistanceMeters: number;
  totalDistanceMeters: number;
  shapeRouteRatio: number;
  totalRatio: number;
  quality: RouteQuality;
  usedStraightFallback: boolean;
  /** See FeasibilityRecord.geometryVariant. */
  geometryVariant?: LetterShapeVariant;
};

/**
 * How the shared feasibility budget (EXPERIMENTAL_PIPELINE.feasibilityTop,
 * unchanged) was allocated across requested geometry variants — see
 * runSharedBudgetGeometryPipeline. Present only when 2+ variants were
 * requested; a plain single-variant report has no shared pool to describe.
 */
export type SharedCandidatePoolDiagnostics = {
  /** How many of the full 1360-placement pool each variant independently ranked. */
  candidatesGeneratedByVariant: Partial<Record<LetterShapeVariant, number>>;
  /** Sum of candidatesGeneratedByVariant — every variant's full ranked pool, before combining. */
  combinedCandidateCount: number;
  /** EXPERIMENTAL_PIPELINE.feasibilityTop — the one shared cut applied to the combined pool, same number as the smooth-only baseline. */
  sharedFeasibilityTop: number;
  /** How many of the shared top-N slots each variant actually won on street-fit score. */
  sharedTop96CountByVariant: Partial<Record<LetterShapeVariant, number>>;
  /** Distribution of each variant's own pre-combine rank (variantRank) among the candidates that made the shared top-N — low values mean that variant's winners were already near the top of its own ranking; high values mean weaker-ranked candidates still made the cut because the other variant had fewer strong candidates. */
  sharedTop96VariantRanks: Partial<Record<LetterShapeVariant, NumberDistribution>>;
};

export type ExperimentalPipelineReport = GenerateRoutesResponse & {
  status: PipelineStatus;
  message: string;
  suggestions: string[];
  textReport: string;
  svg: string;
  diagnostics: {
    placementsEvaluated: number;
    graphFeasible: number;
    placementsRejected: number;
    placementsRouted: number;
    graphEdgesExamined: number;
    searchStates: number;
    valhallaLocateCalls: number;
    valhallaRouteCalls: number;
    valhallaTraceRouteCalls: number;
    neighborhoodRadiusMeters: number;
    placementRadiusMeters: number;
    feasibility: FeasibilityRecord[];
    routingAttempts: RoutingStageAttempt[];
    successPlacementRank: {
      placementId: string;
      streetFitRank: number;
      inFeasibilityTop96: boolean;
      graphFeasible: boolean | null;
    };
    searchOriginSnap: SearchOriginSnap;
    /** Node count of the collected neighborhood graph (not the per-placement corridor graph) — instrumentation-only, computed once. */
    graphNodeCount: number;
    streetFitFunnel: StreetFitFunnelDiagnostics;
    graphSearchStats: {
      feasible: GraphSearchMetricStats;
      rejected: GraphSearchMetricStats;
    };
    /** One entry per candidate that reached the routing stage (the `toRoute` set), including ones later dropped as "weak" — captured for length-ratio analysis, not used by route selection. */
    routeLengthSamples: RouteLengthSample[];
    /** Which letter geometry this report was built with — every candidate/route in this report used this one variant (see runExperimentalPipelineMultiVariant for combining several). */
    geometryVariant: LetterShapeVariant;
    /** Size of the pre-routing diverse-feasible pool (pickDiverse output) — exposed so a multi-variant merge can reproduce pipelineStatus's no_viable_shape/weak_candidates distinction without recomputing it from scratch. */
    viableCount: number;
    /** Present only on a single-variant-per-key merge (see runExperimentalPipelineMultiVariant's 1-variant path) — each requested variant's own complete, independent single-variant report. Absent on a shared-budget report (see sharedCandidatePool instead), since a shared budget has no separate per-variant sub-report by construction. */
    byGeometryVariant?: Partial<Record<LetterShapeVariant, ExperimentalPipelineReport>>;
    /** Present only on a shared-budget multi-variant report (see runSharedBudgetGeometryPipeline). */
    sharedCandidatePool?: SharedCandidatePoolDiagnostics;
  };
};

export type PipelineOptions = {
  collection?: ShapeGraphCollection;
  placements?: StreetFitPlacement[];
  connectStart?: boolean;
  searchOriginSnap?: SearchOriginSnap;
  /** Which letter geometry to build the target shape from. Defaults to 'smooth' — the original geometry — so existing callers are unaffected. */
  geometryVariant?: LetterShapeVariant;
};

export async function runExperimentalPipeline(
  input: {
    word: string;
    start: Coordinate;
    targetDistanceMeters: number;
  },
  options: PipelineOptions = {},
): Promise<ExperimentalPipelineReport> {
  const started = Date.now();
  const geometryVariant = options.geometryVariant ?? 'smooth';
  const wordShape = buildWalkableWordShape(input.word, { letterVariant: geometryVariant });
  const kind = shapeKindFromWord(wordShape.word);
  const userLocation = input.start;
  const originSnap =
    options.searchOriginSnap ??
    (options.collection ? identitySearchOrigin(userLocation) : await snapSearchOrigin(userLocation));
  const searchOrigin = searchOriginFromSnap(originSnap);
  const collection =
    options.collection ??
    (await collectNeighborhoodShapeGraph(searchOrigin, {
      radiusMeters: getSearchRadiusForTargetDistance(input.targetDistanceMeters),
    }));
  const ways = segmentsToWays(collection.segments);
  const placements =
    options.placements ??
    buildStreetFitPlacements({
      translationRingsMeters: getPlacementRingsForTargetDistance(input.targetDistanceMeters),
    });
  const ranked = rankStreetFitPlacements({
    word: wordShape,
    targetDistanceMeters: input.targetDistanceMeters,
    graph: ways,
    placements,
  });

  const feasibilityPool = ranked.slice(0, EXPERIMENTAL_PIPELINE.feasibilityTop);
  const feasibility: FeasibilityRecord[] = [];
  let searchStates = 0;
  for (const item of feasibilityPool) {
    const projected = projectWordPlacement(wordShape, input.targetDistanceMeters, item.placement);
    const corridor = filterCorridorSegments(collection.segments, projected.target);
    const result = routeGraphConstrainedShape({
      target: projected.target,
      kind,
      graph: buildShapeGraph(corridor),
      multiLetter: wordShape.word.length > 1,
    });
    searchStates += result.search.statesExplored;
    feasibility.push({
      placementId: item.placement.id,
      rotationDegrees: item.placement.rotationDegrees,
      scale: item.placement.scale,
      eastMeters: item.placement.eastMeters,
      northMeters: item.placement.northMeters,
      streetFitScore: item.score,
      feasible: isFeasible(result),
      discoveryScore: discoveryScore(result),
      coverage: result.metrics.targetCoverage,
      headingAgreementDegrees: result.metrics.headingAgreementDegrees,
      forwardProgress: result.metrics.forwardProgress,
      backtracking: result.metrics.backtracking,
      largestGap: result.metrics.largestTargetProgressGap,
      meanPerpendicularError: result.metrics.meanPerpendicularError,
      connected: result.metrics.connected,
      failureReason: result.failureReason,
      shapeRouteMeters: result.metrics.routeDistanceMeters,
      target: projected.target,
      pathPoints: result.pathPoints,
      graphLines: corridor.map((segment) => segment.points),
      result,
      geometryVariant,
    });
  }

  const COMPARE_PLACEMENT_ID = 'sf-r315-s0.6-e565.7-n565.7';
  const streetFitRankById = new Map(ranked.map((item, index) => [item.placement.id, index]));
  const feasible = feasibility.filter((item) => item.feasible);
  const viable = pickDiverse(feasible.filter((item) => item.pathPoints.length >= 2));
  const toRoute = viable.slice(0, EXPERIMENTAL_PIPELINE.routeTop);
  const viableIds = new Set(viable.map((item) => item.placementId));
  const toRouteIds = new Set(toRoute.map((item) => item.placementId));

  // Diagnostics-only: the street-fit funnel (1360 → top 96 → graph-feasible)
  // and per-pool graph-search metric distributions. Reads already-computed
  // local data (`ranked`, `feasibilityPool`, `feasibility`, `streetFitRankById`)
  // and never influences which placements are searched or returned.
  const streetFitFunnel: StreetFitFunnelDiagnostics = {
    totalPlacements: ranked.length,
    feasibilityTop: EXPERIMENTAL_PIPELINE.feasibilityTop,
    allScores: summarizeNumbers(ranked.map((item) => item.score)),
    top96Scores: summarizeNumbers(feasibilityPool.map((item) => item.score)),
    graphFeasibleCount: feasible.length,
    graphRejectedCount: feasibility.length - feasible.length,
    feasibleStreetFitRank: summarizeNumbers(
      feasible
        .map((item) => streetFitRankById.get(item.placementId))
        .filter((rank): rank is number => rank != null),
    ),
  };
  const graphSearchStats = {
    feasible: buildGraphSearchMetricStats(feasible, streetFitRankById),
    rejected: buildGraphSearchMetricStats(
      feasibility.filter((item) => !item.feasible),
      streetFitRankById,
    ),
  };
  const graphNodeCount = Object.keys(buildShapeGraph(collection.segments).nodes).length;

  const routingAttempts: RoutingStageAttempt[] = feasible.map((item) => {
    const scored = item.pathPoints.length >= 2 ? scorePolylines(item.pathPoints, item.target) : null;
    const quality = scored ? classifyQuality(item, scored.score, input.targetDistanceMeters) : 'weak';
    let excludedBeforeRoutingReason: string | null = null;
    if (item.pathPoints.length < 2) {
      excludedBeforeRoutingReason = 'pathPoints < 2';
    } else if (!viableIds.has(item.placementId)) {
      excludedBeforeRoutingReason = 'dropped_by_pickDiverse_as_similar';
    } else if (!toRouteIds.has(item.placementId)) {
      excludedBeforeRoutingReason = 'beyond_routeTop';
    }
    const firstLocal = item.pathPoints[0] ?? null;
    const lastLocal = item.pathPoints[item.pathPoints.length - 1] ?? null;
    return {
      placementId: item.placementId,
      streetFitRank: streetFitRankById.get(item.placementId) ?? -1,
      feasibilityPoolIndex: feasibility.findIndex((row) => row.placementId === item.placementId),
      rotationDegrees: item.rotationDegrees,
      scale: item.scale,
      eastMeters: item.eastMeters,
      northMeters: item.northMeters,
      distanceFromUserMeters: Math.round(
        placementDistanceFromUser(userLocation, searchOrigin, item.eastMeters, item.northMeters),
      ),
      graphCoverage: item.coverage,
      largestGap: item.largestGap,
      connected: item.connected,
      pathPointCount: item.pathPoints.length,
      firstLocal,
      lastLocal,
      firstGeo: firstLocal ? offsetCoordinate(searchOrigin, firstLocal.x, firstLocal.y) : null,
      lastGeo: lastLocal ? offsetCoordinate(searchOrigin, lastLocal.x, lastLocal.y) : null,
      selectedForRouting: toRouteIds.has(item.placementId),
      excludedBeforeRoutingReason,
      shapeMethod: 'graph_constrained',
      connectorAttempted: false,
      connectorSkipReason: toRouteIds.has(item.placementId) ? null : 'not_selected_for_routing',
      connectorValhalla: null,
      shapeScore: scored?.score ?? null,
      shapeMatchCoverage: scored?.coverage ?? null,
      quality,
      excludedFromRoutedReason:
        toRouteIds.has(item.placementId) && quality === 'weak'
          ? `pipeline_quality: shapeScore ${scored?.score.toFixed(4) ?? 'n/a'} < ${EXPERIMENTAL_PIPELINE.acceptableShapeScore}`
          : excludedBeforeRoutingReason,
      geometryVariant,
    };
  });
  const attemptById = new Map(routingAttempts.map((item) => [item.placementId, item]));

  let valhallaRouteCalls = 0;
  const routed: GeneratedRoute[] = [];
  const failures: RouteFailure[] = [];
  const routeLengthSamples: RouteLengthSample[] = [];
  const connectStart = options.connectStart ?? true;

  for (const item of toRoute) {
    const attempt = attemptById.get(item.placementId);
    const shapeLocal = item.pathPoints;
    const targetLocal = item.target;
    const shapeGeo = shapeLocal.map((point) => offsetCoordinate(searchOrigin, point.x, point.y));
    const targetGeo = targetLocal.map((point) => offsetCoordinate(searchOrigin, point.x, point.y));
    const shapeStart = shapeGeo[0];
    const connectorEnds = connectorEndpoints(userLocation, searchOrigin, shapeLocal[0]);
    let connectorGeo: Coordinate[] = [];
    let connectorMeters = connectorEnds.to ? distanceMeters(userLocation, connectorEnds.to) : 0;
    if (connectStart && shapeStart && distanceMeters(userLocation, shapeStart) > 25) {
      if (attempt) {
        attempt.connectorAttempted = true;
        attempt.connectorSkipReason = null;
      }
      try {
        const leg = await routePedestrianLeg(userLocation, shapeStart);
        valhallaRouteCalls += 1;
        connectorGeo = leg.coordinates;
        connectorMeters = polylineLengthMeters(connectorGeo);
        if (attempt) {
          attempt.connectorValhalla = {
            path: '/route',
            from: userLocation,
            to: shapeStart,
            httpStatus: 200,
            ok: true,
            error: null,
            pointCount: connectorGeo.length,
            usedStraightFallback: false,
          };
        }
      } catch (error) {
        if (error instanceof ValhallaRequestError) {
          failures.push({
            code: error.code,
            message: `Connector failed: ${error.message}`,
            candidateId: item.placementId,
          });
          if (attempt) {
            attempt.connectorValhalla = {
              path: '/route',
              from: userLocation,
              to: shapeStart,
              httpStatus: error.status,
              ok: false,
              error: `${error.code}: ${error.message}`,
              pointCount: 0,
              usedStraightFallback: true,
            };
          }
        }
        connectorGeo = [userLocation, shapeStart];
        connectorMeters = distanceMeters(userLocation, shapeStart);
      }
    } else if (attempt) {
      attempt.connectorAttempted = false;
      attempt.connectorSkipReason = !connectStart
        ? 'connectStart_disabled'
        : !shapeStart
          ? 'missing_shape_start'
          : 'shape_start_within_25m';
    }

    const scored = scorePolylines(shapeLocal, targetLocal);
    const quality = classifyQuality(item, scored.score, input.targetDistanceMeters);
    if (attempt) {
      attempt.shapeScore = scored.score;
      attempt.shapeMatchCoverage = scored.coverage;
      attempt.quality = quality;
    }

    // Diagnostics-only: captured for every candidate that reached routing,
    // including ones about to be dropped as "weak" below — this never feeds
    // back into route selection, only into the length-ratio history record.
    const totalGeoForLengthSample = joinCoordinates(connectorGeo, shapeGeo);
    const totalDistanceForLengthSample = polylineLengthMeters(totalGeoForLengthSample);
    routeLengthSamples.push({
      placementId: item.placementId,
      targetDistanceMeters: input.targetDistanceMeters,
      shapeRouteMeters: item.shapeRouteMeters,
      connectorDistanceMeters: connectorMeters,
      totalDistanceMeters: totalDistanceForLengthSample,
      shapeRouteRatio: item.shapeRouteMeters / Math.max(input.targetDistanceMeters, 1),
      totalRatio: totalDistanceForLengthSample / Math.max(input.targetDistanceMeters, 1),
      quality,
      usedStraightFallback: attempt?.connectorValhalla?.usedStraightFallback ?? false,
      geometryVariant,
    });

    if (quality === 'weak') {
      const reason = `pipeline_quality: shapeScore ${scored.score.toFixed(4)} < ${EXPERIMENTAL_PIPELINE.acceptableShapeScore}`;
      if (attempt) {
        attempt.excludedFromRoutedReason = reason;
      }
      failures.push({
        code: 'NO_ROUTE',
        message: 'Graph-feasible placement was too weak after shape scoring.',
        candidateId: item.placementId,
        details: { shapeScore: scored.score, coverage: scored.coverage },
      });
      continue;
    }
    if (attempt) {
      attempt.excludedFromRoutedReason = null;
    }

    const totalGeo = joinCoordinates(connectorGeo, shapeGeo);
    routed.push({
      id: item.placementId,
      source: 'valhalla',
      developmentOnly: true,
      coordinates: totalGeo,
      targetCoordinates: targetGeo,
      shapeCoordinates: shapeGeo,
      connectorCoordinates: connectorGeo,
      distanceMeters: polylineLengthMeters(totalGeo),
      shapeScore: scored.score,
      coverage: scored.coverage,
      scoreBreakdown: shapeScoreBreakdown(scored),
      metadata: {
        rotationDegrees: item.rotationDegrees,
        scale: item.scale,
        placement: item.eastMeters === 0 && item.northMeters === 0 ? 'start-anchored' : 'offset',
        offsetAcrossMeters: Math.round(Math.hypot(item.eastMeters, item.northMeters)),
        method: 'graph_constrained',
        connectedFromStart: connectorMeters < 40 || connectorGeo.length >= 2,
        connected: item.connected,
        eastMeters: item.eastMeters,
        northMeters: item.northMeters,
        distanceFromUserMeters: Math.round(
          placementDistanceFromUser(userLocation, searchOrigin, item.eastMeters, item.northMeters),
        ),
        startSnapDistanceMeters: connectorMeters,
        lengthError: Math.abs(item.shapeRouteMeters - input.targetDistanceMeters),
        distanceError: Math.abs(item.shapeRouteMeters - input.targetDistanceMeters),
        detourRatio: Math.max(0, item.shapeRouteMeters / Math.max(input.targetDistanceMeters, 1) - 1),
        backtrackRatio: item.backtracking,
        score: scored,
        connectorDistanceMeters: connectorMeters,
        graphShapeScore: item.result.metrics.graphShapeScore,
        failureReason: item.failureReason,
        shapeRouteDistanceMeters: item.shapeRouteMeters,
        totalDistanceMeters: polylineLengthMeters(totalGeo),
        quality,
        headingAgreementDegrees: item.headingAgreementDegrees,
        largestGap: item.largestGap,
        geometryVariant,
      },
    });
  }

  const unique = dedupeRoutes(routed).slice(0, config.maxReturnedRoutes);
  const status = pipelineStatus(unique, viable.length);
  const suggestions = statusSuggestions(input.word, status);
  const elapsedMs = Date.now() - started;
  const diagnostics = {
    placementsEvaluated: ranked.length,
    graphFeasible: feasibility.filter((item) => item.feasible).length,
    placementsRejected: feasibility.filter((item) => !item.feasible).length,
    placementsRouted: toRoute.length,
    graphEdgesExamined: collection.segments.length,
    searchStates,
    valhallaLocateCalls: collection.valhallaCalls + (options.collection || options.searchOriginSnap ? 0 : 1),
    valhallaRouteCalls,
    valhallaTraceRouteCalls: 0,
    neighborhoodRadiusMeters: getSearchRadiusForTargetDistance(input.targetDistanceMeters),
    placementRadiusMeters: getPlacementRadiusForTargetDistance(input.targetDistanceMeters),
    feasibility,
    routingAttempts,
    successPlacementRank: {
      placementId: COMPARE_PLACEMENT_ID,
      streetFitRank: streetFitRankById.get(COMPARE_PLACEMENT_ID) ?? -1,
      inFeasibilityTop96: (streetFitRankById.get(COMPARE_PLACEMENT_ID) ?? -1) >= 0 && (streetFitRankById.get(COMPARE_PLACEMENT_ID) ?? -1) < EXPERIMENTAL_PIPELINE.feasibilityTop,
      graphFeasible: feasibility.find((item) => item.placementId === COMPARE_PLACEMENT_ID)?.feasible ?? null,
    },
    searchOriginSnap: originSnap,
    graphNodeCount,
    streetFitFunnel,
    graphSearchStats,
    routeLengthSamples,
    geometryVariant,
    viableCount: viable.length,
  };
  console.log('[experimental search-origin]', {
    rawGps: originalLocation(originSnap),
    snappedSearch: searchOrigin,
    snapDistanceMeters: originSnap.snapDistanceMeters,
    snapped: originSnap.snapped,
    wayId: originSnap.wayId,
    fallbackReason: originSnap.fallbackReason,
  });
  console.log('[experimental routing-stage]', {
    start: input.start,
    targetDistanceMeters: input.targetDistanceMeters,
    word: wordShape.word,
    pipelineStatus: pipelineStatus(unique, viable.length),
    routedBeforeProduct: unique.length,
    graphFeasible: feasible.length,
    selectedForRouting: toRoute.length,
    successPlacementRank: diagnostics.successPlacementRank,
    attempts: routingAttempts.map((item) => ({
      id: item.placementId,
      rot: item.rotationDegrees,
      scale: item.scale,
      east: item.eastMeters,
      north: item.northMeters,
      distanceFromUser: item.distanceFromUserMeters,
      graphCoverage: Number(item.graphCoverage.toFixed(4)),
      largestGap: Number(item.largestGap.toFixed(4)),
      connected: item.connected,
      pathPointCount: item.pathPointCount,
      firstGeo: item.firstGeo,
      lastGeo: item.lastGeo,
      selectedForRouting: item.selectedForRouting,
      excludedBeforeRoutingReason: item.excludedBeforeRoutingReason,
      shapeMethod: item.shapeMethod,
      connectorAttempted: item.connectorAttempted,
      connectorSkipReason: item.connectorSkipReason,
      connectorValhalla: item.connectorValhalla,
      shapeScore: item.shapeScore,
      shapeMatchCoverage: item.shapeMatchCoverage,
      quality: item.quality,
      excludedFromRoutedReason: item.excludedFromRoutedReason,
    })),
  });
  const bestTarget = unique[0]?.targetCoordinates ?? [];
  const textReport = formatExperimentalReport({
    input,
    word: wordShape.word,
    status,
    unique,
    diagnostics,
    elapsedMs,
    feasibility,
  });
  const svg = renderExperimentalSvg(userLocation, searchOrigin, unique, feasibility, collection.segments);

  return {
    source: 'valhalla',
    developmentOnly: true,
    warning:
      'DEVELOPMENT ONLY — graph-constrained experimental pipeline. Shape score excludes the start connector.',
    word: wordShape.word,
    wordShape: {
      word: wordShape.word,
      width: wordShape.width,
      height: wordShape.height,
      aspectRatio: wordShape.aspectRatio,
      length: wordShape.length,
    },
    target: {
      coordinates: bestTarget,
      lengthMeters: polylineLengthMeters(bestTarget),
    },
    start: input.start,
    elapsedMs,
    routes: unique,
    failures:
      unique.length === 0
        ? [
            {
              code: 'NO_VIABLE_SHAPE',
              message: status === 'no_viable_shape' ? 'No strong walkable match was found nearby.' : 'Only weak matches were found.',
            },
            ...failures,
          ]
        : failures,
    search: {
      specCount: ranked.length,
      rotationCount: STREET_FIT_SEARCH.rotationCount,
      placementCount: ranked.length,
      initialScale: STREET_FIT_SEARCH.scales[2] ?? 1,
      maxAttempts: EXPERIMENTAL_PIPELINE.feasibilityTop,
      routedAttempts: toRoute.length,
      inRangeCandidates: unique.length,
      returnedRoutes: unique.length,
      valhallaCalls: collection.valhallaCalls + valhallaRouteCalls,
    },
    status,
    message:
      status === 'ok'
        ? 'Viable walkable matches were found.'
        : status === 'weak_candidates'
          ? 'Only weak walkable matches were found.'
          : 'No strong walkable match was found nearby.',
    suggestions,
    textReport,
    svg,
    diagnostics,
  };
}

/**
 * Single entry point for both ordinary single-variant requests and the
 * shared-budget multi-variant experiment.
 *
 * Requested with exactly one variant (the default, `['smooth']`), this
 * calls `runExperimentalPipeline` once, exactly as before this experiment
 * existed, and returns its report unchanged (only wrapping it in
 * `diagnostics.byGeometryVariant` for callers that always read that shape)
 * — so the default path is byte-identical to the pre-shared-budget
 * behavior.
 *
 * Requested with 2+ variants, this delegates to
 * `runSharedBudgetGeometryPipeline`, which combines every variant's
 * candidates into ONE pool and applies the existing
 * `EXPERIMENTAL_PIPELINE.feasibilityTop` cut ONCE across all of them —
 * i.e. angular candidates compete with smooth candidates for the same
 * fixed graph-search budget, rather than each variant getting its own
 * separate 96-candidate budget (that was the previous, now-replaced,
 * architecture).
 */
export async function runExperimentalPipelineMultiVariant(
  input: {
    word: string;
    start: Coordinate;
    targetDistanceMeters: number;
  },
  variants: LetterShapeVariant[] = ['smooth'],
  options: Omit<PipelineOptions, 'geometryVariant'> = {},
): Promise<ExperimentalPipelineReport> {
  const requestedVariants = variants.length > 0 ? variants : (['smooth'] as LetterShapeVariant[]);

  // Collected exactly once and shared: the street graph and the placement
  // grid are both independent of letter geometry (the graph is the real
  // street network around the search origin; placements are pure
  // rotation/scale/translation offsets with no shape data), so sharing them
  // does not change what any variant searches, and avoids repeating the
  // same Valhalla /locate calls once per variant.
  const userLocation = input.start;
  const originSnap =
    options.searchOriginSnap ??
    (options.collection ? identitySearchOrigin(userLocation) : await snapSearchOrigin(userLocation));
  const searchOrigin = searchOriginFromSnap(originSnap);
  const collection =
    options.collection ??
    (await collectNeighborhoodShapeGraph(searchOrigin, {
      radiusMeters: getSearchRadiusForTargetDistance(input.targetDistanceMeters),
    }));
  const placements =
    options.placements ??
    buildStreetFitPlacements({
      translationRingsMeters: getPlacementRingsForTargetDistance(input.targetDistanceMeters),
    });
  const sharedOptions: PipelineOptions = { ...options, collection, searchOriginSnap: originSnap, placements };

  if (requestedVariants.length === 1) {
    const only = await runExperimentalPipeline(input, { ...sharedOptions, geometryVariant: requestedVariants[0] });
    return {
      ...only,
      diagnostics: { ...only.diagnostics, byGeometryVariant: { [only.diagnostics.geometryVariant]: only } },
    };
  }

  return runSharedBudgetGeometryPipeline(input, requestedVariants, sharedOptions);
}

/**
 * The shared-budget multi-variant pipeline (2+ geometry variants).
 *
 * Mirrors `runExperimentalPipeline`'s own logic stage-for-stage — same
 * `EXPERIMENTAL_PIPELINE` constants, same `pickDiverse`, same
 * `classifyQuality`, same routing/scoring/dedupe/product-gate order — the
 * only structural difference is what feeds the feasibility loop:
 *
 *   runExperimentalPipeline:        one variant's ranked 1360 → its own top 96
 *   runSharedBudgetGeometryPipeline: every variant's ranked 1360, COMBINED
 *                                    and re-sorted by the same street-fit
 *                                    score, → ONE shared top 96
 *
 * This logic is deliberately NOT folded into `runExperimentalPipeline`
 * itself (which stays completely untouched) so every existing caller of
 * that function — self-tests, diagnostic scripts, `generateGraphConstrainedExperimentalRoutes`
 * — keeps working against exactly the code it always has.
 */
async function runSharedBudgetGeometryPipeline(
  input: {
    word: string;
    start: Coordinate;
    targetDistanceMeters: number;
  },
  requestedVariants: LetterShapeVariant[],
  options: PipelineOptions,
): Promise<ExperimentalPipelineReport> {
  const started = Date.now();
  const userLocation = input.start;
  const originSnap =
    options.searchOriginSnap ??
    (options.collection ? identitySearchOrigin(userLocation) : await snapSearchOrigin(userLocation));
  const searchOrigin = searchOriginFromSnap(originSnap);
  const collection =
    options.collection ??
    (await collectNeighborhoodShapeGraph(searchOrigin, {
      radiusMeters: getSearchRadiusForTargetDistance(input.targetDistanceMeters),
    }));
  const ways = segmentsToWays(collection.segments);
  const placements =
    options.placements ??
    buildStreetFitPlacements({
      translationRingsMeters: getPlacementRingsForTargetDistance(input.targetDistanceMeters),
    });

  const wordShapesByVariant = new Map(
    requestedVariants.map((variant) => [variant, buildWalkableWordShape(input.word, { letterVariant: variant })] as const),
  );
  // word/kind/multiLetter are properties of the WORD STRING, not the geometry — identical across variants for the same input word.
  const anyWordShape = wordShapesByVariant.get(requestedVariants[0]!)!;
  const kind = shapeKindFromWord(anyWordShape.word);
  const multiLetter = anyWordShape.word.length > 1;

  // Stage 1: rank each variant's full 1360-placement pool independently,
  // with the existing, unmodified street-fit score — no geometry-specific
  // bonus or normalization (verified beforehand that smooth/angular scores
  // are on comparable scales; see the task's own written verification).
  const rankedByVariant = new Map(
    requestedVariants.map((variant) => {
      const wordShape = wordShapesByVariant.get(variant)!;
      const ranked = rankStreetFitPlacements({
        word: wordShape,
        targetDistanceMeters: input.targetDistanceMeters,
        graph: ways,
        placements,
      });
      return [variant, ranked] as const;
    }),
  );
  type TaggedCandidate = StreetFitPlacementResult & {
    geometryVariant: LetterShapeVariant;
    variantRank: number;
  };

  // Stage 2: combine into ONE pool and cut ONCE at the existing
  // feasibilityTop (96) — the same number as the smooth-only baseline, not
  // 96 per variant. Tie-break matches rankStreetFitPlacements's own
  // (score desc, placement id) with geometryVariant only as a final,
  // deterministic tie-break — never a preference.
  const combined: TaggedCandidate[] = [];
  for (const [variant, ranked] of rankedByVariant) {
    ranked.forEach((item, index) => {
      combined.push({ ...item, geometryVariant: variant, variantRank: index } as TaggedCandidate);
    });
  }
  combined.sort(
    (a, b) => b.score - a.score || a.placement.id.localeCompare(b.placement.id) || a.geometryVariant.localeCompare(b.geometryVariant),
  );
  const feasibilityPool = combined.slice(0, EXPERIMENTAL_PIPELINE.feasibilityTop);

  const sharedTop96CountByVariant: Partial<Record<LetterShapeVariant, number>> = {};
  const sharedTop96VariantRanksRaw: Partial<Record<LetterShapeVariant, number[]>> = {};
  for (const item of feasibilityPool) {
    sharedTop96CountByVariant[item.geometryVariant] = (sharedTop96CountByVariant[item.geometryVariant] ?? 0) + 1;
    const list = sharedTop96VariantRanksRaw[item.geometryVariant] ?? [];
    list.push(item.variantRank);
    sharedTop96VariantRanksRaw[item.geometryVariant] = list;
  }
  const sharedTop96VariantRanks: Partial<Record<LetterShapeVariant, NumberDistribution>> = {};
  for (const variant of requestedVariants) {
    sharedTop96VariantRanks[variant] = summarizeNumbers(sharedTop96VariantRanksRaw[variant] ?? []);
  }
  const candidatesGeneratedByVariant: Partial<Record<LetterShapeVariant, number>> = {};
  for (const [variant, ranked] of rankedByVariant) {
    candidatesGeneratedByVariant[variant] = ranked.length;
  }
  const sharedCandidatePool: SharedCandidatePoolDiagnostics = {
    candidatesGeneratedByVariant,
    combinedCandidateCount: combined.length,
    sharedFeasibilityTop: EXPERIMENTAL_PIPELINE.feasibilityTop,
    sharedTop96CountByVariant,
    sharedTop96VariantRanks,
  };

  // Stage 3 onward: identical to runExperimentalPipeline from here — each
  // candidate already carries its own geometry-specific projected `target`
  // (computed by rankStreetFitPlacements via the same projectWordPlacement
  // call runExperimentalPipeline would otherwise repeat), so no candidate
  // can accidentally use the wrong variant's geometry.
  const feasibility: FeasibilityRecord[] = [];
  let searchStates = 0;
  for (const item of feasibilityPool) {
    const corridor = filterCorridorSegments(collection.segments, item.target);
    const result = routeGraphConstrainedShape({
      target: item.target,
      kind,
      graph: buildShapeGraph(corridor),
      multiLetter,
    });
    searchStates += result.search.statesExplored;
    // placementId is prefixed with the variant here (and only here): the
    // same rotation/scale/offset placement id is shared verbatim across
    // every variant's independent ranking (all variants rank the exact
    // same `placements` array), so two different-geometry candidates can
    // otherwise collide on an identical bare id — this keeps every
    // downstream Map/array keyed by placementId (attemptById, the final
    // route's own id, etc.) unique per candidate.
    feasibility.push({
      placementId: `${item.geometryVariant}:${item.placement.id}`,
      rotationDegrees: item.placement.rotationDegrees,
      scale: item.placement.scale,
      eastMeters: item.placement.eastMeters,
      northMeters: item.placement.northMeters,
      streetFitScore: item.score,
      feasible: isFeasible(result),
      discoveryScore: discoveryScore(result),
      coverage: result.metrics.targetCoverage,
      headingAgreementDegrees: result.metrics.headingAgreementDegrees,
      forwardProgress: result.metrics.forwardProgress,
      backtracking: result.metrics.backtracking,
      largestGap: result.metrics.largestTargetProgressGap,
      meanPerpendicularError: result.metrics.meanPerpendicularError,
      connected: result.metrics.connected,
      failureReason: result.failureReason,
      shapeRouteMeters: result.metrics.routeDistanceMeters,
      target: item.target,
      pathPoints: result.pathPoints,
      graphLines: corridor.map((segment) => segment.points),
      result,
      geometryVariant: item.geometryVariant,
      variantRank: item.variantRank,
    });
  }

  // Combined-pool rank (0-based position across ALL variants' candidates
  // together, before the shared top-96 cut) — keyed the same
  // `variant:placementId` way feasibility's own placementId already is, so
  // the two composite keys line up without double-prefixing.
  const combinedRankById = new Map(combined.map((item, index) => [`${item.geometryVariant}:${item.placement.id}`, index]));
  const feasible = feasibility.filter((item) => item.feasible);
  const viable = pickDiverse(feasible.filter((item) => item.pathPoints.length >= 2));
  const toRoute = viable.slice(0, EXPERIMENTAL_PIPELINE.routeTop);
  const viableIds = new Set(viable.map((item) => item.placementId));
  const toRouteIds = new Set(toRoute.map((item) => item.placementId));

  const streetFitFunnel: StreetFitFunnelDiagnostics = {
    totalPlacements: combined.length,
    feasibilityTop: EXPERIMENTAL_PIPELINE.feasibilityTop,
    allScores: summarizeNumbers(combined.map((item) => item.score)),
    top96Scores: summarizeNumbers(feasibilityPool.map((item) => item.score)),
    graphFeasibleCount: feasible.length,
    graphRejectedCount: feasibility.length - feasible.length,
    feasibleStreetFitRank: summarizeNumbers(
      feasible
        .map((item) => combinedRankById.get(item.placementId))
        .filter((rank): rank is number => rank != null),
    ),
  };
  // Not buildGraphSearchMetricStats here: that helper looks rank up by plain
  // placementId, which is not unique across variants (the same
  // rotation/scale/offset id can appear once per variant) — each
  // FeasibilityRecord already carries its own correct variantRank directly,
  // so this reads that instead of risking a cross-variant collision.
  const graphSearchStats = {
    feasible: buildSharedGraphSearchMetricStats(feasible),
    rejected: buildSharedGraphSearchMetricStats(feasibility.filter((item) => !item.feasible)),
  };
  const graphNodeCount = Object.keys(buildShapeGraph(collection.segments).nodes).length;

  const routingAttempts: RoutingStageAttempt[] = feasible.map((item) => {
    const scored = item.pathPoints.length >= 2 ? scorePolylines(item.pathPoints, item.target) : null;
    const quality = scored ? classifyQuality(item, scored.score, input.targetDistanceMeters) : 'weak';
    let excludedBeforeRoutingReason: string | null = null;
    if (item.pathPoints.length < 2) {
      excludedBeforeRoutingReason = 'pathPoints < 2';
    } else if (!viableIds.has(item.placementId)) {
      excludedBeforeRoutingReason = 'dropped_by_pickDiverse_as_similar';
    } else if (!toRouteIds.has(item.placementId)) {
      excludedBeforeRoutingReason = 'beyond_routeTop';
    }
    const firstLocal = item.pathPoints[0] ?? null;
    const lastLocal = item.pathPoints[item.pathPoints.length - 1] ?? null;
    return {
      placementId: item.placementId,
      streetFitRank: item.variantRank ?? -1,
      feasibilityPoolIndex: feasibility.findIndex((row) => row.placementId === item.placementId),
      rotationDegrees: item.rotationDegrees,
      scale: item.scale,
      eastMeters: item.eastMeters,
      northMeters: item.northMeters,
      distanceFromUserMeters: Math.round(
        placementDistanceFromUser(userLocation, searchOrigin, item.eastMeters, item.northMeters),
      ),
      graphCoverage: item.coverage,
      largestGap: item.largestGap,
      connected: item.connected,
      pathPointCount: item.pathPoints.length,
      firstLocal,
      lastLocal,
      firstGeo: firstLocal ? offsetCoordinate(searchOrigin, firstLocal.x, firstLocal.y) : null,
      lastGeo: lastLocal ? offsetCoordinate(searchOrigin, lastLocal.x, lastLocal.y) : null,
      selectedForRouting: toRouteIds.has(item.placementId),
      excludedBeforeRoutingReason,
      shapeMethod: 'graph_constrained',
      connectorAttempted: false,
      connectorSkipReason: toRouteIds.has(item.placementId) ? null : 'not_selected_for_routing',
      connectorValhalla: null,
      shapeScore: scored?.score ?? null,
      shapeMatchCoverage: scored?.coverage ?? null,
      quality,
      excludedFromRoutedReason:
        toRouteIds.has(item.placementId) && quality === 'weak'
          ? `pipeline_quality: shapeScore ${scored?.score.toFixed(4) ?? 'n/a'} < ${EXPERIMENTAL_PIPELINE.acceptableShapeScore}`
          : excludedBeforeRoutingReason,
      geometryVariant: item.geometryVariant,
    };
  });
  const attemptById = new Map(routingAttempts.map((item) => [item.placementId, item]));

  let valhallaRouteCalls = 0;
  const routed: GeneratedRoute[] = [];
  const failures: RouteFailure[] = [];
  const routeLengthSamples: RouteLengthSample[] = [];
  const connectStart = options.connectStart ?? true;

  for (const item of toRoute) {
    const attempt = attemptById.get(item.placementId);
    const shapeLocal = item.pathPoints;
    const targetLocal = item.target;
    const shapeGeo = shapeLocal.map((point) => offsetCoordinate(searchOrigin, point.x, point.y));
    const targetGeo = targetLocal.map((point) => offsetCoordinate(searchOrigin, point.x, point.y));
    const shapeStart = shapeGeo[0];
    const connectorEnds = connectorEndpoints(userLocation, searchOrigin, shapeLocal[0]);
    let connectorGeo: Coordinate[] = [];
    let connectorMeters = connectorEnds.to ? distanceMeters(userLocation, connectorEnds.to) : 0;
    if (connectStart && shapeStart && distanceMeters(userLocation, shapeStart) > 25) {
      if (attempt) {
        attempt.connectorAttempted = true;
        attempt.connectorSkipReason = null;
      }
      try {
        const leg = await routePedestrianLeg(userLocation, shapeStart);
        valhallaRouteCalls += 1;
        connectorGeo = leg.coordinates;
        connectorMeters = polylineLengthMeters(connectorGeo);
        if (attempt) {
          attempt.connectorValhalla = {
            path: '/route',
            from: userLocation,
            to: shapeStart,
            httpStatus: 200,
            ok: true,
            error: null,
            pointCount: connectorGeo.length,
            usedStraightFallback: false,
          };
        }
      } catch (error) {
        if (error instanceof ValhallaRequestError) {
          failures.push({
            code: error.code,
            message: `Connector failed: ${error.message}`,
            candidateId: item.placementId,
          });
          if (attempt) {
            attempt.connectorValhalla = {
              path: '/route',
              from: userLocation,
              to: shapeStart,
              httpStatus: error.status,
              ok: false,
              error: `${error.code}: ${error.message}`,
              pointCount: 0,
              usedStraightFallback: true,
            };
          }
        }
        connectorGeo = [userLocation, shapeStart];
        connectorMeters = distanceMeters(userLocation, shapeStart);
      }
    } else if (attempt) {
      attempt.connectorAttempted = false;
      attempt.connectorSkipReason = !connectStart
        ? 'connectStart_disabled'
        : !shapeStart
          ? 'missing_shape_start'
          : 'shape_start_within_25m';
    }

    const scored = scorePolylines(shapeLocal, targetLocal);
    const quality = classifyQuality(item, scored.score, input.targetDistanceMeters);
    if (attempt) {
      attempt.shapeScore = scored.score;
      attempt.shapeMatchCoverage = scored.coverage;
      attempt.quality = quality;
    }

    const totalGeoForLengthSample = joinCoordinates(connectorGeo, shapeGeo);
    const totalDistanceForLengthSample = polylineLengthMeters(totalGeoForLengthSample);
    routeLengthSamples.push({
      placementId: item.placementId,
      targetDistanceMeters: input.targetDistanceMeters,
      shapeRouteMeters: item.shapeRouteMeters,
      connectorDistanceMeters: connectorMeters,
      totalDistanceMeters: totalDistanceForLengthSample,
      shapeRouteRatio: item.shapeRouteMeters / Math.max(input.targetDistanceMeters, 1),
      totalRatio: totalDistanceForLengthSample / Math.max(input.targetDistanceMeters, 1),
      quality,
      usedStraightFallback: attempt?.connectorValhalla?.usedStraightFallback ?? false,
      geometryVariant: item.geometryVariant,
    });

    if (quality === 'weak') {
      const reason = `pipeline_quality: shapeScore ${scored.score.toFixed(4)} < ${EXPERIMENTAL_PIPELINE.acceptableShapeScore}`;
      if (attempt) {
        attempt.excludedFromRoutedReason = reason;
      }
      failures.push({
        code: 'NO_ROUTE',
        message: 'Graph-feasible placement was too weak after shape scoring.',
        candidateId: item.placementId,
        details: { shapeScore: scored.score, coverage: scored.coverage },
      });
      continue;
    }
    if (attempt) {
      attempt.excludedFromRoutedReason = null;
    }

    const totalGeo = joinCoordinates(connectorGeo, shapeGeo);
    routed.push({
      id: item.placementId,
      source: 'valhalla',
      developmentOnly: true,
      coordinates: totalGeo,
      targetCoordinates: targetGeo,
      shapeCoordinates: shapeGeo,
      connectorCoordinates: connectorGeo,
      distanceMeters: polylineLengthMeters(totalGeo),
      shapeScore: scored.score,
      coverage: scored.coverage,
      scoreBreakdown: shapeScoreBreakdown(scored),
      metadata: {
        rotationDegrees: item.rotationDegrees,
        scale: item.scale,
        placement: item.eastMeters === 0 && item.northMeters === 0 ? 'start-anchored' : 'offset',
        offsetAcrossMeters: Math.round(Math.hypot(item.eastMeters, item.northMeters)),
        method: 'graph_constrained',
        connectedFromStart: connectorMeters < 40 || connectorGeo.length >= 2,
        connected: item.connected,
        eastMeters: item.eastMeters,
        northMeters: item.northMeters,
        distanceFromUserMeters: Math.round(
          placementDistanceFromUser(userLocation, searchOrigin, item.eastMeters, item.northMeters),
        ),
        startSnapDistanceMeters: connectorMeters,
        lengthError: Math.abs(item.shapeRouteMeters - input.targetDistanceMeters),
        distanceError: Math.abs(item.shapeRouteMeters - input.targetDistanceMeters),
        detourRatio: Math.max(0, item.shapeRouteMeters / Math.max(input.targetDistanceMeters, 1) - 1),
        backtrackRatio: item.backtracking,
        score: scored,
        connectorDistanceMeters: connectorMeters,
        graphShapeScore: item.result.metrics.graphShapeScore,
        failureReason: item.failureReason,
        shapeRouteDistanceMeters: item.shapeRouteMeters,
        totalDistanceMeters: polylineLengthMeters(totalGeo),
        quality,
        headingAgreementDegrees: item.headingAgreementDegrees,
        largestGap: item.largestGap,
        geometryVariant: item.geometryVariant,
      },
    });
  }

  const unique = dedupeRoutes(routed).slice(0, config.maxReturnedRoutes);
  const status = pipelineStatus(unique, viable.length);
  const suggestions = statusSuggestions(input.word, status);
  const elapsedMs = Date.now() - started;
  const diagnostics = {
    placementsEvaluated: combined.length,
    graphFeasible: feasibility.filter((item) => item.feasible).length,
    placementsRejected: feasibility.filter((item) => !item.feasible).length,
    placementsRouted: toRoute.length,
    graphEdgesExamined: collection.segments.length,
    searchStates,
    valhallaLocateCalls: collection.valhallaCalls + (options.collection || options.searchOriginSnap ? 0 : 1),
    valhallaRouteCalls,
    valhallaTraceRouteCalls: 0,
    neighborhoodRadiusMeters: getSearchRadiusForTargetDistance(input.targetDistanceMeters),
    placementRadiusMeters: getPlacementRadiusForTargetDistance(input.targetDistanceMeters),
    feasibility,
    routingAttempts,
    successPlacementRank: {
      placementId: 'sf-r315-s0.6-e565.7-n565.7',
      streetFitRank: -1,
      inFeasibilityTop96: false,
      graphFeasible: null,
    },
    searchOriginSnap: originSnap,
    graphNodeCount,
    streetFitFunnel,
    graphSearchStats,
    routeLengthSamples,
    geometryVariant: requestedVariants[0]!,
    viableCount: viable.length,
    sharedCandidatePool,
  };
  const bestTarget = unique[0]?.targetCoordinates ?? [];

  return {
    source: 'valhalla',
    developmentOnly: true,
    warning:
      'DEVELOPMENT ONLY — shared-budget multi-variant experimental pipeline. Shape score excludes the start connector.',
    word: anyWordShape.word,
    wordShape: {
      word: anyWordShape.word,
      width: anyWordShape.width,
      height: anyWordShape.height,
      aspectRatio: anyWordShape.aspectRatio,
      length: anyWordShape.length,
    },
    target: {
      coordinates: bestTarget,
      lengthMeters: polylineLengthMeters(bestTarget),
    },
    start: input.start,
    elapsedMs,
    routes: unique,
    failures:
      unique.length === 0
        ? [
            {
              code: 'NO_VIABLE_SHAPE',
              message: status === 'no_viable_shape' ? 'No strong walkable match was found nearby.' : 'Only weak matches were found.',
            },
            ...failures,
          ]
        : failures,
    search: {
      specCount: combined.length,
      rotationCount: STREET_FIT_SEARCH.rotationCount,
      placementCount: combined.length,
      initialScale: STREET_FIT_SEARCH.scales[2] ?? 1,
      maxAttempts: EXPERIMENTAL_PIPELINE.feasibilityTop,
      routedAttempts: toRoute.length,
      inRangeCandidates: unique.length,
      returnedRoutes: unique.length,
      valhallaCalls: collection.valhallaCalls + valhallaRouteCalls,
    },
    status,
    message:
      status === 'ok'
        ? 'Viable walkable matches were found.'
        : status === 'weak_candidates'
          ? 'Only weak walkable matches were found.'
          : 'No strong walkable match was found nearby.',
    suggestions,
    textReport: `Shared-budget multi-variant report (${requestedVariants.join('+')}) — status ${status}, shared top-${EXPERIMENTAL_PIPELINE.feasibilityTop}: ${Object.entries(sharedTop96CountByVariant).map(([variant, count]) => `${variant}=${count}`).join(' ')}`,
    svg: '',
    diagnostics,
  };
}

export async function generateGraphConstrainedExperimentalRoutes(input: {
  word: string;
  start: Coordinate;
  targetDistanceMeters: number;
}): Promise<GenerateRoutesResponse> {
  return runExperimentalPipeline(input);
}

function classifyQuality(item: FeasibilityRecord, shapeScore: number, targetDistance: number): RouteQuality {
  if (!item.feasible || shapeScore < EXPERIMENTAL_PIPELINE.acceptableShapeScore) {
    return 'weak';
  }
  const ratio = item.shapeRouteMeters / Math.max(targetDistance, 1);
  const distanceOk = ratio >= 0.45 && ratio <= 1.7;
  if (shapeScore >= EXPERIMENTAL_PIPELINE.strongShapeScore && distanceOk) {
    return 'excellent';
  }
  return 'acceptable';
}

export function pipelineStatus(routes: GeneratedRoute[], viableCount: number): PipelineStatus {
  if (routes.length === 0) {
    return viableCount === 0 ? 'no_viable_shape' : 'weak_candidates';
  }
  const strong = routes.some((route) => route.metadata.quality === 'excellent');
  return strong || routes.length > 0 ? 'ok' : 'weak_candidates';
}

export function statusSuggestions(word: string, status: PipelineStatus): string[] {
  if (status === 'ok') {
    return [];
  }
  const suggestions = [
    'Try a shorter target distance (1500–2500 m) before 4 km.',
    'Simple letters (L, Z, O) are more likely than multi-letter words.',
  ];
  if (word === 'ROBZ' || word.length > 2) {
    suggestions.push('The tested Egypt graph often lacks multi-letter street geometry.');
  }
  if (status === 'weak_candidates') {
    suggestions.push('A connected path exists but does not follow the letter strongly enough.');
  }
  return suggestions;
}

function buildGraphSearchMetricStats(
  items: readonly FeasibilityRecord[],
  streetFitRankById: ReadonlyMap<string, number>,
): GraphSearchMetricStats {
  return {
    count: items.length,
    targetCoverage: summarizeNumbers(items.map((item) => item.coverage)),
    headingAgreementDegrees: summarizeNumbers(items.map((item) => item.headingAgreementDegrees)),
    forwardProgress: summarizeNumbers(items.map((item) => item.forwardProgress)),
    backtracking: summarizeNumbers(items.map((item) => item.backtracking)),
    routeDistanceMeters: summarizeNumbers(items.map((item) => item.shapeRouteMeters)),
    discoveryScore: summarizeNumbers(items.map((item) => item.discoveryScore)),
    streetFitScore: summarizeNumbers(items.map((item) => item.streetFitScore)),
    streetFitRank: summarizeNumbers(
      items
        .map((item) => streetFitRankById.get(item.placementId))
        .filter((rank): rank is number => rank != null),
    ),
  };
}

/**
 * Same shape as buildGraphSearchMetricStats, for the shared-budget path,
 * where placementId is not unique across variants (the same
 * rotation/scale/offset id can appear once per variant) — reads each
 * item's own variantRank directly instead of a placementId-keyed lookup.
 */
function buildSharedGraphSearchMetricStats(items: readonly FeasibilityRecord[]): GraphSearchMetricStats {
  return {
    count: items.length,
    targetCoverage: summarizeNumbers(items.map((item) => item.coverage)),
    headingAgreementDegrees: summarizeNumbers(items.map((item) => item.headingAgreementDegrees)),
    forwardProgress: summarizeNumbers(items.map((item) => item.forwardProgress)),
    backtracking: summarizeNumbers(items.map((item) => item.backtracking)),
    routeDistanceMeters: summarizeNumbers(items.map((item) => item.shapeRouteMeters)),
    discoveryScore: summarizeNumbers(items.map((item) => item.discoveryScore)),
    streetFitScore: summarizeNumbers(items.map((item) => item.streetFitScore)),
    streetFitRank: summarizeNumbers(
      items.map((item) => item.variantRank).filter((rank): rank is number => rank != null),
    ),
  };
}

function pickDiverse(items: FeasibilityRecord[]): FeasibilityRecord[] {
  const ranked = [...items].sort((a, b) => b.discoveryScore - a.discoveryScore || b.coverage - a.coverage);
  const picked: FeasibilityRecord[] = [];
  for (const item of ranked) {
    const similar = picked.some((existing) => {
      const rotationDelta = Math.abs(existing.rotationDegrees - item.rotationDegrees) % 180;
      const offsetDelta = Math.hypot(existing.eastMeters - item.eastMeters, existing.northMeters - item.northMeters);
      return rotationDelta < EXPERIMENTAL_PIPELINE.minRotationSpreadDegrees && offsetDelta < EXPERIMENTAL_PIPELINE.minOffsetSpreadMeters;
    });
    if (!similar) {
      picked.push(item);
    }
  }
  return picked;
}

export function dedupeRoutes(routes: GeneratedRoute[]): GeneratedRoute[] {
  const unique: GeneratedRoute[] = [];
  for (const route of [...routes].sort((a, b) => b.shapeScore - a.shapeScore)) {
    const duplicate = unique.find(
      (existing) => meanNearestDistance(existing.coordinates, route.coordinates) < EXPERIMENTAL_PIPELINE.dedupeMeters,
    );
    if (!duplicate) {
      unique.push(route);
    }
  }
  return unique;
}

function meanNearestDistance(a: Coordinate[], b: Coordinate[]): number {
  if (a.length === 0 || b.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const samples = a.length <= 20 ? a : resampleCoordinates(a, 20);
  const total = samples.reduce((sum, point) => {
    let min = Number.POSITIVE_INFINITY;
    for (const other of b) {
      min = Math.min(min, distanceMeters(point, other));
    }
    return sum + min;
  }, 0);
  return total / samples.length;
}

function resampleCoordinates(points: Coordinate[], count: number): Coordinate[] {
  if (points.length === 0) {
    return [];
  }
  const origin = points[0]!;
  const local = points.map((point) => ({
    x: distanceMeters(origin, { latitude: origin.latitude, longitude: point.longitude }) * (point.longitude >= origin.longitude ? 1 : -1),
    y: distanceMeters(origin, { latitude: point.latitude, longitude: origin.longitude }) * (point.latitude >= origin.latitude ? 1 : -1),
  }));
  return resamplePolyline(local, count).map((point) => offsetCoordinate(origin, point.x, point.y));
}

function joinCoordinates(connector: Coordinate[], shape: Coordinate[]): Coordinate[] {
  if (connector.length === 0) {
    return shape;
  }
  if (shape.length === 0) {
    return connector;
  }
  return [...connector, ...shape.slice(1)];
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

export function writeExperimentalSvg(svg: string, filename = 'generate-experimental.svg') {
  const path = resolve(DIAGNOSTIC_DIR, filename);
  writeFileSync(path, svg);
  return path;
}

export function formatExperimentalReport(input: {
  input: { word: string; start: Coordinate; targetDistanceMeters: number };
  word: string;
  status: PipelineStatus;
  unique: GeneratedRoute[];
  diagnostics: ExperimentalPipelineReport['diagnostics'];
  elapsedMs: number;
  feasibility: FeasibilityRecord[];
}): string {
  const d = input.diagnostics;
  const lines = [
    'Graph-constrained experimental pipeline (DEVELOPMENT ONLY)',
    `word ${input.word}  gps ${input.input.start.latitude}, ${input.input.start.longitude}  target ${input.input.targetDistanceMeters} m`,
    `status ${input.status}`,
    `search origin ${d.searchOriginSnap.snappedLatitude}, ${d.searchOriginSnap.snappedLongitude}  snapped=${d.searchOriginSnap.snapped}  snapDistance=${d.searchOriginSnap.snapDistanceMeters.toFixed(1)} m`,
    `placements evaluated ${d.placementsEvaluated}  graph-feasible ${d.graphFeasible}  rejected ${d.placementsRejected}  routed ${d.placementsRouted}`,
    `graph edges ${d.graphEdgesExamined}  search states ${d.searchStates}`,
    `search neighborhood ${d.neighborhoodRadiusMeters} m  placement ${d.placementRadiusMeters} m`,
    `Valhalla locate ${d.valhallaLocateCalls}  /route ${d.valhallaRouteCalls}  /trace_route ${d.valhallaTraceRouteCalls}  runtime ${input.elapsedMs} ms`,
    `compare ${d.successPlacementRank.placementId} streetFitRank=${d.successPlacementRank.streetFitRank} inTop96=${d.successPlacementRank.inFeasibilityTop96} graphFeasible=${d.successPlacementRank.graphFeasible}`,
    '',
  ];
  if (d.routingAttempts.length > 0) {
    lines.push('Routing stage (graph-feasible only):');
    for (const item of d.routingAttempts) {
      lines.push(
        `  ${item.placementId}  rot ${item.rotationDegrees} scale ${item.scale} e ${item.eastMeters} n ${item.northMeters} dist ${item.distanceFromUserMeters} m`,
      );
      lines.push(
        `    graphCov ${pct(item.graphCoverage)} gap ${pct(item.largestGap)} connected=${item.connected} pathPts=${item.pathPointCount} selected=${item.selectedForRouting}`,
      );
      lines.push(
        `    first ${fmtCoord(item.firstGeo)} last ${fmtCoord(item.lastGeo)} method=${item.shapeMethod}`,
      );
      lines.push(
        `    connector attempted=${item.connectorAttempted} skip=${item.connectorSkipReason ?? 'none'} valhalla=${item.connectorValhalla ? `${item.connectorValhalla.ok ? 'ok' : 'fail'} HTTP ${item.connectorValhalla.httpStatus ?? 'n/a'} fallback=${item.connectorValhalla.usedStraightFallback}` : 'none'}`,
      );
      lines.push(
        `    shapeScore ${item.shapeScore?.toFixed(4) ?? 'n/a'} quality=${item.quality ?? 'n/a'} excluded=${item.excludedFromRoutedReason ?? 'none'}`,
      );
    }
    lines.push('');
  }
  if (input.unique.length === 0) {
    lines.push(input.status === 'no_viable_shape' ? 'No strong walkable match was found nearby.' : 'Only weak matches were found.');
    lines.push('');
  }
  for (const [index, route] of input.unique.entries()) {
    const meta = route.metadata;
    lines.push(`${index + 1}. ${route.id}  ${meta.quality ?? ''}  rot ${meta.rotationDegrees}  scale ${meta.scale}  offset ${meta.offsetAcrossMeters} m`);
    lines.push(
      `   shape ${Math.round(meta.shapeRouteDistanceMeters ?? 0)} m  connector ${Math.round(meta.connectorDistanceMeters ?? 0)} m  total ${Math.round(route.distanceMeters)} m`,
    );
    lines.push(
      `   shape score ${route.shapeScore.toFixed(3)}  coverage ${pct(route.coverage)}  order ${route.scoreBreakdown.order.toFixed(3)}  heading ${fmt(meta.headingAgreementDegrees ?? 0)}°  backtrack ${pct(meta.backtrackRatio)}  gap ${pct(meta.largestGap ?? 0)}`,
    );
  }
  lines.push('');
  lines.push('Graph feasibility pool:');
  for (const item of input.feasibility.slice(0, 12)) {
    lines.push(
      `  ${item.feasible ? 'PASS' : 'fail'}  ${item.placementId}  cov ${pct(item.coverage)}  head ${fmt(item.headingAgreementDegrees)}°  ${item.failureReason ?? 'ok'}`,
    );
  }
  return lines.join('\n');
}

function renderExperimentalSvg(
  userLocation: Coordinate,
  searchOrigin: Coordinate,
  routes: GeneratedRoute[],
  feasibility: FeasibilityRecord[],
  segments: Array<Omit<GraphSegment, 'from' | 'to'>>,
): string {
  const userLocal = coordinatesToLocalMeters(searchOrigin, [userLocation])[0] ?? { x: 0, y: 0 };
  const panels = (routes.length > 0 ? routes.slice(0, 3) : feasibility.slice(0, 1)).map((item, index) => {
    if ('coordinates' in item) {
      const match = feasibility.find((record) => record.placementId === item.id);
      return renderPanel({
        index,
        label: `${item.id}  score ${item.shapeScore.toFixed(2)}  ${item.metadata.quality ?? ''}`,
        target: match?.target ?? [],
        path: match?.pathPoints ?? [],
        graph: match?.graphLines ?? segments.map((segment) => segment.points),
        connector: startConnector(userLocal, match?.pathPoints[0]),
        userLocal,
      });
    }
    return renderPanel({
      index,
      label: `${item.placementId}  ${item.feasible ? 'feasible' : item.failureReason ?? 'fail'}`,
      target: item.target,
      path: item.pathPoints,
      graph: item.graphLines,
      connector: startConnector(userLocal, item.pathPoints[0]),
      userLocal,
    });
  });
  const height = 420 * Math.max(panels.length, 1) + 80;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 ${height}" width="1100" height="${height}">
  <rect width="100%" height="100%" fill="#f4f3ef"/>
  <text x="16" y="24" font-size="18" font-family="sans-serif">DEVELOPMENT / graph-constrained experimental pipeline</text>
  <text x="16" y="44" font-size="12" font-family="sans-serif" fill="#666">gps ${userLocation.latitude}, ${userLocation.longitude} · search ${searchOrigin.latitude}, ${searchOrigin.longitude} · black dashed = ideal · gray = streets · green = shape route · orange = connector · black dot = user</text>
  ${panels.join('\n')}
</svg>`;
}

function renderPanel(input: {
  index: number;
  label: string;
  target: Vec2[];
  path: Vec2[];
  graph: Vec2[][];
  connector: { points: Vec2[]; lengthMeters: number };
  userLocal: Vec2;
}): string {
  const originY = 80 + input.index * 420;
  const all = [...input.target, ...input.path, ...input.graph.flat(), ...input.connector.points, input.userLocal];
  const xs = all.map((point) => point.x);
  const ys = all.map((point) => point.y);
  const minX = (xs.length ? Math.min(...xs) : 0) - 40;
  const maxX = (xs.length ? Math.max(...xs) : 100) + 40;
  const minY = (ys.length ? Math.min(...ys) : 0) - 40;
  const maxY = (ys.length ? Math.max(...ys) : 100) + 40;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const scale = Math.min(1060 / width, 340 / height);
  const project = (point: Vec2) => ({
    x: 20 + (point.x - minX) * scale,
    y: originY + (maxY - point.y) * scale,
  });
  const toPoints = (line: Vec2[]) =>
    line
      .map((point) => {
        const projected = project(point);
        return `${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
      })
      .join(' ');
  const graph = input.graph
    .filter((line) => line.length >= 2)
    .map((line) => `<polyline points="${toPoints(line)}" fill="none" stroke="#d4cfc6" stroke-width="1.2"/>`)
    .join('\n');
  const target =
    input.target.length >= 2
      ? `<polyline points="${toPoints(input.target)}" fill="none" stroke="#111" stroke-width="3" stroke-dasharray="9 6"/>`
      : '';
  const path =
    input.path.length >= 2
      ? `<polyline points="${toPoints(input.path)}" fill="none" stroke="#2a7" stroke-width="5" stroke-linecap="round"/>`
      : '';
  const connector =
    input.connector.points.length >= 2
      ? `<polyline points="${toPoints(input.connector.points)}" fill="none" stroke="#d9782c" stroke-width="2.5" stroke-dasharray="5 4"/>`
      : '';
  const user = project(input.userLocal);
  const start = input.path[0];
  const end = input.path[input.path.length - 1];
  return `<text x="20" y="${originY - 10}" font-size="14" font-family="sans-serif">${input.label}</text>
${graph}
${target}
${connector}
${path}
<circle cx="${user.x.toFixed(1)}" cy="${user.y.toFixed(1)}" r="5" fill="#111"/>
${start ? `<circle cx="${project(start).x.toFixed(1)}" cy="${project(start).y.toFixed(1)}" r="5" fill="#c45"/>` : ''}
${end ? `<circle cx="${project(end).x.toFixed(1)}" cy="${project(end).y.toFixed(1)}" r="5" fill="#1a6bb5"/>` : ''}`;
}

function fmtCoord(value: Coordinate | null): string {
  if (!value) {
    return 'none';
  }
  return `${value.latitude.toFixed(6)},${value.longitude.toFixed(6)}`;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : 'n/a';
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a';
}
