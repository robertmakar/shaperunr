import type { Coordinate } from '@/lib/geo';
import {
  boundingBox2,
  distanceToPolyline,
  headingRadians,
  polylineLength,
  resamplePolyline,
  shortestAngleDelta,
  type Vec2,
} from '@/lib/geometry';
import { scoreOrderedPath, type OrderMatchDetails } from '@/lib/shape-order';
import {
  coordinatesToLocalMeters,
  polylineLengthMeters,
} from '@/lib/shape-projection';

export type ShapeMatchOptions = {
  sampleCount?: number;
  /** Target samples within this many meters of the candidate count as covered. */
  coverageThresholdMeters?: number;
  /** Mean chamfer at-or-above this distance contributes a proximity of 0. */
  maxDistanceErrorMeters?: number;
  reverseThresholdDegrees?: number;
  weights?: Partial<ShapeMatchWeights>;
};

export type ShapeMatchWeights = {
  proximity: number;
  coverage: number;
  order: number;
  length: number;
  detour: number;
  backtrack: number;
};

export type ShapeMatchComponents = {
  proximity: number;
  coverage: number;
  order: number;
  lengthFit: number;
  detourFit: number;
  continuity: number;
};

export type ShapeScoreBreakdown = {
  proximity: number;
  coverage: number;
  order: number;
  lengthFit: number;
  detour: number;
  backtrack: number;
  finalScore: number;
};

export type ShapeMatchResult = {
  score: number;
  distanceError: number;
  coverage: number;
  lengthError: number;
  breakdown: ShapeScoreBreakdown;
  details: {
    chamferTargetToRoute: number;
    chamferRouteToTarget: number;
    hausdorffApprox: number;
    detourRatio: number;
    backtrackRatio: number;
    routeLengthMeters: number;
    targetLengthMeters: number;
    sampleCount: number;
    coverageThresholdMeters: number;
    components: ShapeMatchComponents;
    weights: ShapeMatchWeights;
    order: OrderMatchDetails;
  };
};

/**
 * Order is the largest weight because geographic proximity/coverage alone
 * cannot tell a drawn word from a route that merely visits the same area.
 * Existing metrics are preserved; they no longer dominate the total.
 */
export const DEFAULT_WEIGHTS: ShapeMatchWeights = {
  proximity: 0.18,
  coverage: 0.16,
  order: 0.34,
  length: 0.14,
  detour: 0.09,
  backtrack: 0.09,
};

const DEFAULT_SAMPLE_COUNT = 80;

export function shapeScoreBreakdown(result: ShapeMatchResult): ShapeScoreBreakdown {
  return result.breakdown;
}

export function scoreRouteAgainstShape(
  routeCoordinates: Coordinate[],
  targetShape: Coordinate[],
  options: ShapeMatchOptions = {},
): ShapeMatchResult {
  const origin = targetShape[0] ?? routeCoordinates[0] ?? { latitude: 0, longitude: 0 };
  return scorePolylines(
    coordinatesToLocalMeters(origin, routeCoordinates),
    coordinatesToLocalMeters(origin, targetShape),
    {
      routeLengthMeters: polylineLengthMeters(routeCoordinates),
      targetLengthMeters: polylineLengthMeters(targetShape),
    },
    options,
  );
}

