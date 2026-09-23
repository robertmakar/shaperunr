/**
 * Product-facing acceptance for experimental routes — this IS the live
 * production gate used by POST /generate-routes-experimental.
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
 *
 * LAYERED GATE (implemented after a multi-task diagnostic investigation —
 * see backend/src/diagnostics/{shadow-layered-gate,recalibrated-order,
 * target-span-decomposition,continuity-decomposition}-diagnostic.ts for the
 * full evidence trail). The gate is now:
 *
 *   physicalPass AND completenessPass AND sequenceValid
 *
 * where physicalPass = connected + shapeScore + coverage + backtrack +
 * largestGap + lengthRatio (all UNCHANGED thresholds/formulas) + continuity
 * (NEW hard gate — validated as sufficient replacement for targetSpan's
 * intended connectivity-protection role); completenessPass/sequenceValid
 * are the independently-validated letter-completeness and chronological-
 * sequence-integrity evaluators (replacing wordTraversal's semantic role,
 * multi-letter words only, exactly mirroring wordTraversal's own historic
 * single-letter carve-out). Whole-route order (raw, in `scoreBreakdown`)
 * remains available for display/diagnostics but is no longer a hard gate —
 * `order >= 0.60` is REMOVED as a rejection condition. targetSpan is
 * REMOVED as a hard gate (see `EXPERIMENTAL_PRODUCT.minTargetSpan`'s own
 * comment) but its threshold constant is retained for diagnostics.
 *
 * Every semantic/continuity primitive below is imported, unmodified, from
 * the diagnostic modules that independently validated it across the
 * investigation — this file does not reimplement any of that logic.
 */
