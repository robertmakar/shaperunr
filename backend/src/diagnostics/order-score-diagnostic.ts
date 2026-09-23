/**
 * DEVELOPMENT ONLY. Diagnostic decomposition of the existing per-letter
 * order score — observation only, never called from the live route
 * generation/scoring/gate path.
 *
 * scoreOrderedPath() (lib/shape-order.ts, UNCHANGED, imported and called
 * as-is) is NOT reimplemented here. Every scored component in this file
 * (dtwFit, monotonicFit, jumpFit, revisitFit, directionFit, progressFit,
 * order) comes directly out of a REAL call to the real, unmodified
 * function — the same function target-identity.ts's letterIdentities()
 * already calls for every letter in production.
 *
 * What IS mirrored here (not scoring math, just the private per-letter
 * INPUT-SELECTION logic from target-identity.ts's unexported
 * letterIdentities()/sliceTargetByProgress(), so this file can hand
 * scoreOrderedPath() the exact same arguments production does): how a
 * letter's own target slice (letterTarget), route-point subset
 * (letterRoute), distance threshold, and orderDistanceScale are derived.
 * This is the same "mirror the private helper, verify parity against the
 * real result" pattern already used by letter-occupancy.ts's
 * computeBinOccupancy (which mirrors target-identity.ts's private
 * spanOccupancy). Parity is verified directly in the self-test: this
 * module's own computed `order.order` for a letter must exactly equal
 * TargetIdentity.letters[i].order for the same candidate.
 */
import {
  boundingBox2,
  polylineLength,
  projectPointOnPolyline,
  resamplePolyline,
  type Vec2,
} from '@/lib/geometry';
import { scoreOrderedPath, type OrderMatchDetails } from '@/lib/shape-order';

import { coverageThresholdMeters, TARGET_IDENTITY } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';

/** Mirrors target-identity.ts's private sliceTargetByProgress() exactly (same 48-sample resample, same ±0.02 progress pad). */
function sliceTargetByProgress(target: readonly Vec2[], start: number, end: number): Vec2[] {
  const samples = resamplePolyline(target, 48);
  const sliced = samples.filter((_, index) => {
    const progress = samples.length === 1 ? 0 : index / (samples.length - 1);
    return progress >= start - 0.02 && progress <= end + 0.02;
  });
  return sliced.length >= 2 ? sliced : samples.slice(0, 2);
}

/** Mirrors target-identity.ts's private boxOf() exactly — a two-line wrapper of the public boundingBox2. */
function boxOf(points: readonly Vec2[]): { width: number; height: number } {
  const box = boundingBox2(points);
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}

export type LetterOrderInputs = {
  letter: string;
  index: number;
  startProgress: number;
  endProgress: number;
  letterTarget: Vec2[];
  letterRoute: Vec2[];
  sampledTarget: Vec2[];
  orderDistanceScale: number;
  coverageThreshold: number;
};

/**
 * Reconstructs, per letter, the EXACT (letterRoute, sampledTarget,
 * letterTarget, options) tuple that target-identity.ts's letterIdentities()
 * passes into the real scoreOrderedPath() for that letter — mirroring only
 * the input-selection logic, never the scoring math itself.
 */
export function extractLetterOrderInputs(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: 'smooth' | 'angular' | 'hybrid',
): LetterOrderInputs[] {
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  if (!shape.word || shape.letters.length === 0 || target.length < 2) {
    return [];
  }
  const wordThreshold = coverageThresholdMeters(target);
  const sampledRoute = resamplePolyline(route, TARGET_IDENTITY.sampleCount);

  return shape.letters.map((letter, index) => {
    const projections = letter.points.map((point) => projectPointOnPolyline(point, shape.points).progress);
    const startProgress = projections.length === 0 ? 0 : Math.min(...projections);
    const endProgress = projections.length === 0 ? 0 : Math.max(...projections);
    const letterTarget = sliceTargetByProgress(target, startProgress, endProgress);
    const letterThreshold = Math.min(wordThreshold, coverageThresholdMeters(letterTarget));
    const letterRoute = sampledRoute.filter((point) => {
      const hit = projectPointOnPolyline(point, target);
      return hit.distance <= letterThreshold * 2 && hit.progress >= startProgress - 0.03 && hit.progress <= endProgress + 0.03;
    });
    const sampledTarget = resamplePolyline(letterTarget, Math.min(TARGET_IDENTITY.sampleCount, letterRoute.length || 1));
    const orderDistanceScale = Math.max(
      Math.min(boxOf(letterTarget).width, boxOf(letterTarget).height) * 0.25,
      polylineLength(letterTarget) * 0.04,
      1e-6,
    );
    return {
      letter: letter.char,
      index,
      startProgress,
      endProgress,
      letterTarget,
      letterRoute,
      sampledTarget,
      orderDistanceScale,
      coverageThreshold: letterThreshold,
    };
  });
}

