/**
 * DEVELOPMENT ONLY. Order-component decomposition and mathematical rescue-
 * scenario analysis — observation only, never called from the live route
 * generation/scoring/gate path.
 *
 * scoreOrderedPath() (lib/shape-order.ts, UNCHANGED) computes:
 *
 *   order = clamp01(0.5*dtwFit + 0.3*progressFit + 0.2*directionFit)
 *
 * and already RETURNS dtwFit, progressFit (itself
 * 0.5*monotonicFit + 0.3*jumpFit + 0.2*revisitFit), monotonicFit, jumpFit,
 * revisitFit, and directionFit directly in its OrderMatchDetails result —
 * see order-score-diagnostic.ts, which calls the real function and reads
 * those fields off with zero reimplementation. This file adds two things
 * NOT exposed by OrderMatchDetails, both purely arithmetic given the real
 * component values (never touching scoreOrderedPath or its inputs):
 *
 * 1. Per-segment angular-error statistics (mean/worst), mirroring
 *    shape-order.ts's private headingConsistency() loop exactly — verified
 *    in the self-test by reconstructing directionFit from the mirrored
 *    per-segment values and checking it matches the real directionFit
 *    exactly (see computeDirectionAngularStats's reconstructedDirectionFit).
 * 2. Mathematical "what-if" rescue scenarios: given the REAL production
 *    dtwFit/progressFit/directionFit for a letter, what would `order` be
 *    if one or more components were hypothetically perfect (=1), using the
 *    SAME 0.5/0.3/0.2 weights and clamp01 as the real formula (mirrored as
 *    ORDER_WEIGHTS, verified by a parity self-test that reconstructs the
 *    REAL order from REAL component values and checks it matches exactly).
 *    This never calls scoreOrderedPath with altered inputs — it is pure
 *    arithmetic over already-computed real outputs.
 */
import {
  distance2,
  headingRadians,
  projectPointOnPolyline,
  shortestAngleDelta,
  type Vec2,
} from '@/lib/geometry';
import type { OrderMatchDetails } from '@/lib/shape-order';

import { computeShadowOrderAtMultiplier } from './dtw-tolerance-diagnostic';
import { classifyDirection, type DirectionClass, type LetterOrderInputs } from './order-score-diagnostic';

/** Mirrors shape-order.ts's private clamp01() exactly. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Mirrors scoreOrderedPath()'s inline weights exactly (0.5*dtwFit + 0.3*progressFit + 0.2*directionFit) — verified by the self-test's contribution-math parity check, never redefined independently. */
export const ORDER_WEIGHTS = { dtw: 0.5, progress: 0.3, direction: 0.2 } as const;

export type DirectionAngularStats = {
  /** One entry per route segment that produced an actual target-heading comparison (i.e. NOT skipped as too far or degenerate), in path order, degrees. */
  angularErrorsDegrees: number[];
  meanAngularErrorDegrees: number | null;
  worstAngularErrorDegrees: number | null;
  /** Total route segments considered (nonzero-length consecutive pairs). */
  segmentCount: number;
  /** Segments that produced a real angular-error value. */
  validSegmentCount: number;
  /** Segments skipped because the route point projected farther than `far` from the target (matches headingConsistency's own `far` cutoff exactly) — these still count toward directionFit's length-weighted denominator but contribute 0 to its numerator, i.e. they are implicitly maximally penalized WITHOUT an actual angle ever being computed. */
  skippedFarCount: number;
  /** Segments skipped because the matched target segment was degenerate (near-zero length). */
  skippedDegenerateCount: number;
  /** Reconstructing directionFit from these same per-segment values (length-weighted, skipped segments contributing weight but 0 to the numerator) — must exactly equal the real directionFit (verified in the self-test). Proves this mirror is faithful. */
  reconstructedDirectionFit: number;
};

/** Mirrors shape-order.ts's private headingConsistency() loop exactly, but additionally collects and returns the per-segment angular errors it computes internally and then discards. */
export function computeDirectionAngularStats(
  sampledRoute: readonly Vec2[],
  targetPolyline: readonly Vec2[],
  coverageThreshold: number,
): DirectionAngularStats {
  const far = Math.max(coverageThreshold * 2, 1);
  const angularErrorsDegrees: number[] = [];
  let segmentCount = 0;
  let skippedFarCount = 0;
  let skippedDegenerateCount = 0;
  let totalWeight = 0;
  let weightedFitSum = 0;

  for (let index = 1; index < sampledRoute.length; index += 1) {
    const from = sampledRoute[index - 1];
    const to = sampledRoute[index];
    if (!from || !to) continue;
    const segment = distance2(from, to);
    if (segment < 1e-9) continue;
    segmentCount += 1;
    totalWeight += segment;

    const hit = projectPointOnPolyline(to, targetPolyline);
    if (hit.distance > far) {
      skippedFarCount += 1;
      continue;
    }
    const start = targetPolyline[hit.segmentIndex];
    const end = targetPolyline[hit.segmentIndex + 1] ?? start;
    if (!start || !end || distance2(start, end) < 1e-9) {
      skippedDegenerateCount += 1;
      continue;
    }
    const delta = Math.abs(shortestAngleDelta(headingRadians(from, to), headingRadians(start, end)));
    angularErrorsDegrees.push((delta * 180) / Math.PI);
    weightedFitSum += clamp01(1 - delta / (Math.PI / 2)) * segment;
  }

  return {
    angularErrorsDegrees,
    meanAngularErrorDegrees: angularErrorsDegrees.length ? angularErrorsDegrees.reduce((s, v) => s + v, 0) / angularErrorsDegrees.length : null,
    worstAngularErrorDegrees: angularErrorsDegrees.length ? Math.max(...angularErrorsDegrees) : null,
    segmentCount,
    validSegmentCount: angularErrorsDegrees.length,
    skippedFarCount,
    skippedDegenerateCount,
    reconstructedDirectionFit: totalWeight === 0 ? 0 : weightedFitSum / totalWeight,
  };
}

