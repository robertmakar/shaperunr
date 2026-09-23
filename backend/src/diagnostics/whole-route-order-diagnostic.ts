/**
 * DEVELOPMENT ONLY. Whole-route order metric diagnostic — observation
 * only, never called from the live route-generation/scoring/gate path.
 *
 * The Shadow Product-Gate task found the product gate's separate
 * whole-route `order >= 0.6` check (route.scoreBreakdown.order, NOT the
 * per-letter order investigated across the previous four diagnostics)
 * blocks 77/78 checkpoint-v1 candidates, mean 0.488. This file traces
 * that metric's EXACT implementation and tests whether the same
 * "measuring the wrong thing" pattern applies.
 *
 * EXACT implementation (Step 1, read directly from source again, not
 * relying on prior per-letter findings):
 *
 *   lib/shape-match.ts's scorePolylines(route, target, lengths, options):
 *     sampleCount = 80 (DEFAULT_SAMPLE_COUNT)
 *     sampledRoute = resamplePolyline(route, 80)   <- the FULL route, no
 *       letter filtering at all (this is the single biggest structural
 *       difference from per-letter order: there is no letterRoute-style
 *       .filter() step here, so the "filtered-array heading artifact"
 *       investigated for per-letter order literally cannot occur for
 *       whole-route order — every consecutive pair in sampledRoute is
 *       genuinely consecutive on the real route).
 *     sampledTarget = resamplePolyline(target, 80)
 *     targetBox = boundingBox2(target); minSpan = min(width,height)
 *     coverageThreshold = max(18, min(minSpan*0.22, targetLength*0.025))
 *     orderDistanceScale = max(minSpan*0.25, targetLength*0.04, 1e-6)
 *     orderDetails = scoreOrderedPath(sampledRoute, sampledTarget, target,
 *       {orderDistanceScale, coverageThreshold})
 *       <- CRITICAL: the third argument (targetPolyline, used inside
 *       scoreOrderedPath for projectPointOnPolyline) is `target` — the
 *       FULL, unsliced, WHOLE-WORD target polyline. This means progress
 *       values here are WORD-GLOBAL (0..1 over the entire word), unlike
 *       the per-letter call where targetPolyline=letterTarget made
 *       progress LETTER-LOCAL. Two direct consequences:
 *         (a) the 0.12 revisit-drop threshold in progressConsistency()
 *             now means 12% of the WHOLE WORD's length, not 12% of one
 *             letter — much more forgiving in absolute terms for a small
 *             wiggle within one letter, but still triggerable by a large
 *             cross-letter excursion.
 *         (b) jumpAllow = 4/(n-1) with n = sampledRoute.length = 80
 *             ALWAYS (not letter-route-count-dependent) — jumpAllow ≈
 *             0.0506 is CONSTANT across every candidate, unlike the
 *             per-letter case's highly variable jumpAllow (previously
 *             found to range 0.10-4.0). This removes the point-count
 *             calibration concern raised for per-letter order, but means
 *             ANY single 80-sample step that advances more than ~5% of
 *             the WHOLE WORD's progress (very plausible when a real
 *             street route jumps across an inter-letter connector) is
 *             penalized.
 *     order component weight in the FINAL shapeScore: 0.34 (DEFAULT_WEIGHTS.order)
 *       — NOT the product-gate's OWN direct order>=0.6 check, which reads
 *       route.scoreBreakdown.order (= orderDetails.order) directly,
 *       unweighted by the other shapeScore components.
 *
 *   scoreOrderedPath() itself (lib/shape-order.ts) is COMPLETELY UNCHANGED
 *   from the per-letter investigation — same dtwFit/progressFit/
 *   directionFit/order formula, same 0.5/0.3/0.2 sub-weights. This file
 *   reuses the SAME generic, already-proven shadow functions built for
 *   the per-letter investigation (monotonic-fit-diagnostic.ts's
 *   monotonicFitCurrent/progressConsistencyShadow, per-letter-order-
 *   diagnostic.ts's traceDirectionConsistency) — all of them operate on
 *   a generic (sampledRoute, targetPolyline) pair with no per-letter
 *   assumption, so they apply here UNCHANGED, without re-mirroring
 *   anything.
 *
 * Explicitly distinct from: per-letter order (letter-local progress,
 * letterRoute filtering), wordTraversal (built from per-letter
 * meaningfullyVisited), physical coverage (rawInk/coverage thresholds),
 * broad order (median global progress per letter), continuity
 * (route-space inter-letter distance) — none of those are read or
 * modified by this file.
 */
