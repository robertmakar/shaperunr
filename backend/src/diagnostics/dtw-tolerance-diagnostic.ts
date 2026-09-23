/**
 * DEVELOPMENT ONLY. Shadow DTW-tolerance evaluator — observation only,
 * never called from the live route generation/scoring/gate path.
 *
 * The previous diagnostic pass (order-score-diagnostic.ts) found that
 * dtwFit (weight 0.5 inside scoreOrderedPath's `order` formula) averages
 * near-zero even for well-covered, correctly-progressing, same-direction
 * letters, and identified `orderDistanceScale` — the distance budget
 * dtwFit is normalized against — as the specific suspect. This file tests
 * that hypothesis by calling the REAL, unmodified scoreOrderedPath() with
 * a scaled orderDistanceScale. orderDistanceScale is already an external
 * parameter scoreOrderedPath() accepts (see lib/shape-order.ts's
 * `options: { orderDistanceScale, coverageThreshold }`), so "shadow DTW
 * tolerance" requires NO changes to scoreOrderedPath, target-identity.ts,
 * or any production file — only a diagnostic caller that passes a
 * multiplied scale into the same real function.
 *
 * Reuses order-score-diagnostic.ts's extractLetterOrderInputs() (which
 * mirrors target-identity.ts's private per-letter input-selection logic
 * and already computes the production orderDistanceScale) so the ONLY
 * thing that varies across multipliers is orderDistanceScale itself —
 * DTW band, anchors, allowed steps, dtwFit/progressFit/directionFit
 * formulas, route/target extraction, coverage threshold, resampling, and
 * candidate selection are all identical at every multiplier because they
 * all come from the same LetterOrderInputs and the same real
 * scoreOrderedPath() call.
 */
import { scoreOrderedPath, type OrderMatchDetails } from '@/lib/shape-order';

import { TARGET_IDENTITY, type TargetIdentity } from '../generation/target-identity';
import { classifyDirection, type DirectionClass, type LetterOrderInputs } from './order-score-diagnostic';

export const DTW_TOLERANCE_MULTIPLIERS = [0.5, 1, 1.5, 2, 3] as const;
export type DtwToleranceMultiplier = (typeof DTW_TOLERANCE_MULTIPLIERS)[number];

/** Matches production's own `letterTarget.length>=2 && letterRoute.length>=2 ? scoreOrderedPath(...).order : 0` fallback (target-identity.ts's letterIdentities) exactly — NOT scoreOrderedPath's own emptyOrder(), which can return 1 for a fully-empty pair; production never reaches that branch. */
const ZERO_ORDER_DETAILS: OrderMatchDetails = {
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

/**
 * Real scoreOrderedPath() call, identical to production except
 * orderDistanceScale is multiplied by `multiplier`. At multiplier=1 this
 * is byte-identical to production's per-letter order (verified in the
 * self-test's exact-parity case).
 */
export function computeShadowOrderAtMultiplier(input: LetterOrderInputs, multiplier: number): OrderMatchDetails {
  if (input.letterTarget.length < 2 || input.letterRoute.length < 2) {
    return ZERO_ORDER_DETAILS;
  }
  return scoreOrderedPath(input.letterRoute, input.sampledTarget, input.letterTarget, {
    orderDistanceScale: input.orderDistanceScale * multiplier,
    coverageThreshold: input.coverageThreshold,
  });
}

export type LetterDtwToleranceRecord = {
  letter: string;
  index: number;
  direction: DirectionClass;
  /** Keyed by String(multiplier), e.g. "0.5", "1", "1.5", "2", "3". shadowByMultiplier["1"] is byte-identical to production's real per-letter OrderMatchDetails. */
  shadowByMultiplier: Record<string, OrderMatchDetails>;
};

export function computeLetterDtwToleranceRecord(input: LetterOrderInputs): LetterDtwToleranceRecord {
  const shadowByMultiplier: Record<string, OrderMatchDetails> = {};
  for (const multiplier of DTW_TOLERANCE_MULTIPLIERS) {
    shadowByMultiplier[String(multiplier)] = computeShadowOrderAtMultiplier(input, multiplier);
  }
  const atProduction = shadowByMultiplier['1']!;
  return {
    letter: input.letter,
    index: input.index,
    direction: classifyDirection(atProduction.monotonicFit, input.letterRoute.length),
    shadowByMultiplier,
  };
}

export type ShadowCandidateMultiplierSummary = {
  multiplier: number;
  /** existingCoverage (unchanged) >= 0.32 AND shadowOrder-at-this-multiplier >= 0.45 — the EXISTING meaningfullyVisited logic and EXISTING thresholds, only the order value fed into the ">= 0.45" half is swapped. */
  shadowCompletedLetterCount: number;
  shadowAllLettersCovered: boolean;
  shadowLettersVisitedInOrder: boolean;
  /** Mirrors target-identity.ts's exact traversesMostOfWord formula (letters.length<=1 ? occupiedSpan>=0.55 : allLettersCovered && lettersVisitedInOrder && occupiedSpan>=0.7) — occupiedSpan/targetSpan itself is UNCHANGED across multipliers; only which letters count as "covered" changes. */
  shadowWordTraversal: boolean;
};

/** Mirrors target-identity.ts's private isIncreasing() exactly. */
function isIncreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? 0) + 1e-6 < (values[index - 1] ?? 0)) {
      return false;
    }
  }
  return values.length > 0;
}

/**
 * `letterShadowOrders[multiplierIndex][letterIndex]` = the shadow order
 * value (OrderMatchDetails.order) for that letter at that multiplier —
 * i.e. shadowByMultiplier[String(multiplier)].order from
 * computeLetterDtwToleranceRecord, one row per DTW_TOLERANCE_MULTIPLIERS
 * entry, in the same order.
 */
export function computeShadowCandidateSummaries(
  identity: TargetIdentity,
  letterShadowOrders: readonly (readonly number[])[],
): ShadowCandidateMultiplierSummary[] {
  return DTW_TOLERANCE_MULTIPLIERS.map((multiplier, multiplierIndex) => {
    const shadowMeaningful = identity.letters.map((letterIdentity, letterIndex) => {
      const shadowOrder = letterShadowOrders[multiplierIndex]?.[letterIndex] ?? 0;
      return letterIdentity.coverage >= TARGET_IDENTITY.minLetterCoverage && shadowOrder >= TARGET_IDENTITY.minLetterOrder;
    });
    const completedCount = shadowMeaningful.filter(Boolean).length;
    const visitedStartProgress = identity.letters
      .filter((_, letterIndex) => shadowMeaningful[letterIndex])
      .map((letterIdentity) => letterIdentity.startProgress);
    const shadowLettersVisitedInOrder = isIncreasing(visitedStartProgress);
    const shadowAllLettersCovered = identity.letters.length > 0 && completedCount === identity.letters.length;
    const wordTraversalFraction = identity.letters.length === 0 ? 0 : completedCount / identity.letters.length;
    const shadowWordTraversal =
      identity.letters.length <= 1
        ? identity.targetSpan >= 0.55
        : wordTraversalFraction >= 1 && shadowLettersVisitedInOrder && identity.targetSpan >= 0.7;
    return {
      multiplier,
      shadowCompletedLetterCount: completedCount,
      shadowAllLettersCovered,
      shadowLettersVisitedInOrder,
      shadowWordTraversal,
    };
  });
}
