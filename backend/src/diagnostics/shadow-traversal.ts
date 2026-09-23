/**
 * DEVELOPMENT ONLY. Shadow/diagnostic traversal evaluators — alternative
 * definitions of "did the route meaningfully draw the word", computed
 * alongside the existing, UNCHANGED wordTraversal/traversesMostOfWord gate.
 * None of this feeds back into route generation, scoring, or the product
 * gate; it only reads already-computed results and derives new booleans.
 *
 * Reuses existing machinery rather than re-implementing anything:
 * - TargetIdentity (generation/target-identity.ts, UNCHANGED) — the existing
 *   per-letter coverage/order/meaningfullyVisited, lettersVisitedInOrder,
 *   and traversesMostOfWord ("currentWordTraversal", the control).
 * - InkOnlyOccupancyResult (diagnostics/letter-occupancy.ts, UNCHANGED) —
 *   the previous task's connector-excluded per-letter ink density.
 * - TraversalTrace (diagnostics/multi-letter-trace.ts, UNCHANGED) — the
 *   previous task's actual path-order letter sequence, used here to ask
 *   whether the INK-COVERED letters occur in expected order along the real
 *   path (not just whether their static array indices happen to increase).
 */
import type { TargetIdentity } from '../generation/target-identity';
import { TARGET_IDENTITY } from '../generation/target-identity';
import type { InkOnlyOccupancyResult } from './letter-occupancy';
import type { TraversalTrace } from './multi-letter-trace';

/** Diagnostic thresholds for "did we draw the letter's ink at all", independent of the existing per-letter order requirement. Sensitivity is reported across all four; 0.5 is the default used for the covered/ordered evaluators (C/D). */
export const SHADOW_INK_THRESHOLDS = [0.4, 0.5, 0.6, 0.7] as const;
export const SHADOW_DEFAULT_COVERAGE_THRESHOLD = 0.5;

export type ShadowLetterRecord = {
  letter: string;
  index: number;
  /** = InkOnlyOccupancyResult.perLetterOccupancy[index].occupancy, UNCHANGED — raw per-letter ink density, ignoring order entirely. */
  rawInkOccupancy: number;
  /** = TargetIdentity.letters[index].coverage, UNCHANGED. */
  existingCoverage: number;
  /** = TargetIdentity.letters[index].order, UNCHANGED. */
  existingOrder: number;
  /** = TargetIdentity.letters[index].meaningfullyVisited, UNCHANGED (existingCoverage >= 0.32 && existingOrder >= 0.45). */
  existingMeaningfullyVisited: boolean;
};

export function buildShadowLetterRecords(
  identity: TargetIdentity,
  inkResult: InkOnlyOccupancyResult,
): ShadowLetterRecord[] {
  return identity.letters.map((letterIdentity, index) => ({
    letter: letterIdentity.letter,
    index,
    rawInkOccupancy: inkResult.perLetterOccupancy[index]?.occupancy ?? 0,
    existingCoverage: letterIdentity.coverage,
    existingOrder: letterIdentity.order,
    existingMeaningfullyVisited: letterIdentity.meaningfullyVisited,
  }));
}

// --- Shadow Evaluator A: ink-aware occupancy only ---------------------------
// inkOnlyOccupancy >= 0.7 AND all letters meaningfullyVisited (existing) AND
// lettersVisitedInOrder (existing). Isolates the effect of fixing ONLY the
// connector-inclusive-occupancy problem while leaving every other existing
// gate (per-letter coverage/order, ordering) exactly as-is.
export function evaluateInkAwareTraversal(identity: TargetIdentity, inkOnlyOccupancy: number): boolean {
  return (
    inkOnlyOccupancy >= 0.7 &&
    identity.letters.length > 0 &&
    identity.letters.every((letter) => letter.meaningfullyVisited) &&
    identity.lettersVisitedInOrder
  );
}

// --- Shadow Evaluator B: letter occupancy completion ------------------------
export type LetterCompletionAtThreshold = {
  threshold: number;
  lettersCompleted: number;
  expectedLetters: number;
  /** lettersCompleted / expectedLetters. */
  lettersCompletedRatio: number;
  allLettersInkCovered: boolean;
};