import { boundingBox2, polylineLength, projectPointOnPolyline, resamplePolyline, type Vec2 } from '@/lib/geometry';
import { scoreOrderedPath, type OrderMatchDetails } from '@/lib/shape-order';

import { monotonicFitCurrent } from './monotonic-fit-diagnostic';
import { progressConsistencyShadow } from './letter-order-component-diagnostic';
import { traceDirectionConsistency } from './per-letter-order-diagnostic';

export const WHOLE_ROUTE_ORDER_SAMPLE_COUNT = 80;

export function computeWholeRouteOrderParams(route: readonly Vec2[], target: readonly Vec2[]): { orderDistanceScale: number; coverageThreshold: number; targetLength: number; minSpan: number } {
  const targetLength = polylineLength(target);
  const targetBox = boundingBox2(target);
  const minSpan = Math.min(targetBox?.width ?? targetLength, targetBox?.height ?? targetLength);
  const coverageThreshold = Math.max(18, Math.min(minSpan * 0.22, targetLength * 0.025));
  const orderDistanceScale = Math.max(minSpan * 0.25, targetLength * 0.04, 1e-6);
  return { orderDistanceScale, coverageThreshold, targetLength, minSpan };
}

/** Re-derives the exact real whole-route order — parity-verified against scorePolylines() itself in the self-test. */
export function computeWholeRouteOrder(route: readonly Vec2[], target: readonly Vec2[]): OrderMatchDetails {
  const { orderDistanceScale, coverageThreshold } = computeWholeRouteOrderParams(route, target);
  const sampledRoute = resamplePolyline(route, WHOLE_ROUTE_ORDER_SAMPLE_COUNT);
  const sampledTarget = resamplePolyline(target, WHOLE_ROUTE_ORDER_SAMPLE_COUNT);
  return scoreOrderedPath(sampledRoute, sampledTarget, target, { orderDistanceScale, coverageThreshold });
}

// ---------------------------------------------------------------------------
// Step 3 — decomposition: progress sequence, negative steps, per-sample assignment.
// ---------------------------------------------------------------------------

export type WholeRouteProgressSample = {
  sampleIndex: number;
  point: Vec2;
  progress: number;
  perpendicularDistance: number;
};

export function extractWholeRouteProgressSequence(route: readonly Vec2[], target: readonly Vec2[]): WholeRouteProgressSample[] {
  const sampledRoute = resamplePolyline(route, WHOLE_ROUTE_ORDER_SAMPLE_COUNT);
  return sampledRoute.map((point, sampleIndex) => {
    const hit = projectPointOnPolyline(point, target);
    return { sampleIndex, point, progress: hit.progress, perpendicularDistance: hit.distance };
  });
}

export type NegativeStepRecord = { sampleIndex: number; previousProgress: number; currentProgress: number; magnitude: number };

export function findWholeRouteNegativeSteps(samples: readonly WholeRouteProgressSample[]): NegativeStepRecord[] {
  const steps: NegativeStepRecord[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const delta = samples[i]!.progress - samples[i - 1]!.progress;
    if (delta < 0) steps.push({ sampleIndex: i, previousProgress: samples[i - 1]!.progress, currentProgress: samples[i]!.progress, magnitude: -delta });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Step 5 — independent semantic reference (does NOT reuse scoreOrderedPath
// or any component of it): reuses the ALREADY-BUILT, separately-proven
// broad-order signal (median global progress of each letter's own
// route-assigned points, strictly increasing) from the physical-word-
// traversal-evaluator/evaluator-synthesis-diagnostic work.
// ---------------------------------------------------------------------------

export { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';

export { monotonicFitCurrent, progressConsistencyShadow, traceDirectionConsistency };
