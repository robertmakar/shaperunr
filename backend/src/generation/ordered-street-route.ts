import type { Coordinate } from '@/lib/geo';
import { selectShapeAnchors } from '@/lib/shape-anchors';
import {
  coordinatesToLocalMeters,
  distanceMeters,
  offsetCoordinate,
  polylineLengthMeters,
} from '@/lib/shape-projection';

import { config } from '../config';
import type { RouteFailure } from '../types';
import {
  locatePedestrianEdgeSets,
  locatePedestrianPoints,
  routePedestrianLeg,
  routeViaBreakLocations,
  ValhallaRequestError,
  type LocateEdgeHit,
  type ValhallaPath,
} from '../routing/valhalla';

export const ORDERED_STREET_ROUTE = {
  shapeSnapRadiusMeters: 35,
  maxSnapDisplacementMeters: 40,
  duplicateAnchorMeters: 15,
  continuationBonusMeters: 18,
  maxContinuationJumpMeters: 160,
  parallelJumpPenaltyMeters: 22,
} as const;

export type OrderedAnchor = {
  input: Coordinate;
  snapped: Coordinate;
  wayId?: number;
  distanceMeters: number;
};

export type OrderedStreetConstruction = {
  method: 'route_breaks';
  anchors: OrderedAnchor[];
  rejectedCount: number;
  targetSampleCount: number;
  meanSnapDistance: number;
  maxSnapDistance: number;
  path: ValhallaPath;
  connectedFromStart: boolean;
  startSnapDistanceMeters: number;
  valhallaCalls: number;
  legCount: number;
  consecutiveDuplicateCount: number;
  immediateReversalRatio: number;
};

export function pickConstrainedSnap(
  edges: readonly LocateEdgeHit[],
  _input: Coordinate,
  previous: OrderedAnchor | null,
  maxDisplacementMeters = ORDERED_STREET_ROUTE.maxSnapDisplacementMeters,
): LocateEdgeHit | null {
  let best: LocateEdgeHit | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const edge of edges) {
    if (edge.distanceMeters > maxDisplacementMeters) {
      continue;
    }
    let score = edge.distanceMeters;
    if (previous) {
      const jump = distanceMeters(previous.snapped, edge.snapped);
      if (previous.wayId != null && edge.wayId != null && previous.wayId === edge.wayId) {
        score -= ORDERED_STREET_ROUTE.continuationBonusMeters;
      } else if (jump <= 80) {
        score -= 6;
      } else if (jump > ORDERED_STREET_ROUTE.maxContinuationJumpMeters) {
        score += ORDERED_STREET_ROUTE.parallelJumpPenaltyMeters;
      } else {
        score += ORDERED_STREET_ROUTE.parallelJumpPenaltyMeters * 0.5;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = edge;
    }
  }

  return best;
}

export function collapseDuplicateAnchors(
  anchors: readonly OrderedAnchor[],
  minDistanceMeters = ORDERED_STREET_ROUTE.duplicateAnchorMeters,
): OrderedAnchor[] {
  const collapsed: OrderedAnchor[] = [];
  for (const anchor of anchors) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && distanceMeters(previous.snapped, anchor.snapped) < minDistanceMeters) {
      continue;
    }
    collapsed.push(anchor);
  }
  return collapsed;
}

export function concatenateRouteCoordinates(legs: Coordinate[][]): Coordinate[] {
  const coordinates: Coordinate[] = [];
  for (const leg of legs) {
    if (leg.length === 0) {
      continue;
    }
    if (coordinates.length === 0) {
      coordinates.push(...leg);
      continue;
    }
    const previous = coordinates[coordinates.length - 1];
    const next = leg[0];
    const skipFirst =
      previous &&
      next &&
      previous.latitude === next.latitude &&
      previous.longitude === next.longitude;
    coordinates.push(...leg.slice(skipFirst ? 1 : 0));
  }
  return removeConsecutiveDuplicateCoordinates(coordinates);
}

export function removeConsecutiveDuplicateCoordinates(coordinates: Coordinate[]): Coordinate[] {
  const cleaned: Coordinate[] = [];
  for (const point of coordinates) {
    const previous = cleaned[cleaned.length - 1];
    if (
      previous &&
      previous.latitude === point.latitude &&
      previous.longitude === point.longitude
    ) {
      continue;
    }
    cleaned.push(point);
  }
  return cleaned;
}

export function immediateReversalRatio(coordinates: Coordinate[]): number {
  if (coordinates.length < 3) {
    return 0;
  }
  let reversing = 0;
  let total = 0;
  for (let index = 2; index < coordinates.length; index += 1) {
    const a = coordinates[index - 2];
    const b = coordinates[index - 1];
    const c = coordinates[index];
    if (!a || !b || !c) {
      continue;
    }
    const from = {
      x: (b.longitude - a.longitude) * 111_320,
      y: (b.latitude - a.latitude) * 111_320,
    };
    const to = {
      x: (c.longitude - b.longitude) * 111_320,
      y: (c.latitude - b.latitude) * 111_320,
    };
    const fromLen = Math.hypot(from.x, from.y);
    const toLen = Math.hypot(to.x, to.y);
    if (fromLen < 1e-6 || toLen < 1e-6) {
      continue;
    }
    total += 1;
    const cos = (from.x * to.x + from.y * to.y) / (fromLen * toLen);
    if (cos <= -0.86) {
      reversing += 1;
    }
  }
  return total === 0 ? 0 : reversing / total;
}

