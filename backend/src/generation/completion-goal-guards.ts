/**
 * Nine-guard fallback for completion-aware goal selection (production).
 *
 * Compares a completion-aware candidate route against the production-selected
 * (cheapest-goal) route. The candidate is accepted only if EVERY guard passes:
 *   1. feasibility          candidate has no graph-shape failure
 *   2. shapeScore           drops by at most GUARD_LIMITS.shapeDrop (0.03)
 *   3. target coverage      drops by at most GUARD_LIMITS.targetCoverageDrop (0.05)
 *   4. backtracking         rises by at most GUARD_LIMITS.backtrackRise (0.05)
 *   5. route/target         two-sided: at most 25% farther from the ideal 1.0
 *   6. earlier letters      no physically covered letter becomes uncovered
 *   7. final-letter coverage drops by at most 0.05
 *   8. final-letter raw ink  never decreases
 *   9. continuity           (production uses 'no_valid_to_invalid')
 * Moved verbatim from diagnostics/goal-selection-diagnostic.ts, where it was
 * validated; that module re-exports it so both use this single implementation.
 */

export const GUARD_LIMITS = { shapeDrop: 0.03, targetCoverageDrop: 0.05, backtrackRise: 0.05, routeTargetFactor: 1.25 } as const;

export type GuardQuality = {
  shapeScore: number;
  targetCoverage: number;
  backtracking: number;
  routeTarget: number;
  feasible: boolean;
  wordTraversalPhysical: boolean;
  letters: Array<{ physicallyCovered: boolean; coverage: number; rawInk: number }>;
  continuityValid: boolean;
};

// ---------------------------------------------------------------------------
// Two-sided route/target + final-letter guards.
// ---------------------------------------------------------------------------

export const TWO_SIDED_LIMITS = { idealRatio: 1.0, distanceFactor: 1.25, zeroDistanceTolerance: 0.05, finalCoverageDrop: 0.05 } as const;

export type TwoSidedGuardResult = {
  feasibilityGuard: boolean;
  shapeGuard: boolean;
  coverageGuard: boolean;
  backtrackGuard: boolean;
  twoSidedRouteTargetGuard: boolean;
  letterCoverageGuard: boolean;
  finalLetterCoverageGuard: boolean;
  finalLetterRawInkGuard: boolean;
  continuityGuard: boolean;
  accepted: boolean;
  rejectionReasons: string[];
};

/** Reject only if the candidate moves MORE than 25% farther from ratio 1.0 than the baseline (zero baseline distance: candidate must be within 0.05). */
export function twoSidedRouteTargetOk(baselineRatio: number, candidateRatio: number): boolean {
  const b = Math.abs(baselineRatio - TWO_SIDED_LIMITS.idealRatio);
  const c = Math.abs(candidateRatio - TWO_SIDED_LIMITS.idealRatio);
  // 1e-9 absorbs floating-point noise only (|1.05-1| = 0.05000000000000004); it is not a tolerance.
  const EPS = 1e-9;
  return b === 0 ? c <= TWO_SIDED_LIMITS.zeroDistanceTolerance + EPS : c <= b * TWO_SIDED_LIMITS.distanceFactor + EPS;
}

/**
 * continuityRule: 'candidate_valid' (default — as used by the two-sided
 * experiment: the candidate must be continuity-valid) or
 * 'no_valid_to_invalid' (only a valid → invalid transition fails, as in the
 * original guard set). Every other guard is identical in both modes.
 */
export function evaluateTwoSidedGuard(base: GuardQuality, cand: GuardQuality, options: { continuityRule?: 'candidate_valid' | 'no_valid_to_invalid' } = {}): TwoSidedGuardResult {
  const bf = base.letters[base.letters.length - 1];
  const cf = cand.letters[cand.letters.length - 1];
  const g = {
    feasibilityGuard: cand.feasible === true,
    shapeGuard: cand.shapeScore >= base.shapeScore - GUARD_LIMITS.shapeDrop,
    coverageGuard: cand.targetCoverage >= base.targetCoverage - GUARD_LIMITS.targetCoverageDrop,
    backtrackGuard: cand.backtracking <= base.backtracking + GUARD_LIMITS.backtrackRise,
    twoSidedRouteTargetGuard: twoSidedRouteTargetOk(base.routeTarget, cand.routeTarget),
    letterCoverageGuard: base.letters.every((l, i) => !l.physicallyCovered || Boolean(cand.letters[i]?.physicallyCovered)),
    // Final letter = last entry of the letter list (derived from the WordShape boundaries; never hard-coded).
    finalLetterCoverageGuard: Boolean(bf && cf) && cf!.coverage >= bf!.coverage - TWO_SIDED_LIMITS.finalCoverageDrop,
    finalLetterRawInkGuard: Boolean(bf && cf) && cf!.rawInk >= bf!.rawInk,
    // As specified for this experiment: the CANDIDATE must be continuity-valid (stricter than the previous valid->invalid rule).
    continuityGuard: (options.continuityRule ?? 'candidate_valid') === 'candidate_valid' ? cand.continuityValid === true : !(base.continuityValid && !cand.continuityValid),
  };
  const names: Record<keyof typeof g, string> = { feasibilityGuard: 'infeasible', shapeGuard: 'shape', coverageGuard: 'coverage', backtrackGuard: 'backtracking', twoSidedRouteTargetGuard: 'route_target_2sided', letterCoverageGuard: 'letter_loss', finalLetterCoverageGuard: 'final_coverage', finalLetterRawInkGuard: 'final_raw_ink', continuityGuard: 'continuity' };
  const rejectionReasons = (Object.keys(g) as Array<keyof typeof g>).filter((k) => !g[k]).map((k) => names[k]);
  return { ...g, accepted: rejectionReasons.length === 0, rejectionReasons };
}
