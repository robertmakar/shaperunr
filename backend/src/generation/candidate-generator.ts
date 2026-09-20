/**
 * DEVELOPMENT / RESEARCH integration.
 *
 * Builds candidate geographic word shapes, snaps them onto a real Valhalla
 * pedestrian network, scores the returned OSM geometry, and never invents
 * coordinates between streets.
 */

import type { Coordinate } from '@/lib/geo';
import { resamplePolyline } from '@/lib/geometry';
import {
  coordinatesToLocalMeters,
  dimensionsForTargetLength,
  distanceMeters,
  offsetCoordinate,
  polylineLengthMeters,
  projectShapeToGeographic,
} from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

import { config } from '../config';
import { scoreRouteAgainstShape, shapeScoreBreakdown } from '../scoring/shape-match';
import type { GeneratedRoute, GenerateRoutesResponse, RouteFailure } from '../types';
import {
  locatePedestrianPoints,
  routePedestrianLeg,
  routeThroughPedestrianPoints,
  tracePedestrianShape,
  ValhallaRequestError,
  type SnappedPoint,
  type ValhallaPath,
} from '../routing/valhalla';
import { nextCandidateScale, scaleFitsSearchWindow } from './adaptive-scale';
import {
  buildCandidateSpecs,
  CANDIDATE_SEARCH,
  placeShapeCoordinates,
  type CandidateSpec,
} from './candidate-search';

import {
  constructOrderedStreetRoute,
  toConstructionFailure,
} from './ordered-street-route';
import { generateStreetFitExperimentalRoutes } from './street-fit-pipeline';
import { runExperimentalPipeline } from './graph-constrained-pipeline';

const SAMPLE_COUNT = 36;
const ROUTE_THROUGH_MAX_POINTS = 20;
const DEDUPE_METERS = 60;

/** Production generator. Experimental modes are opt-in and must not change `current`. */
export const ROUTE_GENERATION_MODE: 'current' | 'street_fit_experimental' | 'graph_constrained_experimental' =
  'current';

/** Experimental graph-binding. Keep `trace_map_snap` available for comparison. */
export const ROUTE_CONSTRUCTION_STRATEGY: 'trace_map_snap' | 'ordered_breaks' = 'ordered_breaks';

const REAL_ROUTE_WARNING =
  'DEVELOPMENT ONLY — Valhalla pedestrian geometry from OSM. Not shown in Home → Routes → Run.';

export async function generateRealRoutes(input: {
  word: string;
  start: Coordinate;
  targetDistanceMeters: number;
}): Promise<GenerateRoutesResponse> {
  if (ROUTE_GENERATION_MODE === 'street_fit_experimental') {
    return generateStreetFitExperimentalRoutes(input);
  }
  if (ROUTE_GENERATION_MODE === 'graph_constrained_experimental') {
    return runExperimentalPipeline(input);
  }

  const started = Date.now();
  const wordShape = buildWordShape(input.word);
  if (wordShape.points.length < 2) {
    throw new ValhallaRequestError('VALIDATION_ERROR', 'Word did not produce a drawable shape.', 400);
  }

  const baseSize = dimensionsForTargetLength(wordShape, input.targetDistanceMeters);
  if (Math.max(baseSize.widthMeters, baseSize.heightMeters) < 80) {
    throw new ValhallaRequestError(
      'TARGET_TOO_SMALL',
      'Projected word is too small to match against a street network.',
      422,
    );
  }
  if (Math.max(baseSize.widthMeters, baseSize.heightMeters) > 12_000) {
    throw new ValhallaRequestError(
      'TARGET_TOO_LARGE',
      'Projected word is too large for this prototype search window.',
      422,
    );
  }

  const target = projectShapeToGeographic(wordShape.points, {
    center: input.start,
    widthMeters: baseSize.widthMeters,
    heightMeters: baseSize.heightMeters,
    rotationDegrees: 0,
  });

  const specs = buildCandidateSpecs();
  let valhallaCalls = 0;
  let routedAttempts = 0;
  const settled = await mapPool(specs, config.candidateConcurrency, (spec) =>
    evaluateCandidate({
      spec,
      wordShapePoints: wordShape.points,
      start: input.start,
      baseWidthMeters: baseSize.widthMeters,
      baseHeightMeters: baseSize.heightMeters,
      targetDistanceMeters: input.targetDistanceMeters,
    }),
  );

  const routes: GeneratedRoute[] = [];
  const failures: RouteFailure[] = [];

  for (const result of settled) {
    if (!result) {
      continue;
    }
    if (result.status === 'fulfilled') {
      valhallaCalls += result.value.valhallaCalls;
      routedAttempts += result.value.attempts;
      if (result.value.route) {
        routes.push(result.value.route);
      }
      failures.push(...result.value.failures);
    } else {
      failures.push(toFailure(result.reason));
    }
  }

  const ranked = dedupeRoutes([...routes].sort((a, b) => b.shapeScore - a.shapeScore)).slice(
    0,
    config.maxReturnedRoutes,
  );

  return {
    source: 'valhalla',
    developmentOnly: true,
    warning: REAL_ROUTE_WARNING,
    word: wordShape.word,
    wordShape: {
      word: wordShape.word,
      width: wordShape.width,
      height: wordShape.height,
      aspectRatio: wordShape.aspectRatio,
      length: wordShape.length,
    },
    target: {
      coordinates: target.coordinates,
      lengthMeters: target.lengthMeters,
    },
    start: input.start,
    elapsedMs: Date.now() - started,
    routes: ranked,
    failures,
    search: {
      specCount: specs.length,
      rotationCount: CANDIDATE_SEARCH.rotationCount,
      placementCount: 3,
      initialScale: CANDIDATE_SEARCH.initialScale,
      maxAttempts: CANDIDATE_SEARCH.maxAttempts,
      routedAttempts,
      inRangeCandidates: routes.length,
      returnedRoutes: ranked.length,
      valhallaCalls,
    },
  };
}

