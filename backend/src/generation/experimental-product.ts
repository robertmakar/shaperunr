/**
 * DEVELOPMENT ONLY. Product-facing acceptance for experimental routes.
 *
 * This is NOT the graph-search score and NOT the existing shape-match
 * `acceptableShapeScore` (0.58) used inside the pipeline.
 *
 * Proven Cairo cases (2026-09-18):
 * - L Zamalek 2500 m: score 0.908, coverage 0.88, order 0.878 → accept
 * - Z north Cairo 2500 m: score 0.842, coverage 0.81, order 0.772 → accept
 * - O Zamalek 1500 m: score 0.604, coverage 0.45, order 0.346 → reject
 *   (rectangular block loop, not a round O)
 * - ROBZ downtown 4000 m: connected graph paths can exist, but they are
 *   short street scribbles (measured 994 m shape vs 4000 m target, order
 *   barely 0.61). That is not a genuine ROBZ. Do not treat it as coverage.
 */
import type { Coordinate } from '@/lib/geo';

import type { GeneratedRoute, GenerateRoutesResponse } from '../types';
import {
  analyzeGeneratedRouteIdentity,
  type ProductIdentityContext,
  type TargetIdentity,
} from './target-identity';

export const EXPERIMENTAL_PRODUCT = {
  minShapeScore: 0.7,
  minCoverage: 0.58,
  minOrder: 0.6,
  maxBacktrack: 0.25,
  maxLargestGap: 0.32,
  /**
   * Connected target-progress traversal. Measured: full L/Z ≈ 0.9–1.0;
   * first-letter ROBZ scribble ≈ 0.29; isolated endpoints ≈ 0.04.
   */
  minTargetSpan: 0.55,
  /**
   * Shape path vs requested distance. Measured good L/Z/O typically ≥ 0.38;
   * downtown ROBZ false positive ≈ 0.25.
   */
  minLengthRatio: 0.32,
} as const;

export type ExperimentalUserRoute = {
  id: string;
  shapeCoordinates: Coordinate[];
  fullRouteCoordinates: Coordinate[];
  connectorCoordinates: Coordinate[];
  shapeDistance: number;
  connectorDistance: number;
  totalDistance: number;
  shapeScore: number;
  coverage: number;
  order: number;
  heading: number;
  backtrack: number;
  placement: {
    eastMeters: number;
    northMeters: number;
  };
  rotation: number;
  scale: number;
  distanceFromUser: number;
};

export type ExperimentalGenerateRoutesResponse = {
  status: 'ok' | 'no_viable_shape';
  word: string;
  targetDistance: number;
  routes: ExperimentalUserRoute[];
  message?: string;
};

export type ProductThresholdContext = ProductIdentityContext & {
  skipIdentity?: boolean;
};

export type ProductRuleName =
  | 'connected'
  | 'shapeScore'
  | 'coverage'
  | 'order'
  | 'backtrack'
  | 'largestGap'
  | 'targetSpan'
  | 'lengthRatio'
  | 'wordTraversal';

export function experimentalProductRejectionReasons(
  route: GeneratedRoute,
  context: ProductThresholdContext = {},
): ProductRuleName[] {
  const reasons: ProductRuleName[] = [];
  const connected = route.metadata.connected ?? (route.shapeCoordinates?.length ?? 0) >= 2;
  const gap = route.metadata.largestGap ?? 1;
  if (!connected) reasons.push('connected');
  if (route.shapeScore < EXPERIMENTAL_PRODUCT.minShapeScore) reasons.push('shapeScore');
  if (route.coverage < EXPERIMENTAL_PRODUCT.minCoverage) reasons.push('coverage');
  if (route.scoreBreakdown.order < EXPERIMENTAL_PRODUCT.minOrder) reasons.push('order');
  if (route.metadata.backtrackRatio > EXPERIMENTAL_PRODUCT.maxBacktrack) reasons.push('backtrack');
  if (gap > EXPERIMENTAL_PRODUCT.maxLargestGap) reasons.push('largestGap');
  if (context.skipIdentity || (route.targetCoordinates?.length ?? 0) < 2) {
    return reasons;
  }
  const identity = identityFor(route, context);
  if (!identity) {
    return reasons;
  }
  if (identity.targetSpan < EXPERIMENTAL_PRODUCT.minTargetSpan) {
    reasons.push('targetSpan');
  }
  const lengthRatio =
    identity.lengthRatioRequested ??
    identity.lengthRatioProjected;
  if (lengthRatio < EXPERIMENTAL_PRODUCT.minLengthRatio) {
    reasons.push('lengthRatio');
  }
  if ((context.word?.replace(/[^A-Za-z]/g, '').length ?? 0) > 1 && !identity.traversesMostOfWord) {
    reasons.push('wordTraversal');
  }
  return reasons;
}

