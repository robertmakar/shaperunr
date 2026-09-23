/**
 * DEVELOPMENT ONLY. Word-traversal recognition diagnostic — observation
 * only, never called from the live route-generation/scoring/gate path,
 * never fed into wordTraversal/meaningfullyVisited/traversesMostOfWord,
 * never changes any accepted route.
 *
 * Question: checkpoint-v1 substantially improves physical letter coverage
 * (rawInk 0.69→0.86, coverage 0.61→0.81) yet wordTraversal
 * (= TargetIdentity.traversesMostOfWord, the actual product-gate boolean)
 * stays 0/78 for BOTH generators. Is the route genuinely failing to
 * traverse the word, or is target-identity.ts's recognition logic blind to
 * real physical traversal?
 *
 * EXACT live code path (Step 1, traced directly from source, not from any
 * prior summary):
 *
 *   target geometry (buildWalkableWordShape)
 *     -> letter boundaries: letterIdentities() (target-identity.ts, private)
 *        projects each letter's OWN points onto the FULL flattened word
 *        polyline: `projectPointOnPolyline(point, shape.points).progress`,
 *        startProgress=min, endProgress=max of those projections. This is
 *        IDENTICAL to letterBoundariesFromWordShape()'s own
 *        `projectedStartProgress/projectedEndProgress` (diagnostics/
 *        multi-letter-trace.ts) — both already established as the same
 *        representation earlier this session; reused here, not re-derived.
 *     -> route projection: `projectPointOnPolyline(routePoint, target)` for
 *        every resampled route point (TARGET_IDENTITY.sampleCount=80
 *        samples), giving each one a target-progress + perpendicular
 *        distance.
 *     -> per-letter identity: for each letter, `sliceTargetByProgress()`
 *        cuts the letter's own target sub-polyline (±0.02 progress pad,
 *        48-sample base resample); `letterRoute` = resampled route points
 *        whose target-projection falls within [start-0.03, end+0.03] AND
 *        within 2x the letter's own coverage threshold; `coverage` = dense
 *        24-sample distanceToPolyline check against the letter target
 *        slice; `order` = scoreOrderedPath(letterRoute, sampledLetterTarget,
 *        letterTarget, {orderDistanceScale, coverageThreshold}).order,
 *        itself = 0.5*dtwFit + 0.3*progressFit + 0.2*directionFit
 *        (lib/shape-order.ts, unchanged).
 *     -> meaningfullyVisited = coverage >= TARGET_IDENTITY.minLetterCoverage
 *        (0.32) AND order >= TARGET_IDENTITY.minLetterOrder (0.45).
 *     -> lettersVisitedInOrder = isIncreasing(letters.filter(meaningfullyVisited)
 *        .map(item => item.startProgress)) — CRITICAL: `startProgress` here
 *        is the LETTER's OWN fixed target-boundary progress (from the step
 *        above), NOT anything derived from the route's actual visitation
 *        order. Since letters are built in sequence (R's startProgress <
 *        O's < B's < Z's, always, by construction — already confirmed
 *        elsewhere this session), ANY subset of a monotonic sequence is
 *        still monotonic. This flag can therefore only ever be FALSE if a
 *        LATER letter in the word has a SMALLER startProgress than an
 *        EARLIER one — which would mean the letters themselves were
 *        projected out of the word's own geometric order, not that the
 *        route walked them in the wrong order. Measured directly in this
 *        diagnostic's own aggregate (see report) rather than assumed.
 *     -> wordTraversal (TargetIdentity.wordTraversal, a FRACTION, not the
 *        gate) = visited.length / letters.length, where visited = letters
 *        with meaningfullyVisited=true.
 *     -> traversesMostOfWord (THE actual product-gate boolean, called
 *        "wordTraversal" throughout every benchmark script this session)
 *        for multi-letter words = wordTraversal(fraction) >= 1 (i.e. ALL
 *        letters meaningfullyVisited) AND lettersVisitedInOrder AND
 *        occupiedSpan >= 0.7, where occupiedSpan = TargetIdentity.targetSpan
 *        = longestConnectedSpan(...).span * spanOccupancy(...) — a GLOBAL,
 *        letter-INDEPENDENT metric: the length of the WHOLE route's longest
 *        unbroken on-target run (tight distance threshold, limited
 *        backtrack/forward-jump/gap tolerance — TARGET_IDENTITY.maxBacktrack
 *        =0.16, maxForwardJump=0.12, maxOffTargetGapSamples=4), times how
 *        densely that run's own progress bins are actually covered.
 *     -> product gate (experimental-product.ts, meetsExperimentalProductThreshold)
 *        reads route.metadata.largestGap directly and, for multi-letter
 *        words, requires identity.traversesMostOfWord — i.e. it inherits
 *        this SAME occupiedSpan/lettersVisitedInOrder/wordTraversal-fraction
 *        chain unchanged.
 *
 * Reuses, unmodified: analyzeTargetIdentity (target-identity.ts),
 * computeInkOnlyOccupancy (letter-occupancy.ts), extractLetterOrderInputs +
 * computeLetterOrderDecomposition (order-score-diagnostic.ts, itself already
 * parity-verified against the real per-letter order score),
 * letterBoundariesFromWordShape (multi-letter-trace.ts). This file adds NO
 * new scoring math — only aggregation, classification labels, and a
 * route-progress trace, all computed from real, unmodified function
 * outputs.
 */
