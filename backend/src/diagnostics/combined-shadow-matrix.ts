/**
 * DEVELOPMENT ONLY. Combined shadow evaluation matrix — tests connector-
 * exclusion (ink-only occupancy) and DTW tolerance (2x orderDistanceScale)
 * together and independently, against the EXACT existing per-letter
 * coverage threshold and the EXACT existing traversesMostOfWord formula
 * shape. Never called from the live route generation/scoring/gate path.
 *
 * Reuses, rather than reimplements, every previous diagnostic pass this
 * session produced:
 * - computeInkOnlyOccupancy (letter-occupancy.ts, UNCHANGED) for
 *   inkOnlyOccupancy / per-letter raw ink occupancy.
 * - extractLetterOrderInputs (order-score-diagnostic.ts, UNCHANGED) for the
 *   exact per-letter route/target slices production's letterIdentities()
 *   uses.
 * - computeShadowOrderAtMultiplier (dtw-tolerance-diagnostic.ts, UNCHANGED)
 *   for the real scoreOrderedPath() call at a scaled orderDistanceScale —
 *   used here at exactly 1x and 2x only, per this experiment's scope (no
 *   sweep; the sweep was already characterized in the previous pass).
 * - analyzeTargetIdentity / TARGET_IDENTITY (target-identity.ts, UNCHANGED)
 *   for currentOccupiedSpan, currentSpanOccupancy, existingCoverage, and
 *   the existing minLetterCoverage(0.32)/minLetterOrder(0.45) constants —
 *   NEVER redefined here.
 *
 * The four shadow conditions only ever swap two independent inputs into
 * the SAME traversesMostOfWord formula shape (mirrored, not reimplemented
 * from scratch — see computeConditionResult): which "global occupancy"
 * value gates (currentOccupiedSpan vs inkOnlyOccupancy) and which "order"
 * value feeds the per-letter meaningfullyVisited check (order at 1x vs
 * 2x). The per-letter coverage threshold (0.32) is identical in all four
 * conditions — this experiment never touches it.
 */
import { TARGET_IDENTITY, type TargetIdentity } from '../generation/target-identity';
import { computeShadowOrderAtMultiplier } from './dtw-tolerance-diagnostic';
import type { InkOnlyOccupancyResult } from './letter-occupancy';
import type { LetterOrderInputs } from './order-score-diagnostic';

export const SHADOW_CONDITIONS = ['A_current', 'B_inkOnly', 'C_dtw2x', 'D_combined'] as const;
export type ShadowCondition = (typeof SHADOW_CONDITIONS)[number];

/** Mirrors target-identity.ts's private isIncreasing() exactly. */
function isIncreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? 0) + 1e-6 < (values[index - 1] ?? 0)) {
      return false;
    }
  }
  return values.length > 0;
}

export type LetterShadowRecord = {
  letter: string;
  index: number;
  /** = InkOnlyOccupancyResult.perLetterOccupancy[index].occupancy, UNCHANGED. */
  rawInkCoverage: number;
  /** = TargetIdentity.letters[index].coverage, UNCHANGED — the existing per-letter coverage threshold (0.32) is applied to this same value in every condition. */
  existingCoverage: number;
  order1x: number;
  order2x: number;
  dtwFit1x: number;
  dtwFit2x: number;
  /** Multiplier-invariant (orderDistanceScale doesn't affect these components). */
  progressFit: number;
  directionFit: number;
  meaningfullyVisited1x: boolean;
  meaningfullyVisited2x: boolean;
  /** Section 7's four-way per-letter attribution: whether THIS letter individually clears coverage/order, independent of the candidate's global occupancy (a candidate-level concept, reported separately). */
  letterFailureMode: 'meaningfully_visited' | 'coverage_failure' | 'dtw_failure' | 'genuine_geometry_failure';
};

function classifyLetterFailureMode(existingCoverage: number, order2x: number): LetterShadowRecord['letterFailureMode'] {
  const coveragePasses = existingCoverage >= TARGET_IDENTITY.minLetterCoverage;
  const orderPasses = order2x >= TARGET_IDENTITY.minLetterOrder;
  if (coveragePasses && orderPasses) return 'meaningfully_visited';
  if (!coveragePasses && !orderPasses) return 'genuine_geometry_failure';
  if (!coveragePasses) return 'coverage_failure';
  return 'dtw_failure';
}

export function buildLetterShadowRecords(
  identity: TargetIdentity,
  inkResult: InkOnlyOccupancyResult,
  orderInputs: readonly LetterOrderInputs[],
): LetterShadowRecord[] {
  return identity.letters.map((letterIdentity, index) => {
    const input = orderInputs[index];
    const at1x = input ? computeShadowOrderAtMultiplier(input, 1) : null;
    const at2x = input ? computeShadowOrderAtMultiplier(input, 2) : null;
    const order1x = at1x?.order ?? letterIdentity.order;
    const order2x = at2x?.order ?? letterIdentity.order;
    return {
      letter: letterIdentity.letter,
      index,
      rawInkCoverage: inkResult.perLetterOccupancy[index]?.occupancy ?? 0,
      existingCoverage: letterIdentity.coverage,
      order1x,
      order2x,
      dtwFit1x: at1x?.dtwFit ?? 0,
      dtwFit2x: at2x?.dtwFit ?? 0,
      progressFit: at1x?.progressFit ?? 0,
      directionFit: at1x?.directionFit ?? 0,
      meaningfullyVisited1x: letterIdentity.coverage >= TARGET_IDENTITY.minLetterCoverage && order1x >= TARGET_IDENTITY.minLetterOrder,
      meaningfullyVisited2x: letterIdentity.coverage >= TARGET_IDENTITY.minLetterCoverage && order2x >= TARGET_IDENTITY.minLetterOrder,
      letterFailureMode: classifyLetterFailureMode(letterIdentity.coverage, order2x),
    };
  });
}

