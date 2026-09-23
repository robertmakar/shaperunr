/**
 * DEVELOPMENT ONLY. Word-aware jump-allowance calibration diagnostic —
 * observation only, never called from the live route-generation/scoring/
 * gate path.
 *
 * Established (prior task): mean jumpFit = 0.0000 across the entire real
 * corpus for whole-route order, because jumpAllow = 4/(n-1) with n=80
 * FIXED gives a tiny, word-structure-blind ≈0.0506 allowance, which any
 * real inter-letter transition (progress advancing across just 1-2 of the
 * 80 resample steps) routinely exceeds.
 *
 * EXACT mechanics traced again from lib/shape-order.ts's private
 * progressConsistency() (Step 1, re-read directly, not assumed):
 *
 *   jumpAllow = 4 / max(progress.length-1, 1)
 *     — this is a PER-STEP tolerance: how much forward progress a single
 *     consecutive sample-to-sample step is allowed to cover before being
 *     treated as "too large a jump to be normal incremental movement."
 *     Nothing in the formula or its 4-unit numerator encodes anything
 *     about letters, words, or target structure — it is purely a
 *     function of how many samples the route was resampled to. Given
 *     scorePolylines() ALWAYS resamples to exactly 80, jumpAllow is
 *     effectively a HARD-CODED CONSTANT (~0.0506) for every whole-route
 *     call regardless of word length or letter count.
 *   skipAmount = sum over all consecutive-step deltas of max(0, delta - jumpAllow)
 *     — accumulates ONLY the EXCESS of positive (forward) deltas beyond
 *     jumpAllow; negative deltas never contribute (max(0, negative) = 0).
 *     This means skipAmount specifically measures "how much forward
 *     progress happened in single big leaps rather than smooth
 *     increments" — its apparent intent is to catch a route that
 *     teleports/skips across the target rather than walking it, i.e. a
 *     SAMPLING-DISCONTINUITY or SKIPPED-COVERAGE detector, not a
 *     word-structure detector. It has no knowledge of where letter
 *     boundaries are.
 *   jumpFit = clamp01(1 - skipAmount/0.35)
 *     — a single large jump (or a few moderate ones) can exhaust the
 *     0.35 budget and clamp jumpFit to exactly 0; there is no partial
 *     credit below that floor.
 *
 * This file adds boundary classification (Step 2) and 5 alternative
 * calibration models (Step 3), all recombined via the SAME, unmodified
 * monotonicFit/revisitFit computation and the SAME order weights — only
 * jumpAllow's calibration is varied.
 */
import { projectPointOnPolyline, resamplePolyline, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import { WHOLE_ROUTE_ORDER_SAMPLE_COUNT, extractWholeRouteProgressSequence } from './whole-route-order-diagnostic';

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ---------------------------------------------------------------------------
// Step 2 — classify every large positive whole-route progress jump against
// the REAL letter boundaries (letterBoundariesFromWordShape, unchanged).
// ---------------------------------------------------------------------------

export type JumpClassification = 'A_expected_transition' | 'B_within_letter' | 'C_potentially_incorrect';

export type ProgressJumpRecord = {
  sampleIndex: number;
  previousProgress: number;
  currentProgress: number;
  delta: number;
  classification: JumpClassification;
  /** The letter-boundary gap this jump was matched against, if any (A only). */
  matchedTransition: { fromLetter: string; toLetter: string } | null;
};

/** A jump is an "expected inter-letter transition" if it starts inside (or just before) one letter's projected range and ends inside (or just after) the very next letter's projected range — matched against the target's own real boundaries, never the production jumpFit result. */
export function classifyProgressJumps(progress: readonly { progress: number }[], boundaries: readonly LetterBoundary[], detectionThreshold: number): ProgressJumpRecord[] {
  const records: ProgressJumpRecord[] = [];
  for (let i = 1; i < progress.length; i += 1) {
    const previous = progress[i - 1]!.progress;
    const current = progress[i]!.progress;
    const delta = current - previous;
    if (delta <= detectionThreshold) continue;

    let classification: JumpClassification = 'C_potentially_incorrect';
    let matchedTransition: { fromLetter: string; toLetter: string } | null = null;
    for (let b = 0; b + 1 < boundaries.length; b += 1) {
      const from = boundaries[b]!;
      const to = boundaries[b + 1]!;
      const startsInOrBeforeFrom = previous <= from.projectedEndProgress + 0.02;
      const startsAfterFromBegins = previous >= from.projectedStartProgress - 0.02;
      const endsInOrAfterTo = current >= to.projectedStartProgress - 0.02;
      const endsBeforeToFinishes = current <= to.projectedEndProgress + 0.05;
      if (startsInOrBeforeFrom && startsAfterFromBegins && endsInOrAfterTo && endsBeforeToFinishes) {
        classification = 'A_expected_transition';
        matchedTransition = { fromLetter: from.letter, toLetter: to.letter };
        break;
      }
    }
    if (classification !== 'A_expected_transition') {
      const withinSomeLetter = boundaries.some((letter) => previous >= letter.projectedStartProgress - 0.02 && current <= letter.projectedEndProgress + 0.02);
      classification = withinSomeLetter ? 'B_within_letter' : 'C_potentially_incorrect';
    }

    records.push({ sampleIndex: i, previousProgress: previous, currentProgress: current, delta, classification, matchedTransition });
  }
  return records;
}

export function extractBoundariesFor(word: string, geometryVariant: LetterShapeVariant): LetterBoundary[] {
  return letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant })).boundaries;
}

