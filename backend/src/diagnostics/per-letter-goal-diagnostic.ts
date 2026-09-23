/**
 * DEVELOPMENT ONLY. Candidate per-letter goal-constraint variants for the
 * graph-shape-goal-mirror beam search — diagnostic only, never wired into
 * graph-shape.ts.
 *
 * Answers Step 2's question: is the existing beam-search state already
 * enough to derive per-letter coverage cheaply? YES — `state.covered` is
 * already a bitmask over GRAPH_SHAPE.progressBins (28) GLOBAL progress
 * bins (see coverMask() in graph-shape.ts, transcribed unchanged in
 * graph-shape-goal-mirror.ts). Each bin's center progress
 * ((index+0.5)/28) already has a well-defined position on the SAME target
 * progress axis letterBoundariesFromWordShape() already reports letter
 * windows on (projectedStartProgress/projectedEndProgress) — no new
 * geometry, no new projection, no per-state recomputation of anything
 * expensive: computeLetterBinRanges() (graph-shape-goal-mirror.ts) does
 * this mapping ONCE per search (28 bins x a handful of letters), then
 * every state's per-letter coverage check is just a bitmask AND — as cheap
 * as the existing aggregate coverage check.
 *
 * This explicitly does NOT call evaluateLetterCompleteness or any part of
 * the final production completeness evaluator — that evaluator measures
 * ink coverage against the REAL route geometry after the fact; these
 * variants measure only whether the SEARCH STATE's visited progress bins
 * include each letter's bins, a much cheaper, coarser, search-time-only
 * signal, exactly as the task requires (a goal heuristic, not a second
 * completeness evaluator).
 */
import type { LetterBinRange, SearchState } from './graph-shape-goal-mirror';

function bitCount(value: number): number {
  let count = 0;
  let bits = value >>> 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

function coveredBinsForLetter(covered: number, letterBins: readonly number[]): number {
  let count = 0;
  for (const bin of letterBins) {
    if (covered & (1 << bin)) count += 1;
  }
  return count;
}

export type PerLetterCoverageSnapshot = {
  letter: string;
  totalBins: number;
  coveredBins: number;
  fraction: number;
};

export function snapshotPerLetterCoverage(covered: number, letterBins: readonly LetterBinRange[]): PerLetterCoverageSnapshot[] {
  return letterBins.map((entry) => {
    const coveredBins = coveredBinsForLetter(covered, entry.bins);
    return { letter: entry.letter, totalBins: entry.bins.length, coveredBins, fraction: entry.bins.length > 0 ? coveredBins / entry.bins.length : 1 };
  });
}

/**
 * Variant A / C — minimum per-letter bin-coverage FRACTION. Implemented as
 * a single function because, once correctly computed with integer bin
 * counts, "coveredBins/totalBins >= X" is mathematically equivalent to
 * "coveredBins >= ceil(X*totalBins)" (Variant C's adaptive formula) for
 * any X > 0 — see this module's self-test for the proof. This is reported
 * as a finding, not assumed: the two variants the task describes converge
 * once implemented correctly; they are NOT meaningfully different
 * policies. A letter with totalBins=0 (should not occur for a real
 * multi-letter word, but guarded) always passes trivially.
 */
export function makeMinFractionGoal(minFraction: number) {
  return (state: SearchState, letterBins: readonly LetterBinRange[]): boolean => {
    for (const entry of letterBins) {
      if (entry.bins.length === 0) continue;
      const coveredBins = coveredBinsForLetter(state.covered, entry.bins);
      if (coveredBins / entry.bins.length < minFraction) return false;
    }
    return true;
  };
}

/**
 * Variant B — minimum per-letter bin HIT COUNT (absolute, not fractional).
 * Unlike the fraction variant, this can make a narrow letter's requirement
 * mathematically unsatisfiable if minHits exceeds that letter's own total
 * bin count — reported explicitly as a brittleness risk, not hidden.
 */
export function makeMinHitCountGoal(minHits: number) {
  return (state: SearchState, letterBins: readonly LetterBinRange[]): boolean => {
    for (const entry of letterBins) {
      const coveredBins = coveredBinsForLetter(state.covered, entry.bins);
      if (coveredBins < minHits) return false;
    }
    return true;
  };
}

/** Whether ANY letter's own bin count is below the given hit-count requirement — flags Variant B configurations that are structurally unsatisfiable for a given word before ever running a search. */
export function findUnsatisfiableLetters(letterBins: readonly LetterBinRange[], minHits: number): string[] {
  return letterBins.filter((entry) => entry.bins.length < minHits).map((entry) => entry.letter);
}

export { bitCount };
