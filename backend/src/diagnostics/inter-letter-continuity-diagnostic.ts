/**
 * DEVELOPMENT ONLY. Inter-letter route continuity diagnostic — additive/
 * diagnostic only, never called from the live route-generation/scoring/
 * gate path, never wired into wordTraversal/the product gate.
 *
 * Question: the shadow physical-word-traversal evaluator (physical
 * letter coverage + broad letter sequence) passes 13/78 checkpoint-v1
 * candidates. Some of those have low targetSpan (the OLD strict
 * connected-span metric, 0.16-0.20). Does the physical evaluator pass
 * candidates whose route is actually a coherent, continuous street walk
 * from letter to letter, or could it pass a route that independently
 * touches each letter's ink via disconnected patches?
 *
 * This adds ONE new signal — inter-letter ROUTE-SPACE continuity — kept
 * explicitly separate from (a) the old stroke-fidelity order score
 * (dtwFit/progressFit/directionFit/monotonicFit/jumpFit/revisitFit,
 * untouched, not read by this module at all) and (b) the old target-space
 * targetSpan/connected-span metric (also untouched, not reused here — a
 * street route can legitimately deviate far from the idealized target
 * polyline between letters while still being one continuous physical
 * walk, which is exactly why target-space continuity is the wrong
 * measure for this question; see the file header note on Step 12/13's
 * "route-space over target-space" instruction).
 *
 * Reuses, unmodified: TARGET_IDENTITY.sampleCount (target-identity.ts),
 * coverageThresholdMeters, the SAME letterRoute filter formula already
 * mirrored and parity-verified in order-score-diagnostic.ts's
 * extractLetterOrderInputs — reimplemented here ONLY to additionally
 * track each selected point's ORIGINAL index in the 80-sample full-route
 * resample (order-score-diagnostic.ts's own extraction discards that
 * index; this is the same "mirror + prove parity" pattern already used
 * five times this session, e.g. letter-order-component-diagnostic.ts's
 * auditFilteredHeadingSegments).
 */
