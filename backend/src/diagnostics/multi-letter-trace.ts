/**
 * DEVELOPMENT ONLY. Multi-letter traversal diagnostics — observation only,
 * never called from the live route-generation path and never changes any
 * search/scoring/gate behavior.
 *
 * Reuses existing primitives wherever possible:
 * - projectPointOnPolyline / polylineLength (lib/geometry.ts) — the same
 *   projection math target-identity.ts's own letterIdentities() uses.
 * - buildWalkableWordShape (generation/walkable-target.ts) — the same word
 *   shape the live pipeline builds.
 * - GraphShapeResult.regions, already returned by routeGraphConstrainedShape
 *   and stored on every FeasibilityRecord.result — read here, not recomputed.
 *
 * What's new here (not duplicated from elsewhere): building a per-sample
 * letter-progression SEQUENCE along a candidate's own path (existing code
 * only ever computes per-letter aggregate coverage/order, never the ordered
 * sequence of which letter each point along the route falls in), and
 * classifying that sequence into the two failure modes the task asks to
 * distinguish (never reached vs reached-but-wrong-order).
 */
import { polylineLength, projectPointOnPolyline, resamplePolyline, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';
import type { WordShape } from '@/lib/word-shape';

export type LetterBoundary = {
  letter: string;
  index: number;
  /** Boundary from projecting the letter's own points onto the FULL word polyline — the same representation target-identity.ts's letterIdentities() already computes for wordTraversal/lettersVisitedInOrder. */
  projectedStartProgress: number;
  projectedEndProgress: number;
  /** Boundary from cumulative letter length alone (no projection), normalized against the SUM OF LETTER LENGTHS only — exactly how street-fit-search.ts's regionsFromLetterLengths() normalizes it (`total = sum(letters.length)`). Always spans 0..1 by construction, REGARDLESS of how long any inter-letter connector segments are — see totalFlattenedLength/interLetterGapLength below for that. */
  lengthStartProgress: number;
  lengthEndProgress: number;
  letterLength: number;
};

export type LetterBoundarySet = {
  boundaries: LetterBoundary[];
  /** polylineLength of the WHOLE flattened word polyline, including any inter-letter connector segments — the same length projectPointOnPolyline's progress is normalized against everywhere else in the pipeline (graph search's target, wordTraversal, etc). */
  totalFlattenedLength: number;
  /** Sum of each letter's own polyline length — what regionsFromLetterLengths normalizes against. */
  totalLetterLength: number;
  /** totalFlattenedLength - totalLetterLength — directly quantifies how much of the target polyline's real length is NOT any letter's own ink (see report Section F / task Section 11: is there a real connector, does it contribute to target length). Zero would mean letters are perfectly contiguous with no gap. */
  interLetterGapLength: number;
};

/**
 * Both existing boundary representations, for the SAME word shape, side by
 * side, plus the length discrepancy between them (see LetterBoundarySet).
 * Operates on the abstract (pre-geographic-placement) WordShape — the
 * proportions are placement/scale-invariant, so this is a faithful stand-in
 * for what either representation computes after real placement.
 */
export function letterBoundariesFromWordShape(wordShape: WordShape): LetterBoundarySet {
  const totalFlattenedLength = polylineLength(wordShape.points);
  const totalLetterLength = wordShape.letters.reduce((sum, letter) => sum + polylineLength(letter.points), 0);
  let cursor = 0;
  const boundaries = wordShape.letters.map((letter, index) => {
    const projections = letter.points.map((point) => projectPointOnPolyline(point, wordShape.points).progress);
    const projectedStartProgress = projections.length === 0 ? 0 : Math.min(...projections);
    const projectedEndProgress = projections.length === 0 ? 0 : Math.max(...projections);
    const letterLength = polylineLength(letter.points);
    const lengthStartProgress = totalLetterLength > 0 ? cursor / totalLetterLength : 0;
    cursor += letterLength;
    const lengthEndProgress = totalLetterLength > 0 ? cursor / totalLetterLength : 0;
    return {
      letter: letter.char,
      index,
      projectedStartProgress,
      projectedEndProgress,
      lengthStartProgress,
      lengthEndProgress,
      letterLength,
    };
  });
  return {
    boundaries,
    totalFlattenedLength,
    totalLetterLength,
    interLetterGapLength: totalFlattenedLength - totalLetterLength,
  };
}

/** Given target progress p, which letter (if any) does it fall inside? Uses the projected representation by default — the one wordTraversal itself actually uses. */
export function letterAtProgress(
  progress: number,
  boundaries: readonly LetterBoundary[],
  representation: 'projected' | 'length' = 'projected',
): LetterBoundary | null {
  for (const boundary of boundaries) {
    const start = representation === 'projected' ? boundary.projectedStartProgress : boundary.lengthStartProgress;
    const end = representation === 'projected' ? boundary.projectedEndProgress : boundary.lengthEndProgress;
    if (progress >= start - 1e-6 && progress <= end + 1e-6) {
      return boundary;
    }
  }
  return null;
}

export type FailureMode =
  | 'complete'
  | 'never_reached_later_letters'
  | 'reached_but_wrong_order'
  | 'reached_all_but_other_gate'
  | 'no_data';

export type TraversalTrace = {
  /** One entry per resampled point along the candidate's own path, in path order — '?' where the point doesn't project inside any letter's boundary (e.g. an inter-letter connector segment — see Section 11 of the report). */
  rawLetterSequence: string[];
  /** rawLetterSequence with consecutive duplicates and '?' entries collapsed — e.g. ["R","R","R","O","O"] -> ["R","O"]. */
  collapsedLetterSequence: string[];
  /** Distinct letters, in first-visited order (not sorted, not deduped-by-alphabet). */
  lettersVisited: string[];
  lettersVisitedInOrder: boolean;
  expectedLetters: string[];
  firstMissingLetter: string | null;
  firstOutOfOrderTransition: { fromLetter: string; toLetter: string; atCollapsedIndex: number } | null;
  maxLetterIndexReached: number;
  finalLetterIndexReached: number;
  distinctLettersVisitedCount: number;
  allLettersVisited: boolean;
  failureMode: FailureMode;
};

export function buildTraversalTrace(input: {
  pathPoints: readonly Vec2[];
  target: readonly Vec2[];
  boundaries: readonly LetterBoundary[];
  expectedLetters: readonly string[];
  sampleCount?: number;
  /** The ACTUAL wordTraversal result from target-identity.ts for this same candidate, if already computed — lets failureMode distinguish "reached everything in order but still failed some other gate" from "complete" without recomputing that gate here. */
  actualWordTraversal?: boolean | null;
}): TraversalTrace {
  const expectedLetters = [...input.expectedLetters];
  const sampled = input.pathPoints.length >= 2 ? resamplePolyline(input.pathPoints, input.sampleCount ?? 60) : [];

  const rawLetterSequence: string[] = sampled.map((point) => {
    const hit = projectPointOnPolyline(point, input.target);
    const boundary = letterAtProgress(hit.progress, input.boundaries);
    return boundary ? boundary.letter : '?';
  });

  const collapsedLetterSequence: string[] = [];
  for (const entry of rawLetterSequence) {
    if (entry === '?') continue;
    if (collapsedLetterSequence[collapsedLetterSequence.length - 1] !== entry) {
      collapsedLetterSequence.push(entry);
    }
  }

  const lettersVisited: string[] = [];
  for (const entry of collapsedLetterSequence) {
    if (!lettersVisited.includes(entry)) {
      lettersVisited.push(entry);
    }
  }

  const expectedIndex = new Map(expectedLetters.map((letter, index) => [letter, index]));
  let maxLetterIndexReached = -1;
  for (const letter of collapsedLetterSequence) {
    const index = expectedIndex.get(letter) ?? -1;
    if (index > maxLetterIndexReached) {
      maxLetterIndexReached = index;
    }
  }
  const finalLetterIndexReached =
    collapsedLetterSequence.length > 0
      ? (expectedIndex.get(collapsedLetterSequence[collapsedLetterSequence.length - 1]!) ?? -1)
      : -1;

  let firstOutOfOrderTransition: TraversalTrace['firstOutOfOrderTransition'] = null;
  {
    let last = -1;
    for (let i = 0; i < collapsedLetterSequence.length; i += 1) {
      const letter = collapsedLetterSequence[i]!;
      const index = expectedIndex.get(letter) ?? -1;
      if (index < last && firstOutOfOrderTransition == null) {
        firstOutOfOrderTransition = {
          fromLetter: collapsedLetterSequence[i - 1] ?? '',
          toLetter: letter,
          atCollapsedIndex: i,
        };
      }
      last = Math.max(last, index);
    }
  }

  let lettersVisitedInOrder = true;
  {
    let last = -1;
    for (const letter of lettersVisited) {
      const index = expectedIndex.get(letter) ?? -1;
      if (index < last) {
        lettersVisitedInOrder = false;
        break;
      }
      last = index;
    }
  }

  const firstMissingLetter = expectedLetters.find((letter) => !lettersVisited.includes(letter)) ?? null;
  const allLettersVisited = firstMissingLetter === null;

  let failureMode: FailureMode;
  if (rawLetterSequence.length === 0 || rawLetterSequence.every((entry) => entry === '?')) {
    failureMode = 'no_data';
  } else if (!allLettersVisited) {
    failureMode = 'never_reached_later_letters';
  } else if (!lettersVisitedInOrder) {
    failureMode = 'reached_but_wrong_order';
  } else if (input.actualWordTraversal === false) {
    failureMode = 'reached_all_but_other_gate';
  } else {
    failureMode = 'complete';
  }

  return {
    rawLetterSequence,
    collapsedLetterSequence,
    lettersVisited,
    lettersVisitedInOrder,
    expectedLetters,
    firstMissingLetter,
    firstOutOfOrderTransition,
    maxLetterIndexReached,
    finalLetterIndexReached,
    distinctLettersVisitedCount: lettersVisited.length,
    allLettersVisited,
    failureMode,
  };
}

/** The compact per-candidate diagnostic object the task asks for (section 7), assembled from existing metrics plus the new trace above — no second scoring system. */
export type CandidateTraversalRecord = {
  word: string;
  geometryVariant: LetterShapeVariant;
  candidateRank: number;
  graphFeasible: boolean;
  routed: boolean;
  expectedLetters: string[];
  lettersVisited: string[];
  lettersVisitedInOrder: boolean;
  firstMissingLetter: string | null;
  maxLetterIndexReached: number;
  targetProgressStart: number | null;
  targetProgressEnd: number | null;
  wordTraversal: boolean | null;
  orderScore: number | null;
  coverage: number | null;
  targetSpan: number | null;
  backtracking: number | null;
  rawLetterSequence: string[];
  collapsedLetterSequence: string[];
  failureMode: FailureMode;
};