export function scorePolylines(
  route: readonly Vec2[],
  target: readonly Vec2[],
  lengths?: { routeLengthMeters?: number; targetLengthMeters?: number },
  options: ShapeMatchOptions = {},
): ShapeMatchResult {
  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const routeLength = lengths?.routeLengthMeters ?? polylineLength(route);
  const targetLength = lengths?.targetLengthMeters ?? polylineLength(target);
  const targetBox = boundingBox2(target);
  const minSpan = Math.min(targetBox?.width ?? targetLength, targetBox?.height ?? targetLength);
  const coverageThreshold =
    options.coverageThresholdMeters ?? Math.max(18, Math.min(minSpan * 0.22, targetLength * 0.025));
  const maxDistanceError =
    options.maxDistanceErrorMeters ?? Math.max(35, Math.min(minSpan * 0.45, targetLength * 0.08));
  const reverseThreshold =
    ((options.reverseThresholdDegrees ?? 150) * Math.PI) / 180;
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const orderDistanceScale = Math.max(minSpan * 0.25, targetLength * 0.04, 1e-6);

  const sampledRoute = resamplePolyline(route, sampleCount);
  const sampledTarget = resamplePolyline(target, sampleCount);

  const targetToRoute = meanMinDistance(sampledTarget, route);
  const routeToTarget = meanMinDistance(sampledRoute, target);
  const distanceError = (targetToRoute + routeToTarget) / 2;
  const hausdorffApprox = Math.max(
    maxMinDistance(sampledTarget, route),
    maxMinDistance(sampledRoute, target),
  );

  const covered = sampledTarget.filter((point) => distanceToPolyline(point, route) <= coverageThreshold)
    .length;
  const coverage = sampledTarget.length === 0 ? 0 : covered / sampledTarget.length;
  const lengthError =
    targetLength === 0 ? (routeLength === 0 ? 0 : 1) : Math.abs(routeLength - targetLength) / targetLength;
  const detourRatio = targetLength === 0 ? 0 : Math.max(0, routeLength / targetLength - 1);
  const backtrackRatio = reverseRatio(route, reverseThreshold);
  const orderDetails = scoreOrderedPath(sampledRoute, sampledTarget, target, {
    orderDistanceScale,
    coverageThreshold,
  });

  const components: ShapeMatchComponents = {
    proximity: clamp01(1 - distanceError / maxDistanceError),
    coverage,
    order: orderDetails.order,
    lengthFit: clamp01(1 - lengthError),
    detourFit: clamp01(1 - detourRatio),
    continuity: clamp01(1 - backtrackRatio),
  };

  const weightTotal =
    weights.proximity +
    weights.coverage +
    weights.order +
    weights.length +
    weights.detour +
    weights.backtrack;
  const score =
    weightTotal === 0
      ? 0
      : clamp01(
          (components.proximity * weights.proximity +
            components.coverage * weights.coverage +
            components.order * weights.order +
            components.lengthFit * weights.length +
            components.detourFit * weights.detour +
            components.continuity * weights.backtrack) /
            weightTotal,
        );

  const breakdown: ShapeScoreBreakdown = {
    proximity: components.proximity,
    coverage: components.coverage,
    order: components.order,
    lengthFit: components.lengthFit,
    detour: components.detourFit,
    backtrack: components.continuity,
    finalScore: score,
  };

  return {
    score,
    distanceError,
    coverage,
    lengthError,
    breakdown,
    details: {
      chamferTargetToRoute: targetToRoute,
      chamferRouteToTarget: routeToTarget,
      hausdorffApprox,
      detourRatio,
      backtrackRatio,
      routeLengthMeters: routeLength,
      targetLengthMeters: targetLength,
      sampleCount,
      coverageThresholdMeters: coverageThreshold,
      components,
      weights,
      order: orderDetails,
    },
  };
}

function meanMinDistance(points: readonly Vec2[], polyline: readonly Vec2[]): number {
  if (points.length === 0) {
    return 0;
  }
  const total = points.reduce((sum, point) => sum + distanceToPolyline(point, polyline), 0);
  return total / points.length;
}

function maxMinDistance(points: readonly Vec2[], polyline: readonly Vec2[]): number {
  let max = 0;
  for (const point of points) {
    max = Math.max(max, distanceToPolyline(point, polyline));
  }
  return max;
}

function reverseRatio(points: readonly Vec2[], reverseThreshold: number): number {
  if (points.length < 3) {
    return 0;
  }

  let reversing = 0;
  let total = 0;
  for (let index = 2; index < points.length; index += 1) {
    const a = points[index - 2];
    const b = points[index - 1];
    const c = points[index];
    if (!a || !b || !c) {
      continue;
    }
    const segment = Math.hypot(c.x - b.x, c.y - b.y);
    if (segment === 0) {
      continue;
    }
    total += segment;
    const turn = Math.abs(shortestAngleDelta(headingRadians(a, b), headingRadians(b, c)));
    if (turn >= reverseThreshold) {
      reversing += segment;
    }
  }

  return total === 0 ? 0 : reversing / total;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
