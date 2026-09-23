/**
 * DEVELOPMENT ONLY. Per-letter order-metric root-cause diagnostic —
 * observation only, never called from the live route-generation/scoring/
 * gate path, never fed back into any production function.
 *
 * Question (from the word-traversal diagnostic): checkpoint-v1 achieves
 * near-perfect physical ink coverage on many letters (rawInk >= 0.90) yet
 * per-letter `order` stays far below the 0.45 meaningfullyVisited
 * threshold — and even a relaxed 0.30 threshold rescues nothing. Why?
 *
 * EXACT implementation traced directly from source (Step 1):
 *
 * target-identity.ts's letterIdentities() (private) builds, per letter:
 *   letterTarget = sliceTargetByProgress(target, startProgress, endProgress)
 *     — a 48-sample resample of the FULL target, filtered to
 *     [startProgress-0.02, endProgress+0.02].
 *   letterRoute = sampledRoute.filter(point => {
 *     const hit = projectPointOnPolyline(point, target);
 *     return hit.distance <= letterThreshold*2
 *       && hit.progress >= startProgress-0.03
 *       && hit.progress <= endProgress+0.03;
 *   })
 *     — sampledRoute is the FULL route resampled to 80 points
 *     (TARGET_IDENTITY.sampleCount), filtered down to just the points
 *     whose target-projection falls near this letter. CRITICAL: this is
 *     an array .filter() — it preserves relative ORDER but NOT original
 *     INDEX ADJACENCY. If the real route strays outside the ±0.03/2x
 *     threshold window for a stretch (a real street detour around this
 *     letter) and later re-enters it, the surviving letterRoute treats
 *     the point BEFORE the detour and the point AFTER it as CONSECUTIVE
 *     — an artificial "teleport" that does not correspond to any real
 *     route segment.
 *   order = scoreOrderedPath(letterRoute, resamplePolyline(letterTarget,
 *     min(80, letterRoute.length)), letterTarget, {orderDistanceScale,
 *     coverageThreshold: letterThreshold}).order
 *
 * scoreOrderedPath() (lib/shape-order.ts, read in full, UNCHANGED, called
 * as-is throughout this file):
 *   dtwFit = clamp01(1 - constrainedDtw(route,target).meanDistance / orderDistanceScale)
 *   progressFit = clamp01(0.5*monotonicFit + 0.3*jumpFit + 0.2*revisitFit), where:
 *     progress[i] = projectPointOnPolyline(routePoint[i], targetPolyline).progress
 *       — CRITICALLY, for the per-letter call, targetPolyline = letterTarget,
 *       so progress here is ALREADY letter-local (0..1 over just this letter).
 *     monotonicFit = positiveProgressVariation / totalProgressVariation
 *       (forward vs backward delta sum across CONSECUTIVE letterRoute entries)
 *     jumpFit = clamp01(1 - skipAmount/0.35), skipAmount = sum(max(0, delta -
 *       jumpAllow)), jumpAllow = 4/(letterRoute.length-1) — SAMPLE-COUNT
 *       DEPENDENT: fewer points => larger allowed jump per step.
 *     revisitFit = 1 - revisitSteps/(letterRoute.length-1), a "revisit" =
 *       a step where progress drops more than 0.12 (12% of the LETTER's
 *       own local span) below the running max-so-far.
 *   directionFit = headingConsistency(letterRoute, letterTarget,
 *     letterThreshold) — length-weighted mean heading agreement between
 *     CONSECUTIVE letterRoute segments and the target's local heading at
 *     that point, skipping segments farther than max(letterThreshold*2,1)
 *     from the target. Same "consecutive entries of a filtered array"
 *     adjacency issue as progressFit: a segment connecting two
 *     letterRoute points that were NOT adjacent in the real route
 *     produces an artificial, physically-meaningless heading.
 *   order = clamp01(0.5*dtwFit + 0.3*progressFit + 0.2*directionFit)
 *
 * Reuses, unmodified: scoreOrderedPath (lib/shape-order.ts),
 * extractLetterOrderInputs/computeLetterOrderDecomposition
 * (order-score-diagnostic.ts, already parity-verified against production),
 * computeInkOnlyOccupancy (letter-occupancy.ts). This file adds NO new
 * scoring math to any PRODUCTION path — shadow variants call the real,
 * unmodified scoreOrderedPath with DIFFERENT INPUT SELECTIONS, never a
 * different formula.
 */