async function evaluateCandidate(input: {
  spec: CandidateSpec;
  wordShapePoints: { x: number; y: number }[];
  start: Coordinate;
  baseWidthMeters: number;
  baseHeightMeters: number;
  targetDistanceMeters: number;
}): Promise<{
  route: GeneratedRoute | null;
  failures: RouteFailure[];
  valhallaCalls: number;
  attempts: number;
}> {
  const failures: RouteFailure[] = [];
  let scale = input.spec.scale;
  let valhallaCalls = 0;
  let attempts = 0;

  for (let attempt = 1; attempt <= CANDIDATE_SEARCH.maxAttempts; attempt += 1) {
    if (!scaleFitsSearchWindow(input.baseWidthMeters, input.baseHeightMeters, scale)) {
      failures.push({
        code: 'TARGET_TOO_LARGE',
        message: `Adaptive scale ${scale.toFixed(2)} exceeds the prototype search window.`,
        candidateId: input.spec.id,
        details: { scale, attempt },
      });
      break;
    }

    const outcome = await routeCandidateAtScale({
      spec: { ...input.spec, scale },
      wordShapePoints: input.wordShapePoints,
      start: input.start,
      widthMeters: input.baseWidthMeters * scale,
      heightMeters: input.baseHeightMeters * scale,
      targetDistanceMeters: input.targetDistanceMeters,
      attempt,
    });
    attempts += 1;
    valhallaCalls += outcome.diagnostics.valhallaCalls;

    logCandidate(outcome.diagnostics);

    if (outcome.route) {
      return { route: outcome.route, failures, valhallaCalls, attempts };
    }

    failures.push(...outcome.failures);

    if (!outcome.canRetryScale || outcome.actualDistanceMeters == null) {
      break;
    }

    const next = nextCandidateScale({
      currentScale: scale,
      targetDistanceMeters: input.targetDistanceMeters,
      actualDistanceMeters: outcome.actualDistanceMeters,
    });

    if (!next.shouldRetry) {
      break;
    }

    scale = next.scale;
  }

  return { route: null, failures, valhallaCalls, attempts };
}