// ---------------------------------------------------------------------------
// Step 3 — 5 candidate jumpAllow calibration models, recombined through the
// SAME monotonicFit/revisitFit math (0.12 threshold, unchanged — this task
// is scoped to jumpAllow only).
// ---------------------------------------------------------------------------

export type JumpAllowModelKey = 'A_current' | 'B_perLetterCount' | 'C_targetGeometry' | 'D_boundaryExempt' | 'E_hybrid';

export type ProgressConsistencyBoundaryResult = { monotonicFit: number; jumpFit: number; revisitFit: number; skipAmount: number };

/**
 * Generalization of the real progressConsistency(): monotonicFit and
 * revisitFit use the EXACT unchanged real formula; jumpFit's calculation
 * is parameterized by a per-step allowance function AND an optional
 * per-step exemption (Model D/E's "do not count this expected transition
 * toward skipAmount at all").
 */
export function progressConsistencyWithJumpModel(
  progress: readonly number[],
  perStepAllowance: (stepIndex: number, delta: number) => number,
  exemptStep: (stepIndex: number) => boolean = () => false,
): ProgressConsistencyBoundaryResult {
  if (progress.length < 2) return { monotonicFit: 1, jumpFit: 1, revisitFit: 1, skipAmount: 0 };
  let positive = 0;
  let negative = 0;
  let skipAmount = 0;
  let revisitSteps = 0;
  let maxProgress = progress[0] ?? 0;

  for (let index = 1; index < progress.length; index += 1) {
    const current = progress[index] ?? 0;
    const previous = progress[index - 1] ?? 0;
    const delta = current - previous;
    if (delta >= 0) positive += delta;
    else negative += -delta;
    if (!exemptStep(index)) {
      const allowance = perStepAllowance(index, delta);
      skipAmount += Math.max(0, delta - allowance);
    }
    maxProgress = Math.max(maxProgress, previous);
    if (current < maxProgress - 0.12) revisitSteps += 1;
  }

  const variation = positive + negative;
  const monotonicFit = variation === 0 ? 1 : positive / variation;
  const jumpFit = clamp01(1 - skipAmount / 0.35);
  const revisitFit = 1 - revisitSteps / (progress.length - 1);
  return { monotonicFit, jumpFit, revisitFit, skipAmount };
}

export function combineProgressFit(monotonicFit: number, jumpFit: number, revisitFit: number): number {
  return clamp01(0.5 * monotonicFit + 0.3 * jumpFit + 0.2 * revisitFit);
}
export function combineOrder(dtwFit: number, progressFit: number, directionFit: number): number {
  return clamp01(0.5 * dtwFit + 0.3 * progressFit + 0.2 * directionFit);
}

const CURRENT_JUMP_ALLOW = 4 / (WHOLE_ROUTE_ORDER_SAMPLE_COUNT - 1);

/** Computes each of the 5 models' progressConsistency result for one candidate, given the real progress sequence and letter boundaries. */
export function evaluateAllJumpModels(progress: readonly number[], boundaries: readonly LetterBoundary[], numberOfLetters: number): Record<JumpAllowModelKey, ProgressConsistencyBoundaryResult> {
  const samples = progress.map((p) => ({ progress: p }));
  const jumps = classifyProgressJumps(samples, boundaries, CURRENT_JUMP_ALLOW);
  const expectedTransitionIndices = new Set(jumps.filter((j) => j.classification === 'A_expected_transition').map((j) => j.sampleIndex));

  // Model C: target-geometry-derived allowance = the largest REAL inter-letter connector gap (projected progress from one letter's end to the next letter's start), plus a small safety margin — derived from actual target structure, not guessed.
  let maxConnectorGap = 0;
  for (let i = 0; i + 1 < boundaries.length; i += 1) {
    const gap = boundaries[i + 1]!.projectedStartProgress - boundaries[i]!.projectedEndProgress;
    maxConnectorGap = Math.max(maxConnectorGap, gap);
  }
  const targetGeometryAllowance = Math.max(CURRENT_JUMP_ALLOW, maxConnectorGap + 0.05);

  const perLetterCountAllowance = numberOfLetters > 1 ? 1 / numberOfLetters : CURRENT_JUMP_ALLOW;

  const A = progressConsistencyWithJumpModel(progress, () => CURRENT_JUMP_ALLOW);
  const B = progressConsistencyWithJumpModel(progress, () => Math.max(CURRENT_JUMP_ALLOW, perLetterCountAllowance));
  const C = progressConsistencyWithJumpModel(progress, () => targetGeometryAllowance);
  const D = progressConsistencyWithJumpModel(progress, () => CURRENT_JUMP_ALLOW, (stepIndex) => expectedTransitionIndices.has(stepIndex));
  const E = progressConsistencyWithJumpModel(
    progress,
    (stepIndex) => (expectedTransitionIndices.has(stepIndex) ? targetGeometryAllowance : CURRENT_JUMP_ALLOW),
  );

  return { A_current: A, B_perLetterCount: B, C_targetGeometry: C, D_boundaryExempt: D, E_hybrid: E };
}

export { extractWholeRouteProgressSequence };