import type { Coordinate } from '@/lib/geo';
import type { Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import type { GeneratedRoute, GenerateRoutesResponse } from '../types';
import {
  analyzeGeneratedRouteIdentity,
  type ProductIdentityContext,
  type TargetIdentity,
} from './target-identity';
import {
  assignRouteSamplesToLetters,
  deriveVisitationBlocks,
  deriveObservedSequence,
  evaluateSequenceIntegrity,
  computeVisitationConfidence,
  wordLetters,
} from '../diagnostics/letter-sequence-integrity-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from '../diagnostics/physical-word-traversal-evaluator';
import { evaluateLetterCompleteness } from '../diagnostics/shadow-layered-gate-diagnostic';
import { extractLetterRouteSpans, computeTransitionRecord, type TransitionRecord } from '../diagnostics/inter-letter-continuity-diagnostic';
import { evaluateContinuity, SHADOW_CONTINUITY_DEFAULTS } from '../diagnostics/shadow-product-gate-evaluator';
import { computeRecalibratedOrderModels } from '../diagnostics/recalibrated-order-diagnostic';

export const EXPERIMENTAL_PRODUCT = {
  minShapeScore: 0.7,
  minCoverage: 0.58,
  /**
   * No longer used as a hard-gate threshold (see the layered-gate header
   * comment above) — whole-route order is a supporting/diagnostic signal
   * only. Retained so existing diagnostics that reference it keep working.
   */
  minOrder: 0.6,
  maxBacktrack: 0.25,
  maxLargestGap: 0.32,
  /**
   * No longer used as a hard-gate threshold. The targetSpan diagnostic
   * investigation found it near-zero-correlated with meaningful physical
   * quality, sample-count-fragile, and responsible for 8/78 false
   * rejections of physical+semantic-valid routes on the deterministic
   * corpus, with continuity independently proven sufficient to replace its
   * intended connectivity-protection role (0/78 cases where targetSpan
   * caught something continuity missed). Retained for diagnostics only.
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
  | 'backtrack'
  | 'largestGap'
  | 'lengthRatio'
  | 'continuity'
  | 'completeness'
  | 'sequenceIntegrity'
  /**
   * No longer produced by experimentalProductRejectionReasons() — order is
   * a supporting/diagnostic signal only (see the layered-gate header
   * comment). Retained in this union purely so pre-existing standalone
   * diagnostic scripts that independently construct their own
   * ProductRuleName[] arrays (e.g. to compare against the old gate) still
   * type-check; those scripts are unaffected by this change.
   */
  | 'order'
  /** No longer produced — see EXPERIMENTAL_PRODUCT.minTargetSpan's comment. Retained for the same backward-compatibility reason as 'order'. */
  | 'targetSpan'
  /** No longer produced — replaced by 'completeness' + 'sequenceIntegrity'. Retained for the same backward-compatibility reason as 'order'. */
  | 'wordTraversal';

/** Converts a route's geo coordinates + target to local-meters Vec2 arrays, the representation every semantic/continuity evaluator below operates on. Mirrors analyzeGeneratedRouteIdentity's own conversion exactly (same shape/origin selection) so results are consistent with the identity metrics computed alongside them. */
function localGeometryFor(route: GeneratedRoute): { route: Vec2[]; target: Vec2[]; geometryVariant: LetterShapeVariant } | null {
  const shape = route.shapeCoordinates ?? route.coordinates;
  if (shape.length < 2 || route.targetCoordinates.length < 2) {
    return null;
  }
  const origin = route.targetCoordinates[0] ?? shape[0] ?? { latitude: 0, longitude: 0 };
  return {
    route: coordinatesToLocalMeters(origin, shape),
    target: coordinatesToLocalMeters(origin, route.targetCoordinates),
    geometryVariant: route.metadata.geometryVariant ?? 'smooth',
  };
}

/** Inter-letter route-space continuity — reuses extractLetterRouteSpans/computeTransitionRecord/evaluateContinuity unmodified. A no-op (trivially valid) for single-letter words, since no inter-letter transitions exist to measure. */
function evaluateRouteContinuity(word: string, geometry: NonNullable<ReturnType<typeof localGeometryFor>>): boolean {
  const { spans, sampledRoute } = extractLetterRouteSpans(word, geometry.target, geometry.route, geometry.geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  // Read lazily (not at module top level) to avoid a circular-import TDZ
  // failure: shadow-product-gate-evaluator.ts itself imports
  // EXPERIMENTAL_PRODUCT from this file, so SHADOW_CONTINUITY_DEFAULTS must
  // only be dereferenced from inside a function body, never from this
  // file's own top-level EXPERIMENTAL_PRODUCT object literal.
  return evaluateContinuity(transitions, SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio).continuityValid;
}

/** Letter completeness + chronological sequence integrity — reuses assignRouteSamplesToLetters/deriveVisitationBlocks/deriveObservedSequence/evaluateSequenceIntegrity/computeVisitationConfidence/evaluatePhysicalWordTraversal/evaluateLetterCompleteness unmodified. Only called for multi-letter words (mirrors wordTraversal's own historic single-letter carve-out). */
function evaluateSemanticLayers(word: string, geometry: NonNullable<ReturnType<typeof localGeometryFor>>): { completenessPass: boolean; sequenceValid: boolean } {
  const { assignments, boundaries } = assignRouteSamplesToLetters(word, geometry.target, geometry.route, geometry.geometryVariant);
  const blocks = deriveVisitationBlocks(assignments);
  const observedSequence = deriveObservedSequence(blocks);
  const intendedSequence = wordLetters(word, geometry.geometryVariant);
  const integrity = evaluateSequenceIntegrity(observedSequence, intendedSequence);
  const visitationConfidence = computeVisitationConfidence(boundaries, blocks);
  const physical = evaluatePhysicalWordTraversal(word, geometry.target, geometry.route, geometry.geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
  const completeness = evaluateLetterCompleteness(physical, visitationConfidence);
  return { completenessPass: completeness.complete, sequenceValid: integrity.sequenceValid };
}

/**
 * Recalibrated whole-route order (Model B / word-aware jump calibration) —
 * a SUPPORTING/DIAGNOSTIC signal only, never a hard gate. Reuses
 * computeRecalibratedOrderModels unmodified; returns null when geometry or
 * word context is unavailable (same circumstances the hard-gate checks
 * below are skipped in).
 */
export function computeSupportingOrder(route: GeneratedRoute, context: ProductThresholdContext = {}): number | null {
  if (context.skipIdentity || (route.targetCoordinates?.length ?? 0) < 2) {
    return null;
  }
  const geometry = localGeometryFor(route);
  if (!geometry || !context.word) {
    return null;
  }
  return computeRecalibratedOrderModels(geometry.route, geometry.target, context.word, geometry.geometryVariant).B_perLetterCount.order;
}

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
  if (route.metadata.backtrackRatio > EXPERIMENTAL_PRODUCT.maxBacktrack) reasons.push('backtrack');
  if (gap > EXPERIMENTAL_PRODUCT.maxLargestGap) reasons.push('largestGap');
  if (context.skipIdentity || (route.targetCoordinates?.length ?? 0) < 2) {
    return reasons;
  }
  const identity = identityFor(route, context);
  if (!identity) {
    return reasons;
  }
  const lengthRatio =
    identity.lengthRatioRequested ??
    identity.lengthRatioProjected;
  if (lengthRatio < EXPERIMENTAL_PRODUCT.minLengthRatio) {
    reasons.push('lengthRatio');
  }

  const geometry = localGeometryFor(route);
  if (!geometry) {
    return reasons;
  }
  const word = context.word ?? '';
  if (!evaluateRouteContinuity(word, geometry)) {
    reasons.push('continuity');
  }
  if ((word.replace(/[^A-Za-z]/g, '').length ?? 0) > 1) {
    const semantic = evaluateSemanticLayers(word, geometry);
    if (!semantic.completenessPass) reasons.push('completeness');
    if (!semantic.sequenceValid) reasons.push('sequenceIntegrity');
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