import { distance2, headingRadians, projectPointOnPolyline, resamplePolyline, shortestAngleDelta, type Vec2 } from '@/lib/geometry';
import { scoreOrderedPath, type OrderMatchDetails } from '@/lib/shape-order';

import { coverageThresholdMeters, TARGET_IDENTITY } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

// ---------------------------------------------------------------------------
// Step 2/3 — exact per-letter inputs, WITH original-sample-index gap detection
// ---------------------------------------------------------------------------

export type LetterRouteWindowInputs = {
  letter: string;
  index: number;
  targetStartProgress: number;
  targetEndProgress: number;
  letterTargetPointCount: number;
  letterTargetLengthUnits: number;
  letterRoutePointCount: number;
  /** min/max of the projected progress of the SELECTED letterRoute points, against the FULL (word-level) target — i.e. where in the whole word these selected points actually sit. */
  routeMinProgress: number | null;
  routeMaxProgress: number | null;
  /** Original index (0-79) of each selected point within the 80-point full-route resample — used to detect gaps (non-adjacent points treated as consecutive). */
  selectedOriginalIndices: number[];
  /** Number of places where two CONSECUTIVE letterRoute entries have non-adjacent original indices (index gap > 1) — direct evidence of an "artificial teleport" in the filtered sequence. */
  gapCount: number;
  /** Largest single gap (in original-sample-index units) between consecutive selected points. */
  maxGapSize: number;
  coverageThreshold: number;
  orderDistanceScale: number;
};

function sliceTargetByProgressLocal(target: readonly Vec2[], start: number, end: number): Vec2[] {
  const samples = resamplePolyline(target, 48);
  const sliced = samples.filter((_, index) => {
    const progress = samples.length === 1 ? 0 : index / (samples.length - 1);
    return progress >= start - 0.02 && progress <= end + 0.02;
  });
  return sliced.length >= 2 ? sliced : samples.slice(0, 2);
}

function polylineLengthLocal(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance2(points[i - 1]!, points[i]!);
  return total;
}

/** Mirrors target-identity.ts's letterIdentities() exact letterRoute-selection formula, but ALSO tracks each selected point's original index in the 80-point full-route resample — production computes no such tracking; this is purely additive instrumentation over the SAME filter logic. */
export function extractLetterRouteWindowInputs(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: LetterShapeVariant,
  progressPad = 0.03,
  distanceMultiplier = 2,
): LetterRouteWindowInputs[] {
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  if (!shape.word || shape.letters.length === 0 || target.length < 2) return [];
  const wordThreshold = coverageThresholdMeters(target);
  const sampledRoute = resamplePolyline(route, TARGET_IDENTITY.sampleCount);
  const fullProjections = sampledRoute.map((point) => projectPointOnPolyline(point, target));

  return shape.letters.map((letter, index) => {
    const projections = letter.points.map((point) => projectPointOnPolyline(point, shape.points).progress);
    const startProgress = projections.length === 0 ? 0 : Math.min(...projections);
    const endProgress = projections.length === 0 ? 0 : Math.max(...projections);
    const letterTarget = sliceTargetByProgressLocal(target, startProgress, endProgress);
    const letterThreshold = Math.min(wordThreshold, coverageThresholdMeters(letterTarget));

    const selected: Array<{ originalIndex: number; progress: number }> = [];
    sampledRoute.forEach((_point, i) => {
      const hit = fullProjections[i]!;
      if (hit.distance <= letterThreshold * distanceMultiplier && hit.progress >= startProgress - progressPad && hit.progress <= endProgress + progressPad) {
        selected.push({ originalIndex: i, progress: hit.progress });
      }
    });

    let gapCount = 0;
    let maxGapSize = 0;
    for (let i = 1; i < selected.length; i += 1) {
      const gap = selected[i]!.originalIndex - selected[i - 1]!.originalIndex;
      if (gap > 1) {
        gapCount += 1;
        maxGapSize = Math.max(maxGapSize, gap);
      }
    }

    const orderDistanceScale = Math.max(
      Math.min(boxOf(letterTarget).width, boxOf(letterTarget).height) * 0.25,
      polylineLengthLocal(letterTarget) * 0.04,
      1e-6,
    );

    return {
      letter: letter.char,
      index,
      targetStartProgress: startProgress,
      targetEndProgress: endProgress,
      letterTargetPointCount: letterTarget.length,
      letterTargetLengthUnits: polylineLengthLocal(letterTarget),
      letterRoutePointCount: selected.length,
      routeMinProgress: selected.length ? Math.min(...selected.map((s) => s.progress)) : null,
      routeMaxProgress: selected.length ? Math.max(...selected.map((s) => s.progress)) : null,
      selectedOriginalIndices: selected.map((s) => s.originalIndex),
      gapCount,
      maxGapSize,
      coverageThreshold: letterThreshold,
      orderDistanceScale,
    };
  });
}