import { distance2, polylineLength, projectPointOnPolyline, resamplePolyline, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

import { coverageThresholdMeters, TARGET_IDENTITY } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';

// ---------------------------------------------------------------------------
// Step 3 — per-letter route span, WITH original index into the full
// 80-sample resampled route (the same resample TARGET_IDENTITY.sampleCount
// and every per-letter identity computation already operates on).
// ---------------------------------------------------------------------------

export type LetterRouteSpan = {
  letterIndex: number;
  letter: string;
  /** Original indices (into the 80-sample full-route resample) of every point the existing filter assigned to this letter, in route order. Empty if the letter has no assigned route points at all. */
  assignedOriginalIndices: number[];
  firstOriginalIndex: number | null;
  lastOriginalIndex: number | null;
  firstPoint: Vec2 | null;
  lastPoint: Vec2 | null;
  /** min/max of this letter's own assigned points' progress against the FULL target — how far the real route actually reached, distinct from the letter's fixed target boundary. */
  reachedStartProgress: number | null;
  reachedEndProgress: number | null;
};

function sliceTargetByProgressLocal(target: readonly Vec2[], start: number, end: number): Vec2[] {
  const samples = resamplePolyline(target, 48);
  const sliced = samples.filter((_, index) => {
    const progress = samples.length === 1 ? 0 : index / (samples.length - 1);
    return progress >= start - 0.02 && progress <= end + 0.02;
  });
  return sliced.length >= 2 ? sliced : samples.slice(0, 2);
}

export function extractFullSampledRoute(route: readonly Vec2[]): Vec2[] {
  return resamplePolyline(route, TARGET_IDENTITY.sampleCount);
}

/** Reuses the EXACT SAME letterRoute filter formula target-identity.ts's letterIdentities() / order-score-diagnostic.ts's extractLetterOrderInputs already use (distance<=letterThreshold*2, progress in [start-0.03,end+0.03]) — the only addition is tracking each selected point's original index in the shared 80-sample resample. */
export function extractLetterRouteSpans(word: string, target: readonly Vec2[], route: readonly Vec2[], geometryVariant: LetterShapeVariant): { spans: LetterRouteSpan[]; sampledRoute: Vec2[] } {
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  const sampledRoute = extractFullSampledRoute(route);
  if (!shape.word || shape.letters.length === 0 || target.length < 2) return { spans: [], sampledRoute };
  const wordThreshold = coverageThresholdMeters(target);
  const fullProjections = sampledRoute.map((point) => projectPointOnPolyline(point, target));

  const spans = shape.letters.map((letter, letterIndex) => {
    const projections = letter.points.map((point) => projectPointOnPolyline(point, shape.points).progress);
    const startProgress = projections.length === 0 ? 0 : Math.min(...projections);
    const endProgress = projections.length === 0 ? 0 : Math.max(...projections);
    const letterTarget = sliceTargetByProgressLocal(target, startProgress, endProgress);
    const letterThreshold = Math.min(wordThreshold, coverageThresholdMeters(letterTarget));

    const assigned: Array<{ originalIndex: number; point: Vec2; progress: number }> = [];
    sampledRoute.forEach((point, i) => {
      const hit = fullProjections[i]!;
      if (hit.distance <= letterThreshold * 2 && hit.progress >= startProgress - 0.03 && hit.progress <= endProgress + 0.03) {
        assigned.push({ originalIndex: i, point, progress: hit.progress });
      }
    });

    const first = assigned[0] ?? null;
    const last = assigned[assigned.length - 1] ?? null;
    const progresses = assigned.map((a) => a.progress);

    return {
      letterIndex,
      letter: letter.char,
      assignedOriginalIndices: assigned.map((a) => a.originalIndex),
      firstOriginalIndex: first?.originalIndex ?? null,
      lastOriginalIndex: last?.originalIndex ?? null,
      firstPoint: first?.point ?? null,
      lastPoint: last?.point ?? null,
      reachedStartProgress: progresses.length ? Math.min(...progresses) : null,
      reachedEndProgress: progresses.length ? Math.max(...progresses) : null,
    };
  });

  return { spans, sampledRoute };
}

// ---------------------------------------------------------------------------
// Step 3/4/6 — per-transition continuity record.
// ---------------------------------------------------------------------------

export type TransitionRecord = {
  fromLetter: string;
  toLetter: string;
  fromLastProgress: number | null;
  toFirstProgress: number | null;
  /** Distance traveled ALONG the actual route polyline (sum of consecutive real segment lengths in the full sampled route) between A's last assigned point and B's first assigned point — NOT Euclidean. Null if either letter has no assigned points (a genuine gap, not a continuity measurement). */
  routeDistance: number | null;
  straightLineDistance: number | null;
  routeToStraightRatio: number | null;
  targetProgressGap: number | null;
  /** Count of full-sampled-route points strictly between A's last and B's first original index (route-order, not target-progress order). */
  numberOfRoutePointsBetween: number | null;
};

/** Route distance along the REAL, full sampled route between two original indices — walks the actual consecutive samples, never the filtered/letter-assigned subset. Handles the (rare, already-flagged-elsewhere) case where toIndex < fromIndex by measuring the absolute traversal either direction. */
export function routeDistanceAlongPolyline(sampledRoute: readonly Vec2[], fromIndex: number, toIndex: number): number {
  const lo = Math.min(fromIndex, toIndex);
  const hi = Math.max(fromIndex, toIndex);
  let total = 0;
  for (let i = lo; i < hi; i += 1) {
    total += distance2(sampledRoute[i]!, sampledRoute[i + 1]!);
  }
  return total;
}

export function computeTransitionRecord(from: LetterRouteSpan, to: LetterRouteSpan, sampledRoute: readonly Vec2[]): TransitionRecord {
  if (from.lastPoint === null || to.firstPoint === null || from.lastOriginalIndex === null || to.firstOriginalIndex === null) {
    return {
      fromLetter: from.letter,
      toLetter: to.letter,
      fromLastProgress: from.reachedEndProgress,
      toFirstProgress: to.reachedStartProgress,
      routeDistance: null,
      straightLineDistance: null,
      routeToStraightRatio: null,
      targetProgressGap: from.reachedEndProgress !== null && to.reachedStartProgress !== null ? to.reachedStartProgress - from.reachedEndProgress : null,
      numberOfRoutePointsBetween: null,
    };
  }
  const routeDistance = routeDistanceAlongPolyline(sampledRoute, from.lastOriginalIndex, to.firstOriginalIndex);
  const straightLineDistance = distance2(from.lastPoint, to.firstPoint);
  const numberOfRoutePointsBetween = Math.max(0, Math.abs(to.firstOriginalIndex - from.lastOriginalIndex) - 1);
  return {
    fromLetter: from.letter,
    toLetter: to.letter,
    fromLastProgress: from.reachedEndProgress,
    toFirstProgress: to.reachedStartProgress,
    routeDistance,
    straightLineDistance,
    routeToStraightRatio: straightLineDistance > 1e-9 ? routeDistance / straightLineDistance : routeDistance > 1e-9 ? Number.POSITIVE_INFINITY : 1,
    targetProgressGap: from.reachedEndProgress !== null && to.reachedStartProgress !== null ? to.reachedStartProgress - from.reachedEndProgress : null,
    numberOfRoutePointsBetween,
  };
}

// ---------------------------------------------------------------------------
// Step 5 — route-point continuity (consecutive-sample gaps in the REAL route).
// ---------------------------------------------------------------------------

export type RoutePointContinuityStats = {
  totalRoutePoints: number;
  assignedRoutePoints: number;
  unassignedRoutePoints: number;
  unassignedFraction: number;
  consecutiveGaps: number[];
  largestConsecutiveGap: number;
  medianConsecutiveGap: number;
  p90ConsecutiveGap: number;
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

export function computeRoutePointContinuity(sampledRoute: readonly Vec2[], spans: readonly LetterRouteSpan[]): RoutePointContinuityStats {
  const assignedIndices = new Set<number>();
  for (const span of spans) for (const index of span.assignedOriginalIndices) assignedIndices.add(index);
  const consecutiveGaps: number[] = [];
  for (let i = 1; i < sampledRoute.length; i += 1) {
    consecutiveGaps.push(distance2(sampledRoute[i - 1]!, sampledRoute[i]!));
  }
  const total = sampledRoute.length;
  const assigned = assignedIndices.size;
  return {
    totalRoutePoints: total,
    assignedRoutePoints: assigned,
    unassignedRoutePoints: total - assigned,
    unassignedFraction: total === 0 ? 0 : (total - assigned) / total,
    consecutiveGaps,
    largestConsecutiveGap: consecutiveGaps.length ? Math.max(...consecutiveGaps) : 0,
    medianConsecutiveGap: median(consecutiveGaps),
    p90ConsecutiveGap: percentile(consecutiveGaps, 0.9),
  };
}

// ---------------------------------------------------------------------------
// Step 6 — initial raw transition classification (thresholds supplied by
// the caller after Step 10's empirical distribution inspection — never
// hard-coded inside this module).
// ---------------------------------------------------------------------------

export type TransitionClass = 'DIRECT' | 'LONG_BUT_CONNECTED' | 'AMBIGUOUS' | 'DISCONNECTED';

export type TransitionClassificationThresholds = {
  /** routeToStraightRatio at/below this is DIRECT (route barely deviates from a straight hop). */
  directRatioMax: number;
  /** routeDistance at/below this (in the same local units as the target) counts as "short" regardless of ratio. */
  shortDistanceMax: number;
  /** routeToStraightRatio above this is DISCONNECTED-leaning (route wanders far more than any plausible street deviation). */
  disconnectedRatioMin: number;
  /** unassigned points between the two letters, above this fraction of total route points, pushes toward DISCONNECTED. */
  disconnectedUnassignedFractionMin: number;
};

export function classifyTransition(record: TransitionRecord, totalRoutePoints: number, thresholds: TransitionClassificationThresholds): TransitionClass {
  if (record.routeDistance === null || record.straightLineDistance === null) return 'DISCONNECTED';
  const pointFraction = totalRoutePoints > 0 && record.numberOfRoutePointsBetween !== null ? record.numberOfRoutePointsBetween / totalRoutePoints : 0;
  if (record.routeDistance <= thresholds.shortDistanceMax || (record.routeToStraightRatio !== null && record.routeToStraightRatio <= thresholds.directRatioMax)) {
    return 'DIRECT';
  }
  if (
    (record.routeToStraightRatio !== null && record.routeToStraightRatio >= thresholds.disconnectedRatioMin) ||
    pointFraction >= thresholds.disconnectedUnassignedFractionMin
  ) {
    return 'DISCONNECTED';
  }
  if (record.routeToStraightRatio !== null && record.routeToStraightRatio > thresholds.directRatioMax) {
    return 'LONG_BUT_CONNECTED';
  }
  return 'AMBIGUOUS';
}

export { polylineLength };
