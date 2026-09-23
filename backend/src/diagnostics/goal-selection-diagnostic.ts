/**
 * DEVELOPMENT ONLY. Goal-SELECTION diagnostic — the search runs ONCE,
 * unmodified (production goal: coverage >= 0.62 AND progress >= 0.88), and
 * every goal-passing state it goal-checks is captured through the mirror's
 * read-only SearchObserver. Treatments differ ONLY in which state of that
 * identical pool is returned. graph-shape.ts is never touched; the search,
 * cost function, beam, expansion cap and goal condition are never changed.
 *
 * Selected states are turned into routes by mirrorResultForState — the
 * mirror's own post-search tail (path, metrics, failure), so a selected
 * state is evaluated exactly as the search would have evaluated it.
 */
import type { Vec2 } from '@/lib/geometry';

import type { Directed, LetterBinRange, SearchObserver, SearchState } from './graph-shape-goal-mirror';
import { makeMinFractionGoal } from './per-letter-goal-diagnostic';
import type { LetterBoundary } from './multi-letter-trace';
import { GUARD_LIMITS, type GuardQuality } from '../generation/completion-goal-guards';

// The nine-guard fallback now lives in production (generation/completion-goal-guards.ts);
// re-exported here so every diagnostic keeps using the identical implementation.
export { GUARD_LIMITS, TWO_SIDED_LIMITS, twoSidedRouteTargetOk, evaluateTwoSidedGuard, type GuardQuality, type TwoSidedGuardResult } from '../generation/completion-goal-guards';

// ---------------------------------------------------------------------------
// Fixed parameters — declared before any corpus run.
// ---------------------------------------------------------------------------

export const SELECTION_PARAMS = {
  bandWide: 0.03,
  bandTight: 0.01,
  finalLetterMinFraction: 0.5,
} as const;

export type SelectorName = 'BASELINE_COST' | 'PROGRESS_BAND_03' | 'PROGRESS_BAND_01' | 'MAX_PROGRESS' | 'FINAL_LETTER_PROGRESS' | 'FINAL_LETTER_MIN_50';
export const SELECTORS: SelectorName[] = ['BASELINE_COST', 'PROGRESS_BAND_03', 'PROGRESS_BAND_01', 'MAX_PROGRESS', 'FINAL_LETTER_PROGRESS', 'FINAL_LETTER_MIN_50'];

// ---------------------------------------------------------------------------
// Goal pool capture.
// ---------------------------------------------------------------------------

export type GoalEntry = { state: SearchState; order: number; layer: number };

export type GoalPool = {
  goals: GoalEntry[];
  directed: ReadonlyMap<string, Directed>;
  /** The state the search itself returned (bestGoal ?? bestAny) — production's choice. */
  searchReturned: SearchState | null;
  searchReturnedWasGoal: boolean;
  expansions: number;
  finishReason: 'beam_exhausted' | 'max_expansions' | 'no_search';
};

export function createGoalPoolObserver(): { observer: SearchObserver; pool: () => GoalPool } {
  const goals: GoalEntry[] = [];
  let directed: ReadonlyMap<string, Directed> = new Map();
  let returned: SearchState | null = null;
  let returnedWasGoal = false;
  let expansions = 0;
  let finishReason: GoalPool['finishReason'] = 'no_search';
  const observer: SearchObserver = {
    onLayer: (_beam, _expansions, _layer, d) => {
      directed = d;
    },
    onGoal: (state, layer) => {
      goals.push({ state, order: goals.length, layer });
    },
    onFinish: (info) => {
      returned = info.best;
      returnedWasGoal = Boolean(info.bestGoal) && info.best === info.bestGoal;
      expansions = info.expansions;
      finishReason = info.reason;
    },
  };
  return { observer, pool: () => ({ goals, directed, searchReturned: returned, searchReturnedWasGoal: returnedWasGoal, expansions, finishReason }) };
}

// ---------------------------------------------------------------------------
// Selectors — pure functions over the SAME pool.
// ---------------------------------------------------------------------------

export type SelectionContext = { finalLetter: LetterBoundary; finalLetterBins: LetterBinRange };
export type Selection = { entry: GoalEntry | null; fellBack: boolean };

/** Production's rule, exactly: visit order, replace only on STRICTLY lower cost (so ties keep the earliest). */
function lowestCost(entries: readonly GoalEntry[]): GoalEntry | null {
  let best: GoalEntry | null = null;
  for (const e of entries) if (!best || e.state.cost < best.state.cost) best = e;
  return best;
}