async function routeCandidateAtScale(input: {
  spec: CandidateSpec;
  wordShapePoints: { x: number; y: number }[];
  start: Coordinate;
  widthMeters: number;
  heightMeters: number;
  targetDistanceMeters: number;
  attempt: number;
}): Promise<{
  route: GeneratedRoute | null;
  failures: RouteFailure[];
  canRetryScale: boolean;
  actualDistanceMeters: number | null;
  diagnostics: CandidateDiagnostics;
}> {
  const projected = projectShapeToGeographic(input.wordShapePoints, {
    center: input.start,
    widthMeters: input.widthMeters,
    heightMeters: input.heightMeters,
    rotationDegrees: input.spec.rotationDegrees,
  });

  const placed = placeShapeCoordinates(projected.coordinates, input.start, input.spec);
  const bbox = geographicBoundingBox(placed);
  const diagnosticsBase: CandidateDiagnostics = {
    candidateId: input.spec.id,
    attempt: input.attempt,
    rotationDegrees: input.spec.rotationDegrees,
    scale: input.spec.scale,
    placement: input.spec.placement,
    offsetAcrossMeters: input.spec.offsetAcrossMeters,
    intendedGeometricLengthMeters: projected.lengthMeters,
    projectedBoundingBox: bbox,
    sampleCount: 0,
    snappedPointsCount: 0,
    snappedLengthMeters: null,
    valhallaDistanceMeters: null,
    shapeScore: null,
    order: null,
    method: null,
    valhallaCalls: 0,
  };

  if (ROUTE_CONSTRUCTION_STRATEGY === 'ordered_breaks') {
    return routeWithOrderedBreaks({
      spec: input.spec,
      start: input.start,
      placed,
      projectedLengthMeters: projected.lengthMeters,
      targetDistanceMeters: input.targetDistanceMeters,
      attempt: input.attempt,
      diagnosticsBase,
    });
  }

  const samples = resampleCoordinates(placed, SAMPLE_COUNT);
  diagnosticsBase.sampleCount = samples.length;

  const locateTargets = [input.start, ...samples];
  const located = await locatePedestrianPoints(
    locateTargets,
    Math.max(config.snapRadiusMeters, config.startRadiusMeters),
  );
  diagnosticsBase.valhallaCalls += 1;

  const startSnap = located[0];
  if (!startSnap || startSnap.distanceMeters > config.startRadiusMeters) {
    return failAttempt(diagnosticsBase, false, null, [
      {
        code: 'NO_PEDESTRIAN_NETWORK',
        message: `No pedestrian-accessible OSM edge within ${config.startRadiusMeters} m of the start point.`,
        candidateId: input.spec.id,
        details: { snapDistanceMeters: startSnap?.distanceMeters },
      },
    ]);
  }

  const shapeSnaps = collapseSnaps(
    located.slice(1).filter((point) => point.distanceMeters <= config.snapRadiusMeters),
  );
  diagnosticsBase.snappedPointsCount = shapeSnaps.length;

  if (shapeSnaps.length < 8) {
    return failAttempt(diagnosticsBase, false, null, [
      {
        code: 'NO_PEDESTRIAN_NETWORK',
        message: 'Too few target samples snapped onto the pedestrian network.',
        candidateId: input.spec.id,
        details: { snapped: shapeSnaps.length, sampled: samples.length },
      },
    ]);
  }

  const snappedShape = shapeSnaps.map((point) => point.snapped);
  diagnosticsBase.snappedLengthMeters = polylineLengthMeters(snappedShape);

  let path: ValhallaPath;
  try {
    path = await tracePedestrianShape(snappedShape);
    diagnosticsBase.valhallaCalls += 1;
  } catch (error) {
    try {
      path = await routeThroughPedestrianPoints(thinPoints(snappedShape, ROUTE_THROUGH_MAX_POINTS));
      diagnosticsBase.valhallaCalls += 2;
    } catch (fallbackError) {
      diagnosticsBase.valhallaCalls += 2;
      return failAttempt(diagnosticsBase, false, null, [
        toFailure(fallbackError, input.spec.id),
        toFailure(error, input.spec.id),
      ]);
    }
  }

  let coordinates = path.coordinates;
  let connectedFromStart = false;
  const first = coordinates[0];
  if (first && distanceMeters(startSnap.snapped, first) > 35) {
    try {
      const connector = await routePedestrianLeg(startSnap.snapped, first);
      diagnosticsBase.valhallaCalls += 1;
      coordinates = joinPaths(connector.coordinates, coordinates);
      connectedFromStart = true;
    } catch (error) {
      diagnosticsBase.valhallaCalls += 1;
      return failAttempt(diagnosticsBase, false, null, [
        {
          code: 'NO_ROUTE',
          message: 'Could not connect the start point to the matched shape on the pedestrian network.',
          candidateId: input.spec.id,
          details: toFailure(error).details,
        },
      ]);
    }
  }

  const distanceMetersValue = polylineLengthMeters(coordinates);
  diagnosticsBase.valhallaDistanceMeters = distanceMetersValue;
  diagnosticsBase.method = path.method;

  const minDistance = input.targetDistanceMeters * (1 - config.distanceToleranceRatio);
  const maxDistance = input.targetDistanceMeters * (1 + config.distanceToleranceRatio);
  if (distanceMetersValue < minDistance || distanceMetersValue > maxDistance) {
    return failAttempt(
      diagnosticsBase,
      true,
      distanceMetersValue,
      [
        {
          code: 'DISTANCE_OUT_OF_RANGE',
          message: `Route length ${Math.round(distanceMetersValue)} m is outside ${Math.round(minDistance)}–${Math.round(maxDistance)} m.`,
          candidateId: input.spec.id,
          details: {
            distanceMeters: distanceMetersValue,
            intendedGeometricLengthMeters: projected.lengthMeters,
            snappedLengthMeters: diagnosticsBase.snappedLengthMeters,
            minDistance,
            maxDistance,
            scale: input.spec.scale,
            attempt: input.attempt,
          },
        },
      ],
    );
  }

  const score = scoreRouteAgainstShape(coordinates, placed);
  diagnosticsBase.shapeScore = score.score;
  diagnosticsBase.order = score.breakdown.order;
  logConstruction({
    candidateId: input.spec.id,
    rotationDegrees: input.spec.rotationDegrees,
    scale: input.spec.scale,
    placement: input.spec.placement,
    targetLength: projected.lengthMeters,
    anchorCount: shapeSnaps.length,
    meanSnapDistance: mean(shapeSnaps.map((point) => point.distanceMeters)),
    maxSnapDistance: Math.max(0, ...shapeSnaps.map((point) => point.distanceMeters)),
    routeLength: distanceMetersValue,
    legCount: 1,
    backtrackRatio: score.details.backtrackRatio,
    shapeScore: score.score,
    orderScore: score.breakdown.order,
    coverage: score.coverage,
    anchors: shapeSnaps.map((point) => point.snapped),
  });

  return {
    route: {
      id: input.spec.id,
      source: 'valhalla',
      developmentOnly: true,
      coordinates,
      targetCoordinates: placed,
      distanceMeters: distanceMetersValue,
      shapeScore: score.score,
      coverage: score.coverage,
      scoreBreakdown: shapeScoreBreakdown(score),
      metadata: {
        rotationDegrees: input.spec.rotationDegrees,
        scale: input.spec.scale,
        placement: input.spec.placement,
        offsetAcrossMeters: input.spec.offsetAcrossMeters,
        method: path.method,
        connectedFromStart,
        startSnapDistanceMeters: startSnap.distanceMeters,
        lengthError: score.lengthError,
        distanceError: score.distanceError,
        detourRatio: score.details.detourRatio,
        backtrackRatio: score.details.backtrackRatio,
        score,
      },
    },
    failures: [],
    canRetryScale: false,
    actualDistanceMeters: distanceMetersValue,
    diagnostics: diagnosticsBase,
  };
}