export type RescueScenarioKey =
  | 'A_perfectDtw'
  | 'B_perfectProgress'
  | 'C_perfectDirection'
  | 'D_perfectDtwProgress'
  | 'E_perfectDtwDirection'
  | 'F_perfectProgressDirection'
  | 'G_perfectAll';

export const RESCUE_SCENARIOS: RescueScenarioKey[] = [
  'A_perfectDtw',
  'B_perfectProgress',
  'C_perfectDirection',
  'D_perfectDtwProgress',
  'E_perfectDtwDirection',
  'F_perfectProgressDirection',
  'G_perfectAll',
];

/** Pure arithmetic "what-if" scenarios over REAL production component values — never re-invokes scoreOrderedPath with altered inputs. */
export function computeRescueScenarios(dtwFit: number, progressFit: number, directionFit: number): Record<RescueScenarioKey, number> {
  const orderOf = (d: number, p: number, dir: number) => clamp01(ORDER_WEIGHTS.dtw * d + ORDER_WEIGHTS.progress * p + ORDER_WEIGHTS.direction * dir);
  return {
    A_perfectDtw: orderOf(1, progressFit, directionFit),
    B_perfectProgress: orderOf(dtwFit, 1, directionFit),
    C_perfectDirection: orderOf(dtwFit, progressFit, 1),
    D_perfectDtwProgress: orderOf(1, 1, directionFit),
    E_perfectDtwDirection: orderOf(1, progressFit, 1),
    F_perfectProgressDirection: orderOf(dtwFit, 1, 1),
    G_perfectAll: orderOf(1, 1, 1),
  };
}

export type ComponentBoundClassification =
  | 'passing'
  | 'geometry_bound'
  | 'dtw_bound'
  | 'progress_bound'
  | 'direction_bound'
  | 'mixed';

const ORDER_THRESHOLD = 0.45; // TARGET_IDENTITY.minLetterOrder, reused as a reference comparison point only — not redefined.

/**
 * requiresDtw = true means: even with progress AND direction both perfect
 * (scenario F), order still falls short — so DTW specifically MUST improve
 * for this letter (task's exact "even perfect X+Y cannot rescue it without
 * improving Z" definition). Mirrors the same logic for progress/direction.
 */
export function classifyComponentBound(
  order: number,
  scenarios: Record<RescueScenarioKey, number>,
  letterRoutePointCount: number,
): ComponentBoundClassification {
  if (order >= ORDER_THRESHOLD) {
    return 'passing';
  }
  if (letterRoutePointCount < 2) {
    // Production hardcodes order=0 in this case (letterTarget.length>=2 && letterRoute.length>=2 ? scoreOrderedPath(...) : 0) — no
    // scoring-formula change can ever rescue a letter the route never got close enough to sample at all.
    return 'geometry_bound';
  }
  const requiresDtw = scenarios.F_perfectProgressDirection < ORDER_THRESHOLD;
  const requiresProgress = scenarios.E_perfectDtwDirection < ORDER_THRESHOLD;
  const requiresDirection = scenarios.D_perfectDtwProgress < ORDER_THRESHOLD;
  const requiredCount = Number(requiresDtw) + Number(requiresProgress) + Number(requiresDirection);
  if (requiredCount >= 2) {
    return 'mixed';
  }
  if (requiresDtw) return 'dtw_bound';
  if (requiresProgress) return 'progress_bound';
  if (requiresDirection) return 'direction_bound';
  // requiredCount === 0: order < 0.45 for the real letter, but at least one single-component-perfect scenario already clears 0.45 while holding the OTHER TWO at production — contradiction only if order itself already passed, which is excluded above; otherwise this means the letter is right at the boundary and is rescuable by any one of several components. Report as 'mixed' conservatively (more than one viable rescue path).
  return 'mixed';
}

export type LetterComponentDecomposition = {
  letter: string;
  index: number;
  direction: DirectionClass;
  order: OrderMatchDetails;
  dtwContribution: number;
  progressContribution: number;
  directionContribution: number;
  contributionSum: number;
  directionStats: DirectionAngularStats;
  scenarios: Record<RescueScenarioKey, number>;
  classification: ComponentBoundClassification;
};

export function computeLetterComponentDecomposition(input: LetterOrderInputs): LetterComponentDecomposition {
  const order = computeShadowOrderAtMultiplier(input, 1); // real production order (multiplier=1 is byte-identical to production, per dtw-tolerance-diagnostic.ts's own parity guarantee)
  const directionStats = computeDirectionAngularStats(input.letterRoute, input.letterTarget, input.coverageThreshold);
  const scenarios = computeRescueScenarios(order.dtwFit, order.progressFit, order.directionFit);
  const classification = classifyComponentBound(order.order, scenarios, input.letterRoute.length);
  return {
    letter: input.letter,
    index: input.index,
    direction: classifyDirection(order.monotonicFit, input.letterRoute.length),
    order,
    dtwContribution: ORDER_WEIGHTS.dtw * order.dtwFit,
    progressContribution: ORDER_WEIGHTS.progress * order.progressFit,
    directionContribution: ORDER_WEIGHTS.direction * order.directionFit,
    contributionSum: ORDER_WEIGHTS.dtw * order.dtwFit + ORDER_WEIGHTS.progress * order.progressFit + ORDER_WEIGHTS.direction * order.directionFit,
    directionStats,
    scenarios,
    classification,
  };
}