import { projectPointOnPolyline, resamplePolyline, type Vec2 } from '@/lib/geometry';

import { computeLetterOrderDecomposition, extractLetterOrderInputs, type LetterOrderDecomposition } from './order-score-diagnostic';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape, type LetterBoundarySet } from './multi-letter-trace';
import { analyzeTargetIdentity, TARGET_IDENTITY, type TargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

// ---------------------------------------------------------------------------
// Step 2/3/4 — per-letter combined report
// ---------------------------------------------------------------------------

export type BindingFailureReason = 'coverage' | 'order' | 'coverage_and_order' | 'none';

export type PhysicalRecognitionClass = 'PHYSICALLY_COVERED_AND_RECOGNIZED' | 'PHYSICALLY_COVERED_BUT_NOT_RECOGNIZED' | 'PHYSICALLY_NOT_COVERED';

export type LetterTraversalRecord = {
  index: number;
  letter: string;
  /** Letter's own fixed target-boundary progress (letterBoundariesFromWordShape's projectedStartProgress/EndProgress — identical to what letterIdentities() itself computes). */
  targetStartProgress: number;
  targetEndProgress: number;
  /** Where the route's OWN points that were attributed to this letter actually land, in target progress (min/max of routeProgressSequence). Distinct from targetStartProgress/EndProgress — this is what the route did, not what the letter boundary says. */
  routeStartProgress: number | null;
  routeEndProgress: number | null;
  /** Dense bin-based physical ink coverage restricted to this letter's own progress range (letter-occupancy.ts, unchanged) — the physical reference. */
  rawInk: number;
  /** TargetIdentity.letters[i].coverage — existing production per-letter coverage (24-sample distanceToPolyline check). */
  coverage: number;
  /** TargetIdentity.letters[i].order — existing production per-letter order (0.5*dtwFit+0.3*progressFit+0.2*directionFit). */
  order: number;
  dtwFit: number;
  progressFit: number;
  directionFit: number;
  monotonicFit: number;
  jumpFit: number;
  revisitFit: number;
  /** TargetIdentity.letters[i].meaningfullyVisited — existing production semantic recognition. */
  meaningfullyVisited: boolean;
  bindingFailure: BindingFailureReason;
  recognitionByThreshold: Record<'p60' | 'p70' | 'p80' | 'p90', PhysicalRecognitionClass>;
};

function classifyBindingFailure(coverage: number, order: number, meaningfullyVisited: boolean): BindingFailureReason {
  if (meaningfullyVisited) return 'none';
  const coverageFails = coverage < TARGET_IDENTITY.minLetterCoverage;
  const orderFails = order < TARGET_IDENTITY.minLetterOrder;
  if (coverageFails && orderFails) return 'coverage_and_order';
  if (coverageFails) return 'coverage';
  if (orderFails) return 'order';
  return 'none';
}

function classifyRecognition(rawInk: number, meaningfullyVisited: boolean, threshold: number): PhysicalRecognitionClass {
  if (rawInk < threshold) return 'PHYSICALLY_NOT_COVERED';
  return meaningfullyVisited ? 'PHYSICALLY_COVERED_AND_RECOGNIZED' : 'PHYSICALLY_COVERED_BUT_NOT_RECOGNIZED';
}

export type WordTraversalReport = {
  word: string;
  identity: TargetIdentity;
  boundarySet: LetterBoundarySet;
  letters: LetterTraversalRecord[];
  orderDecompositions: LetterOrderDecomposition[];
  /** occupiedSpan/spanOccupancy breakdown — the GLOBAL, letter-independent component of traversesMostOfWord, reused verbatim from TargetIdentity. */
  occupiedSpan: number;
  spanOccupancy: number;
  largestTargetGap: number;
  /** Aggregated directly from real letters[].meaningfullyVisited — TargetIdentity.wordTraversal is the SAME value (visited.length/letters.length), exposed here for clarity. */
  allLettersVisitedFraction: number;
  lettersVisitedInOrder: boolean;
  traversesMostOfWord: boolean;
};

export function buildWordTraversalReport(word: string, target: readonly Vec2[], route: readonly Vec2[], geometryVariant: LetterShapeVariant): WordTraversalReport {
  const identity = analyzeTargetIdentity({ route, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const inkResult = computeInkOnlyOccupancy({
    route,
    target,
    boundarySet,
    letterMeaningfullyVisited: identity.letters.map((l) => l.meaningfullyVisited),
  });
  const orderInputs = extractLetterOrderInputs(word, target, route, geometryVariant);
  const orderDecompositions = orderInputs.map(computeLetterOrderDecomposition);

  const letters: LetterTraversalRecord[] = identity.letters.map((letterIdentity, index) => {
    const rawInk = inkResult.perLetterOccupancy[index]?.occupancy ?? 0;
    const decomposition = orderDecompositions[index];
    const routeProgress = decomposition?.routeProgressSequence ?? [];
    const bindingFailure = classifyBindingFailure(letterIdentity.coverage, letterIdentity.order, letterIdentity.meaningfullyVisited);
    return {
      index,
      letter: letterIdentity.letter,
      targetStartProgress: letterIdentity.startProgress,
      targetEndProgress: letterIdentity.endProgress,
      routeStartProgress: routeProgress.length ? Math.min(...routeProgress) : null,
      routeEndProgress: routeProgress.length ? Math.max(...routeProgress) : null,
      rawInk,
      coverage: letterIdentity.coverage,
      order: letterIdentity.order,
      dtwFit: decomposition?.forward.dtwFit ?? 0,
      progressFit: decomposition?.forward.progressFit ?? 0,
      directionFit: decomposition?.forward.directionFit ?? 0,
      monotonicFit: decomposition?.forward.monotonicFit ?? 0,
      jumpFit: decomposition?.forward.jumpFit ?? 0,
      revisitFit: decomposition?.forward.revisitFit ?? 0,
      meaningfullyVisited: letterIdentity.meaningfullyVisited,
      bindingFailure,
      recognitionByThreshold: {
        p60: classifyRecognition(rawInk, letterIdentity.meaningfullyVisited, 0.6),
        p70: classifyRecognition(rawInk, letterIdentity.meaningfullyVisited, 0.7),
        p80: classifyRecognition(rawInk, letterIdentity.meaningfullyVisited, 0.8),
        p90: classifyRecognition(rawInk, letterIdentity.meaningfullyVisited, 0.9),
      },
    };
  });

  return {
    word,
    identity,
    boundarySet,
    letters,
    orderDecompositions,
    occupiedSpan: identity.targetSpan,
    spanOccupancy: identity.spanOccupancy,
    largestTargetGap: identity.largestTargetGap,
    allLettersVisitedFraction: identity.wordTraversal,
    lettersVisitedInOrder: identity.lettersVisitedInOrder,
    traversesMostOfWord: identity.traversesMostOfWord,
  };
}

// ---------------------------------------------------------------------------
// Step 5 — letter boundary connector-inclusion analysis
// ---------------------------------------------------------------------------

export type LetterBoundaryReport = {
  letter: string;
  index: number;
  projectedStartProgress: number;
  projectedEndProgress: number;
  lengthStartProgress: number;
  lengthEndProgress: number;
  letterLength: number;
  /** projectedEndProgress-projectedStartProgress vs lengthEndProgress-lengthStartProgress — how much the projected (connector-inclusive, target-length-normalized) boundary differs from the pure letter-length-normalized boundary. Positive means the projected span is WIDER than the letter's own ink alone would suggest (i.e. some connector progress is being counted as part of this letter's own range). */
  projectedSpan: number;
  lengthOnlySpan: number;
  spanDeltaFromConnectors: number;
};

export function buildLetterBoundaryReport(word: string, target: readonly Vec2[], geometryVariant: LetterShapeVariant): { boundaries: LetterBoundaryReport[]; totalFlattenedLength: number; totalLetterLength: number; interLetterGapLength: number } {
  void target;
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const boundaries = boundarySet.boundaries.map((b) => ({
    letter: b.letter,
    index: b.index,
    projectedStartProgress: b.projectedStartProgress,
    projectedEndProgress: b.projectedEndProgress,
    lengthStartProgress: b.lengthStartProgress,
    lengthEndProgress: b.lengthEndProgress,
    letterLength: b.letterLength,
    projectedSpan: b.projectedEndProgress - b.projectedStartProgress,
    lengthOnlySpan: b.lengthEndProgress - b.lengthStartProgress,
    spanDeltaFromConnectors: (b.projectedEndProgress - b.projectedStartProgress) - (b.lengthEndProgress - b.lengthStartProgress),
  }));
  return { boundaries, totalFlattenedLength: boundarySet.totalFlattenedLength, totalLetterLength: boundarySet.totalLetterLength, interLetterGapLength: boundarySet.interLetterGapLength };
}

// ---------------------------------------------------------------------------
// Step 6 — route progress trace, segmented by dominant letter
// ---------------------------------------------------------------------------

export type RouteProgressSegment = {
  segmentIndex: number;
  startProgress: number;
  endProgress: number;
  dominantLetter: string | null;
  pointCount: number;
  /** True if this segment's progress DECREASED relative to the previous segment's end (a backward jump in the raw route trace). */
  isRegression: boolean;
};

/** Resamples the route, projects every point onto the full target, and groups consecutive points by which letter's own boundary (if any) contains that progress — a compact trace of what the route actually did across target progress, independent of any scoring. */
export function buildRouteProgressTrace(target: readonly Vec2[], route: readonly Vec2[], boundarySet: LetterBoundarySet, sampleCount = 40): RouteProgressSegment[] {
  if (route.length < 2 || target.length < 2) return [];
  const sampled = resamplePolyline(route, sampleCount);
  const projections = sampled.map((point) => projectPointOnPolyline(point, target).progress);
  const letterAt = (progress: number): string | null => {
    const match = boundarySet.boundaries.find((b) => progress >= b.projectedStartProgress && progress <= b.projectedEndProgress);
    return match?.letter ?? null;
  };

  const segments: RouteProgressSegment[] = [];
  let currentLetter = letterAt(projections[0] ?? 0);
  let segmentStart = projections[0] ?? 0;
  let segmentPointCount = 1;
  let previousEnd = projections[0] ?? 0;

  const closeSegment = (endProgress: number) => {
    segments.push({
      segmentIndex: segments.length,
      startProgress: segmentStart,
      endProgress,
      dominantLetter: currentLetter,
      pointCount: segmentPointCount,
      isRegression: segments.length > 0 && segmentStart < previousEnd,
    });
    previousEnd = endProgress;
  };

  for (let i = 1; i < projections.length; i += 1) {
    const progress = projections[i]!;
    const letter = letterAt(progress);
    if (letter !== currentLetter) {
      closeSegment(projections[i - 1]!);
      currentLetter = letter;
      segmentStart = progress;
      segmentPointCount = 1;
    } else {
      segmentPointCount += 1;
    }
  }
  closeSegment(projections[projections.length - 1] ?? segmentStart);
  return segments;
}

// ---------------------------------------------------------------------------
// Step 8 — shadow semantic diagnostics (diagnostic-only, never used for acceptance)
// ---------------------------------------------------------------------------

export type ShadowLetterVisited = {
  A_raw60: boolean;
  B_raw70: boolean;
  C_existingMeaningfullyVisited: boolean;
  D_raw60AndExistingOrder: boolean;
  E_raw60AndRelaxedOrder30: boolean;
};

export function evaluateShadowLetterVisited(letter: LetterTraversalRecord): ShadowLetterVisited {
  return {
    A_raw60: letter.rawInk >= 0.6,
    B_raw70: letter.rawInk >= 0.7,
    C_existingMeaningfullyVisited: letter.meaningfullyVisited,
    D_raw60AndExistingOrder: letter.rawInk >= 0.6 && letter.order >= TARGET_IDENTITY.minLetterOrder,
    E_raw60AndRelaxedOrder30: letter.rawInk >= 0.6 && letter.order >= 0.3,
  };
}

// ---------------------------------------------------------------------------
// Step 9 — shadow word-traversal variants (diagnostic-only)
// ---------------------------------------------------------------------------

export type ShadowTraversalVariants = {
  variant1_raw60: boolean;
  variant2_raw70: boolean;
  variant3_raw60AndOrder30: boolean;
  variant4_raw60AndOrder40: boolean;
  variant5_existingSemantics: boolean;
};

function isIncreasingLocal(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] ?? 0) + 1e-6 < (values[i - 1] ?? 0)) return false;
  }
  return values.length > 0;
}

export function evaluateShadowTraversalVariants(letters: readonly LetterTraversalRecord[]): ShadowTraversalVariants {
  const allPass = (predicate: (letter: LetterTraversalRecord) => boolean) => letters.length > 0 && letters.every(predicate) && isIncreasingLocal(letters.filter(predicate).map((l) => l.targetStartProgress));
  return {
    variant1_raw60: allPass((l) => l.rawInk >= 0.6),
    variant2_raw70: allPass((l) => l.rawInk >= 0.7),
    variant3_raw60AndOrder30: allPass((l) => l.rawInk >= 0.6 && l.order >= 0.3),
    variant4_raw60AndOrder40: allPass((l) => l.rawInk >= 0.6 && l.order >= 0.4),
    variant5_existingSemantics: allPass((l) => l.meaningfullyVisited),
  };
}