async function routeWithOrderedBreaks(input: {
  spec: CandidateSpec;
  start: Coordinate;
  placed: Coordinate[];
  projectedLengthMeters: number;
  targetDistanceMeters: number;
  attempt: number;
  diagnosticsBase: CandidateDiagnostics;
}) {
  try {
    const construction = await constructOrderedStreetRoute({
      start: input.start,
      targetCoordinates: input.placed,
    });
    input.diagnosticsBase.valhallaCalls = construction.valhallaCalls;
    input.diagnosticsBase.sampleCount = construction.targetSampleCount;
    input.diagnosticsBase.snappedPointsCount = construction.anchors.length;
    input.diagnosticsBase.snappedLengthMeters = polylineLengthMeters(
      construction.anchors.map((anchor) => anchor.snapped),
    );
    input.diagnosticsBase.valhallaDistanceMeters = construction.path.distanceMeters;
    input.diagnosticsBase.method = construction.path.method;

    const coordinates = construction.path.coordinates;
    const distanceMetersValue = construction.path.distanceMeters;
    const minDistance = input.targetDistanceMeters * (1 - config.distanceToleranceRatio);
    const maxDistance = input.targetDistanceMeters * (1 + config.distanceToleranceRatio);
    if (distanceMetersValue < minDistance || distanceMetersValue > maxDistance) {
      logConstruction({
        candidateId: input.spec.id,
        rotationDegrees: input.spec.rotationDegrees,
        scale: input.spec.scale,
        placement: input.spec.placement,
        targetLength: input.projectedLengthMeters,
        anchorCount: construction.anchors.length,
        rejectedCount: construction.rejectedCount,
        meanSnapDistance: construction.meanSnapDistance,
        maxSnapDistance: construction.maxSnapDistance,
        routeLength: distanceMetersValue,
        legCount: construction.legCount,
        backtrackRatio: construction.immediateReversalRatio,
        shapeScore: null,
        orderScore: null,
        coverage: null,
        anchors: construction.anchors.map((anchor) => anchor.snapped),
      });
      return failAttempt(input.diagnosticsBase, true, distanceMetersValue, [
        {
          code: 'DISTANCE_OUT_OF_RANGE',
          message: `Route length ${Math.round(distanceMetersValue)} m is outside ${Math.round(minDistance)}–${Math.round(maxDistance)} m.`,
          candidateId: input.spec.id,
          details: {
            distanceMeters: distanceMetersValue,
            intendedGeometricLengthMeters: input.projectedLengthMeters,
            snappedLengthMeters: input.diagnosticsBase.snappedLengthMeters,
            minDistance,
            maxDistance,
            scale: input.spec.scale,
            attempt: input.attempt,
            rejectedCount: construction.rejectedCount,
          },
        },
      ]);
    }

    const score = scoreRouteAgainstShape(coordinates, input.placed);
    input.diagnosticsBase.shapeScore = score.score;
    input.diagnosticsBase.order = score.breakdown.order;
    logConstruction({
      candidateId: input.spec.id,
      rotationDegrees: input.spec.rotationDegrees,
      scale: input.spec.scale,
      placement: input.spec.placement,
      targetLength: input.projectedLengthMeters,
      anchorCount: construction.anchors.length,
      rejectedCount: construction.rejectedCount,
      meanSnapDistance: construction.meanSnapDistance,
      maxSnapDistance: construction.maxSnapDistance,
      routeLength: distanceMetersValue,
      legCount: construction.legCount,
      backtrackRatio: score.details.backtrackRatio,
      shapeScore: score.score,
      orderScore: score.breakdown.order,
      coverage: score.coverage,
      anchors: construction.anchors.map((anchor) => anchor.snapped),
    });

    return {
      route: {
        id: input.spec.id,
        source: 'valhalla' as const,
        developmentOnly: true as const,
        coordinates,
        targetCoordinates: input.placed,
        distanceMeters: distanceMetersValue,
        shapeScore: score.score,
        coverage: score.coverage,
        scoreBreakdown: shapeScoreBreakdown(score),
        metadata: {
          rotationDegrees: input.spec.rotationDegrees,
          scale: input.spec.scale,
          placement: input.spec.placement,
          offsetAcrossMeters: input.spec.offsetAcrossMeters,
          method: construction.path.method,
          connectedFromStart: construction.connectedFromStart,
          startSnapDistanceMeters: construction.startSnapDistanceMeters,
          lengthError: score.lengthError,
          distanceError: score.distanceError,
          detourRatio: score.details.detourRatio,
          backtrackRatio: score.details.backtrackRatio,
          score,
        },
      },
      failures: [],
      canRetryScale: false,
      actualDistanceMeters: distanceMetersValue,
      diagnostics: input.diagnosticsBase,
    };
  } catch (error) {
    return failAttempt(input.diagnosticsBase, false, null, [
      toConstructionFailure(error, input.spec.id),
    ]);
  }
}