export type DirectionClass = 'same' | 'reverse' | 'mixed' | 'insufficient';

/**
 * Classified directly from the REAL forward order call's own monotonicFit
 * (progress = positive-progress-variation / total-progress-variation along
 * the letter's own target slice) — not a new metric, just a label on an
 * existing one. >=0.7 / <=0.3 are diagnostic labeling cutoffs only, not
 * production thresholds.
 */
export function classifyDirection(monotonicFit: number, routePointCount: number): DirectionClass {
  if (routePointCount < 2) {
    return 'insufficient';
  }
  if (monotonicFit >= 0.7) return 'same';
  if (monotonicFit <= 0.3) return 'reverse';
  return 'mixed';
}

export type LetterOrderDecomposition = {
  letter: string;
  index: number;
  startProgress: number;
  endProgress: number;
  routePointCount: number;
  /** The REAL per-letter OrderMatchDetails — bit-for-bit what production's TargetIdentity.letters[index].order is derived from (see self-test parity check). */
  forward: OrderMatchDetails;
  /** scoreOrderedPath() called with the SAME route but the target arrays (sampledTarget, letterTarget) reversed — still the real, unmodified function, just fed the target's reverse-direction framing (task Shadow B input). Reversing ONLY the target (not the route) is what actually tests "does this route match the letter traversed the other way around" — reversing both would cancel out and reproduce the forward comparison. */
  reverse: OrderMatchDetails;
  /** Route point's projected progress along the letter's own target slice, in path order — exposes WHY a well-covered letter can still score low order (task Part 4). */
  routeProgressSequence: number[];
  direction: DirectionClass;
  /** Shadow A: max(forward.progressFit, reverse.progressFit) — direction-insensitive progress coherence. Keeps jump/revisit penalties (still rejects routes that merely jump around the letter) while dropping the assumption that the route must move in the SAME rotational/linear direction as the target's own canonical stroke order. */
  shadowCoherentProgressFit: number;
  /** Shadow B: max(forward.order, reverse.order) — the full existing order score (DTW distance-fit + progress-fit + heading-direction-fit), maximized over both traversal directions. */
  shadowBidirectionalOrder: number;
};

export function computeLetterOrderDecomposition(input: LetterOrderInputs): LetterOrderDecomposition {
  const { letterRoute, sampledTarget, letterTarget, orderDistanceScale, coverageThreshold } = input;
  const options = { orderDistanceScale, coverageThreshold };

  const forward =
    letterTarget.length >= 2 && letterRoute.length >= 2
      ? scoreOrderedPath(letterRoute, sampledTarget, letterTarget, options)
      : emptyDetails();
  const reverse =
    letterTarget.length >= 2 && letterRoute.length >= 2
      ? scoreOrderedPath(letterRoute, [...sampledTarget].reverse(), [...letterTarget].reverse(), options)
      : emptyDetails();

  const routeProgressSequence = letterRoute.map((point) => projectPointOnPolyline(point, letterTarget).progress);

  return {
    letter: input.letter,
    index: input.index,
    startProgress: input.startProgress,
    endProgress: input.endProgress,
    routePointCount: letterRoute.length,
    forward,
    reverse,
    routeProgressSequence,
    direction: classifyDirection(forward.monotonicFit, letterRoute.length),
    shadowCoherentProgressFit: Math.max(forward.progressFit, reverse.progressFit),
    shadowBidirectionalOrder: Math.max(forward.order, reverse.order),
  };
}

function emptyDetails(): OrderMatchDetails {
  return {
    dtwFit: 0,
    dtwMeanDistanceMeters: Number.POSITIVE_INFINITY,
    warpFit: 0,
    monotonicFit: 0,
    jumpFit: 0,
    revisitFit: 0,
    directionFit: 0,
    progressFit: 0,
    order: 0,
  };
}

/** Shadow C: does raw ink density plus direction-insensitive coherent progress (Shadow A) suggest the letter was meaningfully drawn, independent of the existing order score? Diagnostic thresholds only — 0.5 matches the shadow-traversal task's established SHADOW_DEFAULT_COVERAGE_THRESHOLD; 0.45 is TARGET_IDENTITY.minLetterOrder reused purely as a reference comparison point, not a new production threshold. */
export function evaluateShadowCoverageAndCoherence(
  rawInkOccupancy: number,
  shadowCoherentProgressFit: number,
  inkThreshold = 0.5,
  coherenceThreshold = TARGET_IDENTITY.minLetterOrder,
): boolean {
  return rawInkOccupancy >= inkThreshold && shadowCoherentProgressFit >= coherenceThreshold;
}
