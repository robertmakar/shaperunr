/**
 * DEVELOPMENT ONLY. Shadow "physical word traversal" evaluator —
 * additive/diagnostic only, never called from the live route-generation/
 * scoring/gate path, never wired into wordTraversal/meaningfullyVisited/
 * isFeasible/the product gate.
 *
 * Built directly from the Evaluator Synthesis Diagnostic's conclusion:
 * the existing per-letter `order` score (dtwFit/progressFit/directionFit)
 * is nearly orthogonal to physical letter-tracing success (corr(rawInk,
 * order) ≈ 0.10 across every tested weighting), while a much simpler
 * physical-coverage + broad-sequence definition recognized 58/78
 * checkpoint-v1 candidates as successfully tracing the word, versus 0/78
 * for the current evaluator.
 *
 * This module has exactly two conceptual requirements, kept explicitly
 * separate (never collapsed into one opaque score):
 *
 * A. Per-letter physical coverage — a letter is "physicallyCovered" iff
 *    BOTH rawInkCoverage >= inkThreshold AND coverage >= coverageThreshold.
 *    rawInkCoverage comes from the existing, unmodified
 *    computeInkOnlyOccupancy() (letter-occupancy.ts); coverage comes from
 *    the existing, unmodified TargetIdentity.letters[i].coverage
 *    (target-identity.ts). Neither metric is reimplemented here.
 *
 * B. Broad letter sequence — each letter's representative position is
 *    the MEDIAN of its own route-assigned points' progress against the
 *    FULL target (medianGlobalProgress, mirrors the already-proven
 *    definition from evaluator-synthesis-diagnostic.ts). Letters must
 *    have strictly increasing median progress, with a configurable
 *    equality tolerance. This explicitly does NOT use dtwFit,
 *    progressFit, directionFit, or monotonicFit — those remain available
 *    as a SEPARATE, parallel "stroke fidelity" diagnostic (Step 8),
 *    never folded into this evaluator's pass/fail decision.
 *
 * All thresholds are configurable (Step 1's explicit requirement, so a
 * later sweep can vary them) and default to the diagnostic's own
 * starting point: inkThreshold=0.60, coverageThreshold=0.40,
 * sequenceTolerance=0.02 — none of these are production thresholds.
 */
import { type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { extractLetterOrderInputs, medianGlobalProgress } from './evaluator-synthesis-diagnostic';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';

export const PHYSICAL_TRAVERSAL_DEFAULTS = {
  inkThreshold: 0.6,
  coverageThreshold: 0.4,
  sequenceTolerance: 0.02,
} as const;

export type PhysicalTraversalThresholds = {
  inkThreshold: number;
  coverageThreshold: number;
  sequenceTolerance: number;
};

export type PhysicalLetterInput = {
  index: number;
  letter: string;
  rawInkCoverage: number;
  coverage: number;
  medianProgress: number | null;
};

export type PhysicalLetterResult = PhysicalLetterInput & {
  physicallyCovered: boolean;
};

export type PhysicalWordTraversalResult = {
  wordTraversalPhysical: boolean;
  allLettersCovered: boolean;
  lettersInBroadOrder: boolean;
  letters: PhysicalLetterResult[];
  thresholds: { ink: number; coverage: number; sequenceTolerance: number };
  coveredLetterCount: number;
  letterCount: number;
  coverageFraction: number;
  firstMissingLetter: string | null;
  firstOrderViolation: { fromLetter: string; toLetter: string } | null;
};

// ---------------------------------------------------------------------------
// Pure classification over ALREADY-EXTRACTED per-letter data (reusable
// directly on persisted diagnostic JSON from prior tasks — no route
// regeneration required; see the .run.ts script for exactly this reuse).
// ---------------------------------------------------------------------------

export function classifyPhysicalLetter(input: PhysicalLetterInput, thresholds: PhysicalTraversalThresholds): PhysicalLetterResult {
  const physicallyCovered = input.rawInkCoverage >= thresholds.inkThreshold && input.coverage >= thresholds.coverageThreshold;
  return { ...input, physicallyCovered };
}

function evaluateBroadSequence(
  letters: readonly PhysicalLetterInput[],
  tolerance: number,
): { lettersInBroadOrder: boolean; firstOrderViolation: { fromLetter: string; toLetter: string } | null } {
  for (let i = 1; i < letters.length; i += 1) {
    const previous = letters[i - 1]!;
    const current = letters[i]!;
    if (previous.medianProgress === null || current.medianProgress === null) {
      return { lettersInBroadOrder: false, firstOrderViolation: { fromLetter: previous.letter, toLetter: current.letter } };
    }
    if (current.medianProgress + tolerance < previous.medianProgress) {
      return { lettersInBroadOrder: false, firstOrderViolation: { fromLetter: previous.letter, toLetter: current.letter } };
    }
  }
  return { lettersInBroadOrder: true, firstOrderViolation: null };
}

export function evaluatePhysicalWordTraversalFromLetters(
  letterInputs: readonly PhysicalLetterInput[],
  thresholds: PhysicalTraversalThresholds = PHYSICAL_TRAVERSAL_DEFAULTS,
): PhysicalWordTraversalResult {
  const letters = letterInputs.map((input) => classifyPhysicalLetter(input, thresholds));
  const coveredLetterCount = letters.filter((l) => l.physicallyCovered).length;
  const letterCount = letters.length;
  const allLettersCovered = letterCount > 0 && coveredLetterCount === letterCount;
  const { lettersInBroadOrder, firstOrderViolation } = evaluateBroadSequence(letterInputs, thresholds.sequenceTolerance);
  const firstMissing = letters.find((l) => !l.physicallyCovered) ?? null;

  return {
    wordTraversalPhysical: allLettersCovered && lettersInBroadOrder,
    allLettersCovered,
    lettersInBroadOrder,
    letters,
    thresholds: { ink: thresholds.inkThreshold, coverage: thresholds.coverageThreshold, sequenceTolerance: thresholds.sequenceTolerance },
    coveredLetterCount,
    letterCount,
    coverageFraction: letterCount === 0 ? 0 : coveredLetterCount / letterCount,
    firstMissingLetter: firstMissing?.letter ?? null,
    firstOrderViolation,
  };
}

// ---------------------------------------------------------------------------
// Full entry point — extracts rawInk/coverage/medianProgress fresh from a
// real route via the existing, unmodified infrastructure, then delegates
// to the pure classifier above.
// ---------------------------------------------------------------------------

export function evaluatePhysicalWordTraversal(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: LetterShapeVariant,
  thresholds: PhysicalTraversalThresholds = PHYSICAL_TRAVERSAL_DEFAULTS,
): PhysicalWordTraversalResult {
  if (route.length < 2 || target.length < 2) {
    return evaluatePhysicalWordTraversalFromLetters([], thresholds);
  }
  const identity = analyzeTargetIdentity({ route, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const ink = computeInkOnlyOccupancy({ route, target, boundarySet, letterMeaningfullyVisited: identity.letters.map((l) => l.meaningfullyVisited) });
  const orderInputs = extractLetterOrderInputs(word, target, route, geometryVariant);

  const letterInputs: PhysicalLetterInput[] = identity.letters.map((letterIdentity, index) => ({
    index,
    letter: letterIdentity.letter,
    rawInkCoverage: ink.perLetterOccupancy[index]?.occupancy ?? 0,
    coverage: letterIdentity.coverage,
    medianProgress: medianGlobalProgress(orderInputs[index]?.letterRoute ?? [], target),
  }));

  return evaluatePhysicalWordTraversalFromLetters(letterInputs, thresholds);
}