export function selectGeographicAnchors(
  coordinates: Coordinate[],
  origin: Coordinate,
): Coordinate[] {
  if (coordinates.length === 0) {
    return [];
  }
  const local = coordinatesToLocalMeters(origin, coordinates);
  return selectShapeAnchors(local).map((point) => offsetCoordinate(origin, point.x, point.y));
}

export async function constructOrderedStreetRoute(input: {
  start: Coordinate;
  targetCoordinates: Coordinate[];
}): Promise<OrderedStreetConstruction> {
  const geometricAnchors = selectGeographicAnchors(input.targetCoordinates, input.start);
  let valhallaCalls = 0;

  const [startSnap] = await locatePedestrianPoints([input.start], config.startRadiusMeters);
  valhallaCalls += 1;
  if (!startSnap || startSnap.distanceMeters > config.startRadiusMeters) {
    throw new ValhallaRequestError(
      'NO_PEDESTRIAN_NETWORK',
      `No pedestrian-accessible OSM edge within ${config.startRadiusMeters} m of the start point.`,
      422,
      { snapDistanceMeters: startSnap?.distanceMeters },
    );
  }

  const edgeSets = await locatePedestrianEdgeSets(
    geometricAnchors,
    ORDERED_STREET_ROUTE.shapeSnapRadiusMeters,
  );
  valhallaCalls += 1;

  const accepted: OrderedAnchor[] = [];
  let rejectedCount = 0;
  for (const set of edgeSets) {
    const chosen = pickConstrainedSnap(set.edges, set.input, accepted[accepted.length - 1] ?? null);
    if (!chosen) {
      rejectedCount += 1;
      continue;
    }
    accepted.push({
      input: set.input,
      snapped: chosen.snapped,
      wayId: chosen.wayId,
      distanceMeters: chosen.distanceMeters,
    });
  }

  const anchors = collapseDuplicateAnchors(accepted);
  if (anchors.length < 2) {
    throw new ValhallaRequestError(
      'NO_PEDESTRIAN_NETWORK',
      'Too few ordered street anchors survived the tight snap radius.',
      422,
      { accepted: anchors.length, rejectedCount, targetSampleCount: geometricAnchors.length },
    );
  }

  const firstAnchor = anchors[0];
  const needsStartConnector =
    Boolean(firstAnchor) && distanceMeters(startSnap.snapped, firstAnchor.snapped) > 35;
  const routePoints = needsStartConnector
    ? [startSnap.snapped, ...anchors.map((anchor) => anchor.snapped)]
    : anchors.map((anchor) => anchor.snapped);

  let path: ValhallaPath;
  const legCount = routePoints.length - 1;
  try {
    path = await routeViaBreakLocations(routePoints);
    valhallaCalls += 1;
  } catch {
    const sequential = await sequentialBreakLegs(routePoints);
    valhallaCalls += sequential.calls;
    path = sequential.path;
  }

  const beforeClean = path.coordinates.length;
  const coordinates = removeConsecutiveDuplicateCoordinates(path.coordinates);
  path = {
    ...path,
    coordinates,
    distanceMeters: polylineLengthMeters(coordinates),
    method: 'route_breaks',
  };

  const snapDistances = anchors.map((anchor) => anchor.distanceMeters);
  return {
    method: 'route_breaks',
    anchors,
    rejectedCount,
    targetSampleCount: geometricAnchors.length,
    meanSnapDistance: mean(snapDistances),
    maxSnapDistance: Math.max(0, ...snapDistances),
    path,
    connectedFromStart: needsStartConnector,
    startSnapDistanceMeters: startSnap.distanceMeters,
    valhallaCalls,
    legCount,
    consecutiveDuplicateCount: Math.max(0, beforeClean - coordinates.length),
    immediateReversalRatio: immediateReversalRatio(coordinates),
  };
}

export function toConstructionFailure(error: unknown, candidateId?: string): RouteFailure {
  if (error instanceof ValhallaRequestError) {
    return error.toFailure(candidateId);
  }
  return {
    code: 'NO_ROUTE',
    message: error instanceof Error ? error.message : 'Ordered street construction failed.',
    candidateId,
  };
}

async function sequentialBreakLegs(
  points: Coordinate[],
): Promise<{ path: ValhallaPath; calls: number }> {
  const legs: Coordinate[][] = [];
  let calls = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to) {
      continue;
    }
    calls += 1;
    const leg = await routePedestrianLeg(from, to);
    legs.push(leg.coordinates);
  }
  const coordinates = concatenateRouteCoordinates(legs);
  return {
    calls,
    path: {
      coordinates,
      distanceMeters: polylineLengthMeters(coordinates),
      method: 'route_breaks',
    },
  };
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
