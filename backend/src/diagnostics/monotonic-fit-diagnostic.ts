/**
 * DEVELOPMENT ONLY. monotonicFit root-cause diagnostic — observation
 * only, never called from the live route-generation/scoring/gate path.
 *
 * EXACT formula traced directly from lib/shape-order.ts's private
 * progressConsistency() (Step 1, read in full again this task, not
 * relying on prior summaries):
 *
 *   progress[i] = projectPointOnPolyline(sampledRoute[i], targetPolyline).progress
 *     — for the per-letter call, sampledRoute=letterRoute (the filtered
 *     array) and targetPolyline=letterTarget, so progress is ALREADY
 *     letter-local (0..1 over just this letter).
 *   for each consecutive step: delta = current - previous
 *     if delta >= 0: positive += delta   (accumulates ALL forward movement, weighted by magnitude)
 *     else:          negative += -delta  (accumulates ALL backward movement, weighted by magnitude)
 *   monotonicFit = variation===0 ? 1 : positive / (positive + negative)
 *
 * CONFIRMED (Step 1's explicit question list): monotonicFit is NOT
 * categorical (it does not just count how many steps went backward) — it
 * is already magnitude-weighted: a single large reversal and many tiny
 * wiggles summing to the same total backward distance produce the exact
 * SAME penalty under the current formula, because both accumulate into
 * the same linear `negative` sum. This is the single most important
 * fact this diagnostic establishes about the current formula (Step 5B's
 * literal "penalize by magnitude rather than treating every step the
 * same" is therefore NOT a meaningfully different alternative to the
 * current formula — it's what the current formula already does; the
 * genuinely different variant tested here instead asks whether
 * SEVERITY should scale super-linearly with magnitude, see Variant B
 * below).
 *
 * Uses geometric target-PROGRESS (a 0..1 position along the letter's own
 * target polyline via projectPointOnPolyline), never raw geometric
 * distance. Assumes nothing about uniform sampling — letterRoute's own
 * point count and spacing directly change jumpAllow (already established
 * last task) but monotonicFit's own ratio is scale-invariant to point
 * COUNT in principle (though real routes with more points naturally
 * accumulate more small deltas, which is exactly Step 9's question).
 *
 * Reuses, unmodified: extractLetterOrderInputs/computeLetterOrderDecomposition
 * (order-score-diagnostic.ts, already parity-verified against production).
 */
import { projectPointOnPolyline, type Vec2 } from '@/lib/geometry';

import { extractLetterOrderInputs, computeLetterOrderDecomposition, type LetterOrderInputs } from './order-score-diagnostic';

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ---------------------------------------------------------------------------
// Step 2 — exact progress sequence extraction (mirrors progressConsistency's own first line)
// ---------------------------------------------------------------------------

export function extractProgressSequence(letterRoute: readonly Vec2[], letterTarget: readonly Vec2[]): number[] {
  return letterRoute.map((point) => projectPointOnPolyline(point, letterTarget).progress);
}

export type NegativeStep = { index: number; previousProgress: number; currentProgress: number; delta: number; magnitude: number };

export function findNegativeSteps(progress: readonly number[]): NegativeStep[] {
  const steps: NegativeStep[] = [];
  for (let i = 1; i < progress.length; i += 1) {
    const delta = progress[i]! - progress[i - 1]!;
    if (delta < 0) steps.push({ index: i, previousProgress: progress[i - 1]!, currentProgress: progress[i]!, delta, magnitude: -delta });
  }
  return steps;
}

export type ProgressSequenceStats = {
  pointCount: number;
  positiveStepCount: number;
  zeroStepCount: number;
  negativeStepCount: number;
  sumPositive: number;
  sumNegative: number;
  largestNegativeStep: number;
  medianNegativeStep: number;
};

export function summarizeProgressSequence(progress: readonly number[]): ProgressSequenceStats {
  let positiveStepCount = 0;
  let zeroStepCount = 0;
  let sumPositive = 0;
  let sumNegative = 0;
  const negatives: number[] = [];
  for (let i = 1; i < progress.length; i += 1) {
    const delta = progress[i]! - progress[i - 1]!;
    if (delta > 0) {
      positiveStepCount += 1;
      sumPositive += delta;
    } else if (delta === 0) {
      zeroStepCount += 1;
    } else {
      sumNegative += -delta;
      negatives.push(-delta);
    }
  }
  const sortedNeg = [...negatives].sort((a, b) => a - b);
  const median = sortedNeg.length ? sortedNeg[Math.floor(sortedNeg.length / 2)]! : 0;
  return {
    pointCount: progress.length,
    positiveStepCount,
    zeroStepCount,
    negativeStepCount: negatives.length,
    sumPositive,
    sumNegative,
    largestNegativeStep: negatives.length ? Math.max(...negatives) : 0,
    medianNegativeStep: median,
  };
}

// ---------------------------------------------------------------------------
// Step 5 — shadow monotonicity variants (real progress sequence in, real
// scoreOrderedPath's other components untouched, only monotonicFit's own
// formula varies).
// ---------------------------------------------------------------------------

