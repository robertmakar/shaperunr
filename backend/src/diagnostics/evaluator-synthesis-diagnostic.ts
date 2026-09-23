/**
 * DEVELOPMENT ONLY. Evaluator-synthesis diagnostic — the culminating pass
 * of this investigation's order-metric work. Observation only, never
 * called from the live route-generation/scoring/gate path.
 *
 * The prior three diagnostics each ruled out a single-component
 * hypothesis (letterRoute window, filtered-heading artifact, jumpAllow,
 * revisit threshold, monotonicFit, DTW individually). This module stops
 * asking "which constant is broken" and instead:
 * (a) classifies letters into diagnostic physical-quality populations
 *     from rawInk/coverage (computeInkOnlyOccupancy, unchanged) and
 *     compares their REAL order components across populations;
 * (b) computes, per letter, the exact component value each of D/P/G
 *     would independently need to reach order>=0.45 given the OTHER two
 *     held at their real values (pure algebra on the real, unmodified
 *     0.5D+0.3P+0.2G formula — never a new formula);
 * (c) computes counterfactual order-weighting variants (A-F) — always
 *     recombining the SAME real D/P/G values, never inventing new
 *     component math;
 * (d) computes "broad target order" — whether the MEDIAN global target
 *     progress of each letter's own route-assigned points increases in
 *     word order — as a diagnostic-only candidate-level ordering signal,
 *     distinct from the existing per-letter order score.
 *
 * Reuses, unmodified: extractLetterOrderInputs/computeLetterOrderDecomposition
 * (order-score-diagnostic.ts, already parity-verified against production),
 * computeInkOnlyOccupancy (letter-occupancy.ts).
 */
import { projectPointOnPolyline, type Vec2 } from '@/lib/geometry';

import { extractLetterOrderInputs, computeLetterOrderDecomposition, type LetterOrderInputs } from './order-score-diagnostic';

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ---------------------------------------------------------------------------
// Step 2 — physical-quality diagnostic populations (NOT production thresholds)
// ---------------------------------------------------------------------------

export type PhysicalBucket = 'A_ink90_cov50' | 'B_ink80_cov50' | 'C_ink70_cov40' | 'below_C';

export function classifyPhysicalBucket(rawInk: number, coverage: number): PhysicalBucket {
  if (rawInk >= 0.9 && coverage >= 0.5) return 'A_ink90_cov50';
  if (rawInk >= 0.8 && coverage >= 0.5) return 'B_ink80_cov50';
  if (rawInk >= 0.7 && coverage >= 0.4) return 'C_ink70_cov40';
  return 'below_C';
}

// ---------------------------------------------------------------------------
// Step 4/5 — required-component algebra on the REAL, unmodified 0.5D+0.3P+0.2G formula
// ---------------------------------------------------------------------------

export type RequiredComponents = { dRequired: number; pRequired: number; gRequired: number };

/** Pure algebra: given the real D/P/G, what value would EACH need alone (holding the other two at their real values) to reach `target` (default 0.45)? No clamping applied here — negative/over-1 values are meaningful diagnostic signal (see Step 5's bucket definitions), clamping happens only when reporting "achievable" fractions. */
export function computeRequiredComponents(dtwFit: number, progressFit: number, directionFit: number, target = 0.45): RequiredComponents {
  return {
    dRequired: (target - 0.3 * progressFit - 0.2 * directionFit) / 0.5,
    pRequired: (target - 0.5 * dtwFit - 0.2 * directionFit) / 0.3,
    gRequired: (target - 0.5 * dtwFit - 0.3 * progressFit) / 0.2,
  };
}

export type RequiredBucket = 'le0' | 'r0_25' | 'r25_50' | 'r50_75' | 'r75_100' | 'gt1';

export function classifyRequiredBucket(value: number): RequiredBucket {
  if (value <= 0) return 'le0';
  if (value <= 0.25) return 'r0_25';
  if (value <= 0.5) return 'r25_50';
  if (value <= 0.75) return 'r50_75';
  if (value <= 1) return 'r75_100';
  return 'gt1';
}

// ---------------------------------------------------------------------------
// Step 7 — counterfactual order-weighting variants (recombine REAL D/P/G only)
// ---------------------------------------------------------------------------

export type OrderWeightVariantKey = 'A_current' | 'B_equal' | 'C_coverage_oriented' | 'D_physical_traversal' | 'E_dtw_light' | 'F_progress_direction_only';

export const ORDER_WEIGHT_VARIANTS: Record<OrderWeightVariantKey, { d: number; p: number; g: number }> = {
  A_current: { d: 0.5, p: 0.3, g: 0.2 },
  B_equal: { d: 1 / 3, p: 1 / 3, g: 1 / 3 },
  C_coverage_oriented: { d: 0.25, p: 0.25, g: 0.5 },
  D_physical_traversal: { d: 0.2, p: 0.5, g: 0.3 },
  E_dtw_light: { d: 0.1, p: 0.5, g: 0.4 },
  F_progress_direction_only: { d: 0, p: 0.5, g: 0.5 },
};

export function evaluateOrderWeightVariant(dtwFit: number, progressFit: number, directionFit: number, key: OrderWeightVariantKey): number {
  const w = ORDER_WEIGHT_VARIANTS[key];
  return clamp01(w.d * dtwFit + w.p * progressFit + w.g * directionFit);
}

// ---------------------------------------------------------------------------
// Step 10 — "broad target order": median GLOBAL progress of each letter's
// own route-assigned points, checked for word-order monotonicity.
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Median of the letter's own letterRoute points, projected onto the FULL (word-level) target — a single representative "where did this letter's assigned route points actually sit in the whole word" position, independent of the per-letter order score. */
export function medianGlobalProgress(letterRoute: readonly Vec2[], fullTarget: readonly Vec2[]): number | null {
  if (letterRoute.length === 0) return null;
  const progresses = letterRoute.map((point) => projectPointOnPolyline(point, fullTarget).progress);
  return median(progresses);
}

/** Broad order: strictly increasing medians (small tolerance for equality), skipping letters with no assigned points (null median) — a missing letter breaks broad order by definition (Step 10's "number with missing letters" is reported separately by the caller). */
export function evaluateBroadOrder(medians: ReadonlyArray<number | null>, tolerance = 1e-6): { inOrder: boolean; hasMissing: boolean } {
  const hasMissing = medians.some((m) => m === null);
  if (hasMissing) return { inOrder: false, hasMissing: true };
  const values = medians as number[];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i]! + tolerance < values[i - 1]!) return { inOrder: false, hasMissing: false };
  }
  return { inOrder: true, hasMissing: false };
}

export { extractLetterOrderInputs, computeLetterOrderDecomposition, type LetterOrderInputs };