export type ConditionResult = {
  condition: ShadowCondition;
  globalOccupancyValue: number;
  globalOccupancyPass: boolean;
  completedLetterCount: number;
  allLettersCovered: boolean;
  lettersVisitedInOrder: boolean;
  wordTraversal: boolean;
};

const CONDITION_CONFIG: Record<ShadowCondition, { useInkOnly: boolean; orderField: 'meaningfullyVisited1x' | 'meaningfullyVisited2x' }> = {
  A_current: { useInkOnly: false, orderField: 'meaningfullyVisited1x' },
  B_inkOnly: { useInkOnly: true, orderField: 'meaningfullyVisited1x' },
  C_dtw2x: { useInkOnly: false, orderField: 'meaningfullyVisited2x' },
  D_combined: { useInkOnly: true, orderField: 'meaningfullyVisited2x' },
};

/** Mirrors target-identity.ts's exact traversesMostOfWord formula shape (letters.length<=1 ? occupiedSpan>=0.55 : allCovered && inOrder && occupancy>=0.7) for each of the four conditions, swapping only which occupancy value and which meaningfullyVisited flag feed it. */
export function computeConditionResults(
  identity: TargetIdentity,
  letters: readonly LetterShadowRecord[],
  currentOccupiedSpan: number,
  inkOnlyOccupancy: number,
): ConditionResult[] {
  return SHADOW_CONDITIONS.map((condition) => {
    const config = CONDITION_CONFIG[condition];
    const globalOccupancyValue = config.useInkOnly ? inkOnlyOccupancy : currentOccupiedSpan;
    const globalOccupancyPass = globalOccupancyValue >= 0.7;
    const meaningful = letters.map((letter) => letter[config.orderField]);
    const completedLetterCount = meaningful.filter(Boolean).length;
    const visitedStartProgress = identity.letters.filter((_, index) => meaningful[index]).map((letterIdentity) => letterIdentity.startProgress);
    const lettersVisitedInOrder = isIncreasing(visitedStartProgress);
    const allLettersCovered = identity.letters.length > 0 && completedLetterCount === identity.letters.length;
    const wordTraversal =
      identity.letters.length <= 1
        ? currentOccupiedSpan >= 0.55
        : allLettersCovered && lettersVisitedInOrder && globalOccupancyPass;
    return { condition, globalOccupancyValue, globalOccupancyPass, completedLetterCount, allLettersCovered, lettersVisitedInOrder, wordTraversal };
  });
}

export type CandidateClassification =
  | 'global_occupancy_rescued'
  | 'per_letter_coverage_rescued'
  | 'dtw_rescued'
  | 'combined_interaction'
  | 'occupancy_not_real_blocker'
  | 'dtw_not_real_blocker'
  | 'multiple_blockers'
  | 'still_fails'
  | 'already_passing';

/**
 * Section 8's candidate-level classification. `per_letter_coverage_rescued`
 * is included for completeness but is STRUCTURALLY IMPOSSIBLE to occur in
 * this experiment — the per-letter coverage threshold (0.32) is identical
 * in all four conditions (see CONDITION_CONFIG), so nothing in this matrix
 * can ever "rescue" a candidate via coverage alone. Any nonzero count here
 * would indicate a bug, not a finding.
 */
export function classifyCandidate(conditions: readonly ConditionResult[]): CandidateClassification {
  const byCondition = new Map(conditions.map((c) => [c.condition, c]));
  const a = byCondition.get('A_current')!;
  const b = byCondition.get('B_inkOnly')!;
  const c = byCondition.get('C_dtw2x')!;
  const d = byCondition.get('D_combined')!;

  const completionA = a.allLettersCovered && a.lettersVisitedInOrder;
  const completionC = c.allLettersCovered && c.lettersVisitedInOrder;

  if (a.wordTraversal) {
    return 'already_passing';
  }

  if (d.wordTraversal) {
    if (!a.globalOccupancyPass && b.globalOccupancyPass && completionA && !completionC) {
      return 'global_occupancy_rescued';
    }
    if (a.globalOccupancyPass && !completionA && completionC) {
      return 'dtw_rescued';
    }
    if (!a.globalOccupancyPass && b.globalOccupancyPass && !completionA && completionC) {
      return 'combined_interaction';
    }
    return 'combined_interaction';
  }

  // D still fails.
  if (b.globalOccupancyPass && !completionC) {
    return completionC === completionA ? 'occupancy_not_real_blocker' : 'multiple_blockers';
  }
  if (!b.globalOccupancyPass && completionC) {
    return 'dtw_not_real_blocker';
  }
  if (b.globalOccupancyPass && completionC) {
    // Both components individually satisfied but D still fails — must be the sequencing check specifically.
    return 'multiple_blockers';
  }
  return 'still_fails';
}