/** Variant A: exact current formula — parity-verified against production in the self-test. */
export function monotonicFitCurrent(progress: readonly number[]): number {
  if (progress.length < 2) return 1;
  let positive = 0;
  let negative = 0;
  for (let i = 1; i < progress.length; i += 1) {
    const delta = progress[i]! - progress[i - 1]!;
    if (delta >= 0) positive += delta;
    else negative += -delta;
  }
  const variation = positive + negative;
  return variation === 0 ? 1 : positive / variation;
}

/**
 * Variant B: quadratic-magnitude backward penalty. The current formula
 * (Variant A) is ALREADY linear-magnitude-weighted (confirmed above) —
 * this variant instead makes severity scale SUPER-linearly with the size
 * of each individual backward step, so many tiny wiggles (each squared to
 * something much smaller than their linear sum) are penalized far less
 * than one equivalent-total-magnitude large reversal (whose square stays
 * large). This is the genuinely different alternative to "penalize by
 * magnitude" — the current formula already penalizes by magnitude; this
 * variant tests whether SEVERITY should be convex in magnitude instead of
 * linear.
 */
export function monotonicFitQuadratic(progress: readonly number[]): number {
  if (progress.length < 2) return 1;
  let positive = 0;
  let negativeSquared = 0;
  for (let i = 1; i < progress.length; i += 1) {
    const delta = progress[i]! - progress[i - 1]!;
    if (delta >= 0) positive += delta;
    else negativeSquared += delta * delta;
  }
  const negative = Math.sqrt(negativeSquared);
  const variation = positive + negative;
  return variation === 0 ? 1 : positive / variation;
}

/** Variant C: epsilon-tolerance — steps with |delta| <= epsilon are treated as neutral (neither positive nor negative), removing them entirely before the same current ratio formula runs. */
export function monotonicFitEpsilonTolerance(progress: readonly number[], epsilon: number): number {
  if (progress.length < 2) return 1;
  let positive = 0;
  let negative = 0;
  for (let i = 1; i < progress.length; i += 1) {
    const delta = progress[i]! - progress[i - 1]!;
    if (Math.abs(delta) <= epsilon) continue;
    if (delta >= 0) positive += delta;
    else negative += -delta;
  }
  const variation = positive + negative;
  return variation === 0 ? 1 : positive / variation;
}

/** Variant D: cumulative/net progress — (final-initial) / totalVariation, clamped to [0,1]. Unlike A, this credits a route for NET forward displacement rather than requiring every individual step to avoid contributing to a "negative" bucket; a route that ends up well past where it started scores well even if it wiggled substantially along the way, as long as the wiggling didn't erase the net gain. */
export function monotonicFitCumulative(progress: readonly number[]): number {
  if (progress.length < 2) return 1;
  let positive = 0;
  let negative = 0;
  for (let i = 1; i < progress.length; i += 1) {
    const delta = progress[i]! - progress[i - 1]!;
    if (delta >= 0) positive += delta;
    else negative += -delta;
  }
  const variation = positive + negative;
  if (variation === 0) return 1;
  const net = (progress[progress.length - 1]! - progress[0]!) ;
  return clamp01(net / variation);
}

/** Variant E: smoothed progress — a minimal, deterministic 3-point centered moving average applied to the progress sequence BEFORE running the current (Variant A) formula. Endpoints keep their own value (no wraparound, no invented boundary behavior). */
export function smoothProgressSequence(progress: readonly number[]): number[] {
  if (progress.length < 3) return [...progress];
  const smoothed = [...progress];
  for (let i = 1; i < progress.length - 1; i += 1) {
    smoothed[i] = (progress[i - 1]! + progress[i]! + progress[i + 1]!) / 3;
  }
  return smoothed;
}
export function monotonicFitSmoothed(progress: readonly number[]): number {
  return monotonicFitCurrent(smoothProgressSequence(progress));
}

export type MonotonicVariantKey = 'A_current' | 'B_quadratic' | 'C_eps01' | 'C_eps02' | 'C_eps03' | 'C_eps05' | 'D_cumulative' | 'E_smoothed';

export function evaluateMonotonicVariant(progress: readonly number[], key: MonotonicVariantKey): number {
  switch (key) {
    case 'A_current':
      return monotonicFitCurrent(progress);
    case 'B_quadratic':
      return monotonicFitQuadratic(progress);
    case 'C_eps01':
      return monotonicFitEpsilonTolerance(progress, 0.01);
    case 'C_eps02':
      return monotonicFitEpsilonTolerance(progress, 0.02);
    case 'C_eps03':
      return monotonicFitEpsilonTolerance(progress, 0.03);
    case 'C_eps05':
      return monotonicFitEpsilonTolerance(progress, 0.05);
    case 'D_cumulative':
      return monotonicFitCumulative(progress);
    case 'E_smoothed':
      return monotonicFitSmoothed(progress);
    default:
      return monotonicFitCurrent(progress);
  }
}

// ---------------------------------------------------------------------------
// Recombination — UNCHANGED weights throughout.
// ---------------------------------------------------------------------------

export function combineProgressFit(monotonicFit: number, jumpFit: number, revisitFit: number): number {
  return clamp01(0.5 * monotonicFit + 0.3 * jumpFit + 0.2 * revisitFit);
}
export function combineOrder(dtwFit: number, progressFit: number, directionFit: number): number {
  return clamp01(0.5 * dtwFit + 0.3 * progressFit + 0.2 * directionFit);
}

export { extractLetterOrderInputs, computeLetterOrderDecomposition, type LetterOrderInputs };
