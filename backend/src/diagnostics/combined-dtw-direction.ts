/**
 * DEVELOPMENT ONLY. Final combined shadow experiment — DTW tolerance (2x
 * orderDistanceScale) and direction angular tolerance (135 degree scale)
 * tested together and independently against the exact production order
 * formula and the exact production per-letter coverage/traversal logic.
 * Never called from the live route generation/scoring/gate path.
 *
 * Reuses, never reimplements, every previous diagnostic pass this session
 * produced:
 * - computeShadowOrderAtMultiplier (dtw-tolerance-diagnostic.ts, UNCHANGED)
 *   for the real scoreOrderedPath() call at a scaled orderDistanceScale.
 * - computeShadowDirectionFit (direction-tolerance-diagnostic.ts,
 *   UNCHANGED) for the real headingConsistency() mirror at a scaled
 *   angular-penalty scale.
 * - extractLetterOrderInputs (order-score-diagnostic.ts, UNCHANGED) for
 *   the exact per-letter route/target slices production's
 *   letterIdentities() uses.
 * - TARGET_IDENTITY constants (target-identity.ts, UNCHANGED) — the
 *   per-letter coverage (0.32) / order (0.45) thresholds, NEVER redefined.
 *
 * orderDistanceScale only affects dtwFit; the angular scale only affects
 * directionFit; progressFit is untouched by either — all confirmed
 * directly from scoreOrderedPath's own source (each of dtwFit/progressFit/
 * directionFit is computed by an independent helper taking only the
 * parameters it needs). This lets the four conditions below reuse a
 * SINGLE real scoreOrderedPath() call (for production dtwFit/progressFit/
 * directionFit) plus two additional real-formula calls (2x DTW, 135deg
 * direction) per letter — never four full re-scorings.
 */
import { scoreOrderedPath, type OrderMatchDetails } from '@/lib/shape-order';

import { TARGET_IDENTITY, type TargetIdentity } from '../generation/target-identity';
import { computeShadowOrderAtMultiplier } from './dtw-tolerance-diagnostic';
import { computeShadowDirectionFit } from './direction-tolerance-diagnostic';
import { classifyDirection, type DirectionClass, type LetterOrderInputs } from './order-score-diagnostic';

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

const DTW_2X = 2;
const DIRECTION_135 = 135;

export type CombinedConditionKey = 'A_production' | 'B_dtw2x' | 'C_direction135' | 'D_combined';
export const COMBINED_CONDITIONS: CombinedConditionKey[] = ['A_production', 'B_dtw2x', 'C_direction135', 'D_combined'];

export type LetterCombinedRecord = {
  letter: string;
  index: number;
  rawInkCoverage: number;
  existingCoverage: number;
  dtwFit1x: number;
  dtwFit2x: number;
  progressFit: number;
  directionFit90: number;
  directionFit135: number;
  monotonicFit: number;
  jumpFit: number;
  revisitFit: number;
  direction: DirectionClass;
  meanAngularErrorDegrees: number | null;
  orderA: number;
  orderB: number;
  orderC: number;
  orderD: number;
  meaningfullyVisited: Record<CombinedConditionKey, boolean>;
  routePointCount: number;
};

function orderOf(dtw: number, progress: number, direction: number): number {
  return clamp01(0.5 * dtw + 0.3 * progress + 0.2 * direction);
}

/** rawInkCoverage is passed in (computed by letter-occupancy.ts's computeInkOnlyOccupancy, UNCHANGED) rather than recomputed here — this module owns only the DTW/direction shadow combination. */
export function computeLetterCombinedRecord(input: LetterOrderInputs, existingCoverage: number, rawInkCoverage: number): LetterCombinedRecord {
  const hasData = input.letterTarget.length >= 2 && input.letterRoute.length >= 2;
  const real: OrderMatchDetails = hasData
    ? scoreOrderedPath(input.letterRoute, input.sampledTarget, input.letterTarget, { orderDistanceScale: input.orderDistanceScale, coverageThreshold: input.coverageThreshold })
    : { dtwFit: 0, dtwMeanDistanceMeters: Infinity, warpFit: 0, monotonicFit: 0, jumpFit: 0, revisitFit: 0, directionFit: 0, progressFit: 0, order: 0 };
  const dtw2x = hasData ? computeShadowOrderAtMultiplier(input, DTW_2X) : real;
  const direction135 = hasData ? computeShadowDirectionFit(input.letterRoute, input.letterTarget, input.coverageThreshold, 1, DIRECTION_135) : 0;

  const orderA = real.order;
  const orderB = orderOf(dtw2x.dtwFit, real.progressFit, real.directionFit);
  const orderC = orderOf(real.dtwFit, real.progressFit, direction135);
  const orderD = orderOf(dtw2x.dtwFit, real.progressFit, direction135);

  const meaningfullyVisited: Record<CombinedConditionKey, boolean> = {
    A_production: existingCoverage >= TARGET_IDENTITY.minLetterCoverage && orderA >= TARGET_IDENTITY.minLetterOrder,
    B_dtw2x: existingCoverage >= TARGET_IDENTITY.minLetterCoverage && orderB >= TARGET_IDENTITY.minLetterOrder,
    C_direction135: existingCoverage >= TARGET_IDENTITY.minLetterCoverage && orderC >= TARGET_IDENTITY.minLetterOrder,
    D_combined: existingCoverage >= TARGET_IDENTITY.minLetterCoverage && orderD >= TARGET_IDENTITY.minLetterOrder,
  };

  return {
    letter: input.letter,
    index: input.index,
    rawInkCoverage,
    existingCoverage,
    dtwFit1x: real.dtwFit,
    dtwFit2x: dtw2x.dtwFit,
    progressFit: real.progressFit,
    directionFit90: real.directionFit,
    directionFit135: direction135,
    monotonicFit: real.monotonicFit,
    jumpFit: real.jumpFit,
    revisitFit: real.revisitFit,
    direction: classifyDirection(real.monotonicFit, input.letterRoute.length),
    meanAngularErrorDegrees: null, // filled in by the runner from direction-tolerance-diagnostic.ts's computeDirectionSegmentStats when needed — kept out of the hot path here to avoid a second full segment walk per letter
    orderA,
    orderB,
    orderC,
    orderD,
    meaningfullyVisited,
    routePointCount: input.letterRoute.length,
  };
}

function isIncreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? 0) + 1e-6 < (values[index - 1] ?? 0)) {
      return false;
    }
  }
  return values.length > 0;
}

export type ConditionCandidateResult = {
  condition: CombinedConditionKey;
  completedLetterCount: number;
  allLettersCovered: boolean;
  lettersVisitedInOrder: boolean;
  wordTraversal: boolean;
};

/** Mirrors target-identity.ts's exact traversesMostOfWord formula shape. Occupancy (currentOccupiedSpan) is UNCHANGED across all four conditions — this experiment only ever swaps dtwFit/directionFit inputs, never occupancy. */
export function computeCombinedConditionResults(identity: TargetIdentity, letters: readonly LetterCombinedRecord[]): ConditionCandidateResult[] {
  return COMBINED_CONDITIONS.map((condition) => {
    const meaningful = letters.map((letter) => letter.meaningfullyVisited[condition]);
    const completedLetterCount = meaningful.filter(Boolean).length;
    const visitedStartProgress = identity.letters.filter((_, index) => meaningful[index]).map((letterIdentity) => letterIdentity.startProgress);
    const lettersVisitedInOrder = isIncreasing(visitedStartProgress);
    const allLettersCovered = identity.letters.length > 0 && completedLetterCount === identity.letters.length;
    const wordTraversal =
      identity.letters.length <= 1
        ? identity.targetSpan >= 0.55
        : allLettersCovered && lettersVisitedInOrder && identity.targetSpan >= 0.7;
    return { condition, completedLetterCount, allLettersCovered, lettersVisitedInOrder, wordTraversal };
  });
}

export type RemainingFailureClass =
  | 'passing'
  | 'never_reached'
  | 'physical_coverage_failure'
  | 'dtw_residual'
  | 'direction_residual'
  | 'progress_failure'
  | 'multi_component_failure';

/** Diagnostic-only "still weak" bar for D's own actual component values — 0.5 is a labeling convenience, not a production threshold. */
const RESIDUAL_WEAK_BAR = 0.5;

/** Classifies WHY a letter still fails under condition D, based on which of D's own three actual values (dtwFit2x, progressFit, directionFit135) remains weak — a descriptive attribution, distinct from order-component-rescue.ts's mathematical rescue-scenario proof (which already showed single-component-bound is structurally impossible; this asks which of the THREE ACTUAL values is the weak link, not which theoretical rescue path exists). */
export function classifyRemainingFailure(letter: LetterCombinedRecord): RemainingFailureClass {
  if (letter.meaningfullyVisited.D_combined) {
    return 'passing';
  }
  if (letter.routePointCount < 2) {
    return 'never_reached';
  }
  if (letter.existingCoverage < TARGET_IDENTITY.minLetterCoverage) {
    return 'physical_coverage_failure';
  }
  const weakDtw = letter.dtwFit2x < RESIDUAL_WEAK_BAR;
  const weakDirection = letter.directionFit135 < RESIDUAL_WEAK_BAR;
  const weakProgress = letter.progressFit < RESIDUAL_WEAK_BAR;
  const weakCount = Number(weakDtw) + Number(weakDirection) + Number(weakProgress);
  if (weakCount >= 2) return 'multi_component_failure';
  if (weakDtw) return 'dtw_residual';
  if (weakDirection) return 'direction_residual';
  if (weakProgress) return 'progress_failure';
  return 'multi_component_failure';
}