export function meetsExperimentalProductThreshold(
  route: GeneratedRoute,
  context: ProductThresholdContext = {},
): boolean {
  return experimentalProductRejectionReasons(route, context).length === 0;
}

export function toExperimentalUserRoute(route: GeneratedRoute): ExperimentalUserRoute {
  const shapeCoordinates = route.shapeCoordinates ?? [];
  const connectorCoordinates = route.connectorCoordinates ?? [];
  return {
    id: route.id,
    shapeCoordinates: shapeCoordinates.length >= 2 ? shapeCoordinates : route.coordinates,
    fullRouteCoordinates: route.coordinates,
    connectorCoordinates,
    shapeDistance: route.metadata.shapeRouteDistanceMeters ?? shapeLengthFallback(route),
    connectorDistance: route.metadata.connectorDistanceMeters ?? 0,
    totalDistance: route.metadata.totalDistanceMeters ?? route.distanceMeters,
    shapeScore: route.shapeScore,
    coverage: route.coverage,
    order: route.scoreBreakdown.order,
    heading: route.metadata.headingAgreementDegrees ?? 0,
    backtrack: route.metadata.backtrackRatio,
    placement: {
      eastMeters: route.metadata.eastMeters ?? 0,
      northMeters: route.metadata.northMeters ?? 0,
    },
    rotation: route.metadata.rotationDegrees,
    scale: route.metadata.scale,
    distanceFromUser: route.metadata.distanceFromUserMeters ?? route.metadata.offsetAcrossMeters,
  };
}

export function toExperimentalUserResponse(
  report: Pick<GenerateRoutesResponse, 'word' | 'routes'>,
  targetDistance: number,
): ExperimentalGenerateRoutesResponse {
  const context = { word: report.word, targetDistance };
  const routes = report.routes
    .filter((route) => meetsExperimentalProductThreshold(route, context))
    .map(toExperimentalUserRoute);
  if (routes.length === 0) {
    return {
      status: 'no_viable_shape',
      word: report.word,
      targetDistance,
      routes: [],
      message: 'No strong walkable match was found nearby.',
    };
  }
  return {
    status: 'ok',
    word: report.word,
    targetDistance,
    routes,
  };
}

function identityFor(route: GeneratedRoute, context: ProductThresholdContext): TargetIdentity | null {
  const shape = route.shapeCoordinates ?? route.coordinates;
  if (shape.length < 2 || route.targetCoordinates.length < 2) {
    return null;
  }
  const identity = analyzeGeneratedRouteIdentity(route, {
    word: context.word ?? '',
    targetDistance: context.targetDistance ?? 0,
  });
  const reported = route.metadata.shapeRouteDistanceMeters;
  if (reported && reported > 0) {
    identity.routeLengthMeters = reported;
    identity.lengthRatioRequested =
      context.targetDistance && context.targetDistance > 0 ? reported / context.targetDistance : identity.lengthRatioRequested;
  }
  return identity;
}

function shapeLengthFallback(route: GeneratedRoute): number {
  const total = route.metadata.totalDistanceMeters ?? route.distanceMeters;
  const connector = route.metadata.connectorDistanceMeters ?? 0;
  return Math.max(0, total - connector);
}