/** A letter counts as "ink-complete" at a threshold based ONLY on its raw ink occupancy — deliberately ignoring existingCoverage/existingOrder/meaningfullyVisited, per task Section 3. */
export function computeLetterCompletionAtThreshold(
  letters: readonly ShadowLetterRecord[],
  threshold: number,
): LetterCompletionAtThreshold {
  const completed = letters.filter((letter) => letter.rawInkOccupancy >= threshold).length;
  return {
    threshold,
    lettersCompleted: completed,
    expectedLetters: letters.length,
    lettersCompletedRatio: letters.length === 0 ? 0 : completed / letters.length,
    allLettersInkCovered: letters.length > 0 && completed === letters.length,
  };
}

// --- Shadow Evaluator C/D: separate "did we draw it" from "in what order" ---
export type CoveredLettersResult = {
  coveredLetters: string[];
  /** The ink-covered letters, in the order they first appear along the candidate's ACTUAL path (TraversalTrace.collapsedLetterSequence) — not just their static word-index order. This is what "occur in the expected order" is checked against. */
  orderedCoveredLetters: string[];
  allLettersCovered: boolean;
  allLettersCoveredAndOrdered: boolean;
};

/**
 * Deliberately does NOT use TargetIdentity's existing meaningfullyVisited
 * boolean (which mixes coverage AND order together) — "covered" here means
 * ONLY raw ink occupancy at or above `threshold`. Ordering is then checked
 * separately, against the real path sequence from `trace`, so coverage and
 * ordering can be told apart (task Section 4).
 */
export function computeOrderedCoveredLetters(
  letters: readonly ShadowLetterRecord[],
  trace: TraversalTrace,
  threshold: number,
): CoveredLettersResult {
  const coveredSet = new Set(letters.filter((letter) => letter.rawInkOccupancy >= threshold).map((letter) => letter.letter));
  const allLettersCovered = letters.length > 0 && coveredSet.size === letters.length;

  const orderedCoveredLetters: string[] = [];
  for (const letter of trace.collapsedLetterSequence) {
    if (coveredSet.has(letter) && !orderedCoveredLetters.includes(letter)) {
      orderedCoveredLetters.push(letter);
    }
  }

  const expectedIndex = new Map(trace.expectedLetters.map((letter, index) => [letter, index]));
  let coveredInOrder = true;
  let last = -1;
  for (const letter of orderedCoveredLetters) {
    const index = expectedIndex.get(letter) ?? -1;
    if (index < last) {
      coveredInOrder = false;
      break;
    }
    last = index;
  }

  return {
    coveredLetters: [...coveredSet],
    orderedCoveredLetters,
    allLettersCovered,
    allLettersCoveredAndOrdered: allLettersCovered && coveredInOrder,
  };
}

// --- Shadow Evaluator E: per-letter failure attribution ---------------------
export type LetterFailureReason = 'coverage' | 'order' | 'both' | 'none';

/** For a letter with meaningfullyVisited === false, attribute the failure to existingCoverage < 0.32, existingOrder < 0.45, or both — read directly off the SAME thresholds target-identity.ts already uses (TARGET_IDENTITY.minLetterCoverage/minLetterOrder), never redefined here. */
export function classifyLetterFailure(letter: ShadowLetterRecord): LetterFailureReason {
  if (letter.existingMeaningfullyVisited) {
    return 'none';
  }
  const coverageFails = letter.existingCoverage < TARGET_IDENTITY.minLetterCoverage;
  const orderFails = letter.existingOrder < TARGET_IDENTITY.minLetterOrder;
  if (coverageFails && orderFails) return 'both';
  if (coverageFails) return 'coverage';
  if (orderFails) return 'order';
  return 'none';
}

// --- Shadow decision matrix (task Section 7 / report Section H) -------------
export type DecisionCategory =
  | 'current_passes'
  | 'ink_aware_passes'
  | 'covered_not_ordered'
  | 'covered_and_ordered'
  | 'missing_letter'
  | 'neither';

/**
 * Exactly one category per candidate, in priority order. Categories 1-2 are
 * "would something already pass"; 3-4 split ink-coverage from ordering
 * (task's DID-WE-DRAW-IT vs DID-WE-DRAW-IT-IN-ORDER distinction); 5-6 are
 * failure buckets, with 5 reserved for a letter TraversalTrace says was
 * never reached at all (firstMissingLetter set) and 6 as the catch-all for
 * partial-but-insufficient coverage that doesn't cleanly fit any other case.
 */