export function finalLetterProgress(state: SearchState, finalLetter: LetterBoundary): number {
  const span = finalLetter.projectedEndProgress - finalLetter.projectedStartProgress;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (state.progress - finalLetter.projectedStartProgress) / span));
}

export function selectGoal(name: SelectorName, goals: readonly GoalEntry[], ctx: SelectionContext): Selection {
  if (goals.length === 0) return { entry: null, fellBack: false };
  const maxProgress = Math.max(...goals.map((g) => g.state.progress));
  switch (name) {
    case 'BASELINE_COST':
      return { entry: lowestCost(goals), fellBack: false };
    case 'PROGRESS_BAND_03':
      return { entry: lowestCost(goals.filter((g) => g.state.progress >= maxProgress - SELECTION_PARAMS.bandWide)), fellBack: false };
    case 'PROGRESS_BAND_01':
      return { entry: lowestCost(goals.filter((g) => g.state.progress >= maxProgress - SELECTION_PARAMS.bandTight)), fellBack: false };
    case 'MAX_PROGRESS':
      return { entry: lowestCost(goals.filter((g) => g.state.progress === maxProgress)), fellBack: false };
    case 'FINAL_LETTER_PROGRESS': {
      const key = (g: GoalEntry) => finalLetterProgress(g.state, ctx.finalLetter);
      const best = Math.max(...goals.map(key));
      return { entry: lowestCost(goals.filter((g) => key(g) === best)), fellBack: false };
    }
    case 'FINAL_LETTER_MIN_50': {
      // Selection-only: filters the SAME goal pool by the existing per-letter
      // bin-fraction check (makeMinFractionGoal) applied to the final letter
      // alone. It never runs inside the search, so it cannot change which
      // states are generated. If no goal state qualifies, the production
      // choice is kept (reported as a fallback).
      const check = makeMinFractionGoal(SELECTION_PARAMS.finalLetterMinFraction);
      const eligible = goals.filter((g) => check(g.state, [ctx.finalLetterBins]));
      return eligible.length ? { entry: lowestCost(eligible), fellBack: false } : { entry: lowestCost(goals), fellBack: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Pool statistics.
// ---------------------------------------------------------------------------

export type PoolStats = {
  goalCount: number;
  minProgress: number | null;
  maxProgress: number | null;
  medianProgress: number | null;
  cheapestCost: number | null;
  cheapestProgress: number | null;
  maxProgressGoalCost: number | null;
  progressGapCheapestToMax: number | null;
};

export function poolStats(goals: readonly GoalEntry[]): PoolStats {
  if (goals.length === 0) return { goalCount: 0, minProgress: null, maxProgress: null, medianProgress: null, cheapestCost: null, cheapestProgress: null, maxProgressGoalCost: null, progressGapCheapestToMax: null };
  const progresses = goals.map((g) => g.state.progress).sort((a, b) => a - b);
  const mid = Math.floor(progresses.length / 2);
  const cheapest = lowestCost(goals)!;
  const maxP = progresses[progresses.length - 1]!;
  const maxGoal = lowestCost(goals.filter((g) => g.state.progress === maxP))!;
  return {
    goalCount: goals.length,
    minProgress: progresses[0]!,
    maxProgress: maxP,
    medianProgress: progresses.length % 2 ? progresses[mid]! : (progresses[mid - 1]! + progresses[mid]!) / 2,
    cheapestCost: cheapest.state.cost,
    cheapestProgress: cheapest.state.progress,
    maxProgressGoalCost: maxGoal.state.cost,
    progressGapCheapestToMax: maxP - cheapest.state.progress,
  };
}

// ---------------------------------------------------------------------------
// Do-no-harm comparison (Step 18) — flags only; no aggregate score.
// ---------------------------------------------------------------------------

export type ComparableQuality = {
  shapeScore: number;
  targetCoverage: number;
  backtracking: number;
  routeTarget: number;
  feasible: boolean;
  wordTraversalPhysical: boolean;
  letters: Array<{ physicallyCovered: boolean; coverage: number; rawInk: number }>;
};

export const REGRESSION_LIMITS = { shapeDrop: 0.03, targetCoverageDrop: 0.05, backtrackRise: 0.05, routeTargetRelative: 0.25 } as const;

export function regressionFlags(base: ComparableQuality, treat: ComparableQuality): string[] {
  const flags: string[] = [];
  if (base.shapeScore - treat.shapeScore > REGRESSION_LIMITS.shapeDrop) flags.push('shape_drop');
  if (base.targetCoverage - treat.targetCoverage > REGRESSION_LIMITS.targetCoverageDrop) flags.push('targetCoverage_drop');
  if (treat.backtracking - base.backtracking > REGRESSION_LIMITS.backtrackRise) flags.push('backtrack_rise');
  // Route/target worsening: moved >25% (relative) AND ended farther from the ideal 1.0.
  if (base.routeTarget > 0 && Math.abs(treat.routeTarget - base.routeTarget) / base.routeTarget > REGRESSION_LIMITS.routeTargetRelative && Math.abs(treat.routeTarget - 1) > Math.abs(base.routeTarget - 1)) flags.push('routeTarget_worse');
  if (base.letters.some((l, i) => l.physicallyCovered && !treat.letters[i]?.physicallyCovered)) flags.push('lost_letter');
  if (base.feasible && !treat.feasible) flags.push('lost_feasibility');
  if (base.wordTraversalPhysical && !treat.wordTraversalPhysical) flags.push('lost_word_traversal');
  return flags;
}

/** Improvement is judged on the PRIMARY outcome only (final letter): gained physical completion, or final-letter coverage +0.05, or final-letter raw ink up. */
export function finalLetterImproved(base: ComparableQuality, treat: ComparableQuality): boolean {
  const b = base.letters[base.letters.length - 1];
  const t = treat.letters[treat.letters.length - 1];
  if (!b || !t) return false;
  return (t.physicallyCovered && !b.physicallyCovered) || t.coverage - b.coverage > 0.05 || t.rawInk > b.rawInk + 1e-9;
}

export type Outcome = 'identical' | 'improved_clean' | 'improved_with_regression' | 'regressed' | 'changed_neutral';

export function classifyOutcome(sameState: boolean, base: ComparableQuality, treat: ComparableQuality): { outcome: Outcome; flags: string[] } {
  if (sameState) return { outcome: 'identical', flags: [] };
  const flags = regressionFlags(base, treat);
  const improved = finalLetterImproved(base, treat);
  if (improved) return { outcome: flags.length ? 'improved_with_regression' : 'improved_clean', flags };
  return { outcome: flags.length ? 'regressed' : 'changed_neutral', flags };
}

export function pathOfState(state: SearchState, directed: ReadonlyMap<string, Directed>): Vec2[] {
  const points: Vec2[] = [];
  for (const id of state.edgeIds) {
    const edge = directed.get(id);
    if (!edge) continue;
    points.push(...(points.length ? edge.points.slice(1) : edge.points).map((p) => ({ ...p })));
  }
  return points;
}


// ---------------------------------------------------------------------------
// Post-search guard (guarded band selectors). Every guard is evaluated and
// reported independently; the candidate is accepted only if ALL pass,
// otherwise BASELINE_COST is returned unchanged. No aggregate score.
// ---------------------------------------------------------------------------


export type GuardResult = {
  feasibilityGuard: boolean;
  shapeGuard: boolean;
  coverageGuard: boolean;
  backtrackGuard: boolean;
  lengthRatioGuard: boolean;
  letterCoverageGuard: boolean;
  continuityGuard: boolean;
  accepted: boolean;
  rejectionReasons: string[];
};

export function evaluateSelectionGuard(base: GuardQuality, cand: GuardQuality): GuardResult {
  const g = {
    feasibilityGuard: cand.feasible === true,
    shapeGuard: cand.shapeScore >= base.shapeScore - GUARD_LIMITS.shapeDrop,
    coverageGuard: cand.targetCoverage >= base.targetCoverage - GUARD_LIMITS.targetCoverageDrop,
    backtrackGuard: cand.backtracking <= base.backtracking + GUARD_LIMITS.backtrackRise,
    lengthRatioGuard: cand.routeTarget <= base.routeTarget * GUARD_LIMITS.routeTargetFactor,
    letterCoverageGuard: base.letters.every((l, i) => !l.physicallyCovered || Boolean(cand.letters[i]?.physicallyCovered)),
    // "Existing continuity validity must remain true": only a valid -> invalid transition fails.
    continuityGuard: !(base.continuityValid && !cand.continuityValid),
  };
  const names: Record<keyof typeof g, string> = { feasibilityGuard: 'infeasible', shapeGuard: 'shape', coverageGuard: 'coverage', backtrackGuard: 'backtracking', lengthRatioGuard: 'route_target', letterCoverageGuard: 'letter_loss', continuityGuard: 'continuity' };
  const rejectionReasons = (Object.keys(g) as Array<keyof typeof g>).filter((k) => !g[k]).map((k) => names[k]);
  return { ...g, accepted: rejectionReasons.length === 0, rejectionReasons };
}

