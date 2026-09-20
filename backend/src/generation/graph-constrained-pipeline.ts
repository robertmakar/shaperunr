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
import {
  coordinatesToLocalMeters,
  distanceMeters,
  offsetCoordinate,
  polylineLengthMeters,
} from '@/lib/shape-projection';
import { buildWalkableWordShape } from './walkable-target';

import { config } from '../config';
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
  };
};

export type PipelineOptions = {
  collection?: ShapeGraphCollection;
  placements?: StreetFitPlacement[];
  connectStart?: boolean;
  searchOriginSnap?: SearchOriginSnap;
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
  const wordShape = buildWalkableWordShape(input.word);
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
    });
  }

  const COMPARE_PLACEMENT_ID = 'sf-r315-s0.6-e565.7-n565.7';
  const streetFitRankById = new Map(ranked.map((item, index) => [item.placement.id, index]));
  const feasible = feasibility.filter((item) => item.feasible);
  const viable = pickDiverse(feasible.filter((item) => item.pathPoints.length >= 2));
  const toRoute = viable.slice(0, EXPERIMENTAL_PIPELINE.routeTop);
  const viableIds = new Set(viable.map((item) => item.placementId));
  const toRouteIds = new Set(toRoute.map((item) => item.placementId));

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
    };
  });
  const attemptById = new Map(routingAttempts.map((item) => [item.placementId, item]));

  let valhallaRouteCalls = 0;
  const routed: GeneratedRoute[] = [];
  const failures: RouteFailure[] = [];
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

function pipelineStatus(routes: GeneratedRoute[], viableCount: number): PipelineStatus {
  if (routes.length === 0) {
    return viableCount === 0 ? 'no_viable_shape' : 'weak_candidates';
  }
  const strong = routes.some((route) => route.metadata.quality === 'excellent');
  return strong || routes.length > 0 ? 'ok' : 'weak_candidates';
}

function statusSuggestions(word: string, status: PipelineStatus): string[] {
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

function dedupeRoutes(routes: GeneratedRoute[]): GeneratedRoute[] {
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