export function classifyDecision(input: {
  currentWordTraversal: boolean;
  inkAwareTraversal: boolean;
  allLettersCovered: boolean;
  allLettersCoveredAndOrdered: boolean;
  firstMissingLetter: string | null;
}): DecisionCategory {
  if (input.currentWordTraversal) return 'current_passes';
  if (input.inkAwareTraversal) return 'ink_aware_passes';
  if (input.allLettersCoveredAndOrdered) return 'covered_and_ordered';
  if (input.allLettersCovered) return 'covered_not_ordered';
  if (input.firstMissingLetter !== null) return 'missing_letter';
  return 'neither';
}

export type ShadowDecisionRecord = {
  word: string;
  geometryVariant: string;
  candidateRank: number;
  /** = TargetIdentity.traversesMostOfWord, UNCHANGED — the control (Evaluator/Section A). */
  currentWordTraversal: boolean;
  inkOnlyOccupancy: number;
  inkAwareTraversal: boolean;
  letters: ShadowLetterRecord[];
  /** One entry per SHADOW_INK_THRESHOLDS value (0.4/0.5/0.6/0.7). */
  completionByThreshold: LetterCompletionAtThreshold[];
  coveredLetters: string[];
  orderedCoveredLetters: string[];
  allLettersCovered: boolean;
  allLettersCoveredAndOrdered: boolean;
  /** From TraversalTrace, at SHADOW_DEFAULT_COVERAGE_THRESHOLD's boundary-hit sense (any projection inside the letter's boundary at all) — a looser signal than rawInkOccupancy, kept for Section 5/H diagnostics. */
  visitedLetters: string[];
  visitedLettersInOrder: boolean;
  firstMissingLetter: string | null;
  firstOutOfOrderTransition: TraversalTrace['firstOutOfOrderTransition'];
  maxLetterIndexReached: number;
  decisionCategory: DecisionCategory;
};

export function buildShadowDecisionRecord(input: {
  word: string;
  geometryVariant: string;
  candidateRank: number;
  identity: TargetIdentity;
  inkResult: InkOnlyOccupancyResult;
  trace: TraversalTrace;
  coverageThreshold?: number;
}): ShadowDecisionRecord {
  const threshold = input.coverageThreshold ?? SHADOW_DEFAULT_COVERAGE_THRESHOLD;
  const letters = buildShadowLetterRecords(input.identity, input.inkResult);
  const inkAwareTraversal = evaluateInkAwareTraversal(input.identity, input.inkResult.inkOnlyOccupancy);
  const completionByThreshold = SHADOW_INK_THRESHOLDS.map((t) => computeLetterCompletionAtThreshold(letters, t));
  const covered = computeOrderedCoveredLetters(letters, input.trace, threshold);
  const decisionCategory = classifyDecision({
    currentWordTraversal: input.identity.traversesMostOfWord,
    inkAwareTraversal,
    allLettersCovered: covered.allLettersCovered,
    allLettersCoveredAndOrdered: covered.allLettersCoveredAndOrdered,
    firstMissingLetter: input.trace.firstMissingLetter,
  });

  return {
    word: input.word,
    geometryVariant: input.geometryVariant,
    candidateRank: input.candidateRank,
    currentWordTraversal: input.identity.traversesMostOfWord,
    inkOnlyOccupancy: input.inkResult.inkOnlyOccupancy,
    inkAwareTraversal,
    letters,
    completionByThreshold,
    coveredLetters: covered.coveredLetters,
    orderedCoveredLetters: covered.orderedCoveredLetters,
    allLettersCovered: covered.allLettersCovered,
    allLettersCoveredAndOrdered: covered.allLettersCoveredAndOrdered,
    visitedLetters: input.trace.lettersVisited,
    visitedLettersInOrder: input.trace.lettersVisitedInOrder,
    firstMissingLetter: input.trace.firstMissingLetter,
    firstOutOfOrderTransition: input.trace.firstOutOfOrderTransition,
    maxLetterIndexReached: input.trace.maxLetterIndexReached,
    decisionCategory,
  };
}