function boxOf(points: readonly Vec2[]): { width: number; height: number } {
  if (points.length === 0) return { width: 0, height: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// ---------------------------------------------------------------------------
// Step 4 — shadow letterRoute-window variants (different pad, same real scoreOrderedPath)
// ---------------------------------------------------------------------------

export type WindowVariantKey = 'A_pad03_current' | 'B_pad02' | 'C_pad015' | 'D_pad01' | 'E_pad05' | 'F_strict_range_only';

export const WINDOW_VARIANTS: Record<WindowVariantKey, { progressPad: number; distanceMultiplier: number }> = {
  A_pad03_current: { progressPad: 0.03, distanceMultiplier: 2 },
  B_pad02: { progressPad: 0.02, distanceMultiplier: 2 },
  C_pad015: { progressPad: 0.015, distanceMultiplier: 2 },
  D_pad01: { progressPad: 0.01, distanceMultiplier: 2 },
  E_pad05: { progressPad: 0.05, distanceMultiplier: 2 },
  F_strict_range_only: { progressPad: 0, distanceMultiplier: 2 },
};

export type ShadowWindowLetterResult = {
  letter: string;
  index: number;
  letterRoutePointCount: number;
  gapCount: number;
  order: OrderMatchDetails;
};

/** Re-selects letterRoute under a shadow window, then scores it with the REAL, unmodified scoreOrderedPath() — only the input selection changes, never the scoring formula. */
export function evaluateShadowWindow(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: LetterShapeVariant,
  variant: WindowVariantKey,
): ShadowWindowLetterResult[] {
  const params = WINDOW_VARIANTS[variant];
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  if (!shape.word || shape.letters.length === 0 || target.length < 2) return [];
  const wordThreshold = coverageThresholdMeters(target);
  const sampledRoute = resamplePolyline(route, TARGET_IDENTITY.sampleCount);
  const fullProjections = sampledRoute.map((point) => projectPointOnPolyline(point, target));

  return shape.letters.map((letter, index) => {
    const projections = letter.points.map((point) => projectPointOnPolyline(point, shape.points).progress);
    const startProgress = projections.length === 0 ? 0 : Math.min(...projections);
    const endProgress = projections.length === 0 ? 0 : Math.max(...projections);
    const letterTarget = sliceTargetByProgressLocal(target, startProgress, endProgress);
    const letterThreshold = Math.min(wordThreshold, coverageThresholdMeters(letterTarget));

    const selected: Array<{ originalIndex: number; point: Vec2 }> = [];
    sampledRoute.forEach((point, i) => {
      const hit = fullProjections[i]!;
      if (hit.distance <= letterThreshold * params.distanceMultiplier && hit.progress >= startProgress - params.progressPad && hit.progress <= endProgress + params.progressPad) {
        selected.push({ originalIndex: i, point });
      }
    });
    let gapCount = 0;
    for (let i = 1; i < selected.length; i += 1) {
      if (selected[i]!.originalIndex - selected[i - 1]!.originalIndex > 1) gapCount += 1;
    }

    const letterRoute = selected.map((s) => s.point);
    const sampledTarget = resamplePolyline(letterTarget, Math.min(TARGET_IDENTITY.sampleCount, letterRoute.length || 1));
    const orderDistanceScale = Math.max(Math.min(boxOf(letterTarget).width, boxOf(letterTarget).height) * 0.25, polylineLengthLocal(letterTarget) * 0.04, 1e-6);
    const order =
      letterTarget.length >= 2 && letterRoute.length >= 2
        ? scoreOrderedPath(letterRoute, sampledTarget, letterTarget, { orderDistanceScale, coverageThreshold: letterThreshold })
        : emptyOrderLocal();

    return { letter: letter.char, index, letterRoutePointCount: letterRoute.length, gapCount, order };
  });
}

function emptyOrderLocal(): OrderMatchDetails {
  return { dtwFit: 0, dtwMeanDistanceMeters: Number.POSITIVE_INFINITY, warpFit: 0, monotonicFit: 0, jumpFit: 0, revisitFit: 0, directionFit: 0, progressFit: 0, order: 0 };
}

// ---------------------------------------------------------------------------
// Step 7 — per-segment direction breakdown (mirrors headingConsistency's own loop, read-only instrumentation)
// ---------------------------------------------------------------------------

export type DirectionSegmentRecord = {
  segmentIndex: number;
  segmentLengthUnits: number;
  withinTargetRange: boolean;
  headingDeltaDegrees: number | null;
  contribution: number | null;
};

/** Mirrors lib/shape-order.ts's private headingConsistency() loop exactly (same "far" cutoff, same weighting), but returns the per-segment trace instead of just the final weighted mean — pure read-only instrumentation over the same real formula. */
export function traceDirectionConsistency(letterRoute: readonly Vec2[], letterTarget: readonly Vec2[], coverageThreshold: number): { segments: DirectionSegmentRecord[]; directionFit: number } {
  const far = Math.max(coverageThreshold * 2, 1);
  const segments: DirectionSegmentRecord[] = [];
  let weighted = 0;
  let weight = 0;
  for (let index = 1; index < letterRoute.length; index += 1) {
    const from = letterRoute[index - 1]!;
    const to = letterRoute[index]!;
    const segmentLength = distance2(from, to);
    if (segmentLength < 1e-9) continue;
    const hit = projectPointOnPolyline(to, letterTarget);
    if (hit.distance > far) {
      segments.push({ segmentIndex: index, segmentLengthUnits: segmentLength, withinTargetRange: false, headingDeltaDegrees: null, contribution: null });
      continue;
    }
    const start = letterTarget[hit.segmentIndex];
    const end = letterTarget[hit.segmentIndex + 1] ?? start;
    if (!start || !end || distance2(start, end) < 1e-9) {
      segments.push({ segmentIndex: index, segmentLengthUnits: segmentLength, withinTargetRange: true, headingDeltaDegrees: null, contribution: null });
      continue;
    }
    const deltaRadians = Math.abs(shortestAngleDelta(headingRadians(from, to), headingRadians(start, end)));
    const deltaDegrees = (deltaRadians * 180) / Math.PI;
    const contribution = Math.max(0, Math.min(1, 1 - deltaRadians / (Math.PI / 2)));
    weight += segmentLength;
    weighted += contribution * segmentLength;
    segments.push({ segmentIndex: index, segmentLengthUnits: segmentLength, withinTargetRange: true, headingDeltaDegrees: deltaDegrees, contribution });
  }
  return { segments, directionFit: weight === 0 ? 0 : weighted / weight };
}

// ---------------------------------------------------------------------------
// Step 9 — shadow component composition (real dtwFit, synthetic progress/direction)
// ---------------------------------------------------------------------------

export type ShadowComponentVariant = 'A_actual' | 'B_perfectProgress' | 'C_perfectDirection' | 'D_perfectBoth';

export function composeShadowOrder(real: OrderMatchDetails, variant: ShadowComponentVariant): number {
  const progressFit = variant === 'B_perfectProgress' || variant === 'D_perfectBoth' ? 1 : real.progressFit;
  const directionFit = variant === 'C_perfectDirection' || variant === 'D_perfectBoth' ? 1 : real.directionFit;
  return Math.max(0, Math.min(1, 0.5 * real.dtwFit + 0.3 * progressFit + 0.2 * directionFit));
}

// ---------------------------------------------------------------------------
// Correlation helper (Step 11)
// ---------------------------------------------------------------------------

export function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const meanX = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanY = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

export { computeInkOnlyOccupancy, letterBoundariesFromWordShape };