function logConstruction(entry: {
  candidateId: string;
  rotationDegrees: number;
  scale: number;
  placement: string;
  targetLength: number;
  anchorCount: number;
  rejectedCount?: number;
  meanSnapDistance: number;
  maxSnapDistance: number;
  routeLength: number;
  legCount: number;
  backtrackRatio: number;
  shapeScore: number | null;
  orderScore: number | null;
  coverage: number | null;
  anchors: Coordinate[];
}) {
  const compactAnchors = entry.anchors.map((point) => [
    Number(point.latitude.toFixed(5)),
    Number(point.longitude.toFixed(5)),
  ]);
  console.info(
    '[shaperunr:construction]',
    JSON.stringify({
      candidateId: entry.candidateId,
      rotation: entry.rotationDegrees,
      scale: Number(entry.scale.toFixed(4)),
      placement: entry.placement,
      targetLength: Math.round(entry.targetLength),
      anchorCount: entry.anchorCount,
      rejectedCount: entry.rejectedCount ?? 0,
      meanSnapDistance: Number(entry.meanSnapDistance.toFixed(1)),
      maxSnapDistance: Number(entry.maxSnapDistance.toFixed(1)),
      routeLength: Math.round(entry.routeLength),
      legCount: entry.legCount,
      backtrackRatio: Number(entry.backtrackRatio.toFixed(3)),
      shapeScore: entry.shapeScore == null ? null : Number(entry.shapeScore.toFixed(4)),
      orderScore: entry.orderScore == null ? null : Number(entry.orderScore.toFixed(4)),
      coverage: entry.coverage == null ? null : Number(entry.coverage.toFixed(3)),
      anchors: compactAnchors,
    }),
  );
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

type CandidateDiagnostics = {
  candidateId: string;
  attempt: number;
  rotationDegrees: number;
  scale: number;
  placement: CandidateSpec['placement'];
  offsetAcrossMeters: number;
  intendedGeometricLengthMeters: number;
  projectedBoundingBox: {
    minLatitude: number;
    maxLatitude: number;
    minLongitude: number;
    maxLongitude: number;
  } | null;
  sampleCount: number;
  snappedPointsCount: number;
  snappedLengthMeters: number | null;
  valhallaDistanceMeters: number | null;
  shapeScore: number | null;
  order: number | null;
  method: ValhallaPath['method'] | null;
  valhallaCalls: number;
};

function failAttempt(
  diagnostics: CandidateDiagnostics,
  canRetryScale: boolean,
  actualDistanceMeters: number | null,
  failures: RouteFailure[],
) {
  return {
    route: null,
    failures,
    canRetryScale,
    actualDistanceMeters,
    diagnostics,
  };
}

function logCandidate(diagnostics: CandidateDiagnostics) {
  console.info('[shaperunr:candidate]', JSON.stringify(diagnostics));
}

function geographicBoundingBox(coordinates: Coordinate[]) {
  if (coordinates.length === 0) {
    return null;
  }

  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;

  for (const point of coordinates) {
    minLatitude = Math.min(minLatitude, point.latitude);
    maxLatitude = Math.max(maxLatitude, point.latitude);
    minLongitude = Math.min(minLongitude, point.longitude);
    maxLongitude = Math.max(maxLongitude, point.longitude);
  }

  return { minLatitude, maxLatitude, minLongitude, maxLongitude };
}

function resampleCoordinates(coordinates: Coordinate[], sampleCount: number): Coordinate[] {
  const origin = coordinates[0];
  if (!origin) {
    return [];
  }
  return resamplePolyline(coordinatesToLocalMeters(origin, coordinates), sampleCount).map((point) =>
    offsetCoordinate(origin, point.x, point.y),
  );
}

function collapseSnaps(points: SnappedPoint[]): SnappedPoint[] {
  const collapsed: SnappedPoint[] = [];
  for (const point of points) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && distanceMeters(previous.snapped, point.snapped) < 18) {
      continue;
    }
    collapsed.push(point);
  }
  return collapsed;
}

function thinPoints(points: Coordinate[], maxCount: number): Coordinate[] {
  if (points.length <= maxCount) {
    return points;
  }
  return resampleCoordinates(points, maxCount);
}

function joinPaths(first: Coordinate[], second: Coordinate[]): Coordinate[] {
  if (first.length === 0) {
    return second;
  }
  if (second.length === 0) {
    return first;
  }
  return [...first, ...second.slice(1)];
}

function dedupeRoutes(routes: GeneratedRoute[]): GeneratedRoute[] {
  const unique: GeneratedRoute[] = [];
  for (const route of routes) {
    const duplicate = unique.find(
      (existing) =>
        Math.abs(existing.distanceMeters - route.distanceMeters) / Math.max(existing.distanceMeters, 1) < 0.08 &&
        meanNearestDistance(existing.coordinates, route.coordinates) < DEDUPE_METERS,
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
  const samples = resampleCoordinates(a, 20);
  const total = samples.reduce((sum, point) => {
    let min = Number.POSITIVE_INFINITY;
    for (const other of b) {
      min = Math.min(min, distanceMeters(point, other));
    }
    return sum + min;
  }, 0);
  return total / samples.length;
}

function toFailure(error: unknown, candidateId?: string): RouteFailure {
  if (error instanceof ValhallaRequestError) {
    return error.toFailure(candidateId);
  }
  return {
    code: 'NO_ROUTE',
    message: error instanceof Error ? error.message : 'Candidate evaluation failed.',
    candidateId,
  };
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      try {
        const value = await worker(item, index);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => run());
  await Promise.all(workers);
  return results;
}
