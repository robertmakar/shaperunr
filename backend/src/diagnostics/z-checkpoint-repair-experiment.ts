/**
 * DEVELOPMENT ONLY. Sub-letter structural checkpoint anchoring — tests
 * whether checkpoint anchoring (Mechanism B, checkpoint-anchoring-
 * diagnostic.ts) can repair Z's B_search_failure candidates by anchoring
 * three LANDMARKS INSIDE Z's own stroke (top->diagonal boundary, diagonal
 * midpoint, diagonal->bottom boundary), instead of anchoring whole letters
 * as the prior tasks did.
 *
 * Why this needs a new (small) augmenter rather than reusing
 * makeCheckpointAnchoringAugmenter unchanged: that function's penalty
 * condition is `if (letterIndex >= activeIndex) continue` — it only ever
 * penalizes missing a checkpoint that belongs to a STRICTLY EARLIER
 * LETTER than the edge's current active letter. Three checkpoints that
 * all share Z's own letterIndex would never trigger it, because none of
 * them is ever "strictly preceding" while still inside Z. This file
 * generalizes the same idea one level finer: "has this preceding PROGRESS
 * LANDMARK been anchored" instead of "has this preceding LETTER been
 * anchored" — the minimal change needed to express sub-letter landmarks,
 * documented here exactly as required rather than changing Z's geometry
 * or silently reinterpreting the task. checkpoint-anchoring-diagnostic.ts
 * itself is NOT modified; its snap machinery, bit-indexing, and extraMask
 * update function are letter-agnostic already and are reused UNCHANGED
 * (snapCheckpointToGraph, indexCheckpointBits's sibling below,
 * makeCheckpointExtraMaskUpdate).
 *
 * graph-shape.ts is never touched. This module only ever runs through
 * graph-shape-goal-mirror.ts's routeGraphConstrainedShapeMirror, exactly
 * like every other diagnostic in this investigation chain.
 */
import type { Vec2 } from '@/lib/geometry';
import { resamplePolyline } from '@/lib/geometry';
import type { LetterBoundary, LetterBoundarySet } from './multi-letter-trace';
import type { ShapeGraph } from '../generation/graph-shape';
import { GRAPH_SHAPE } from '../generation/graph-shape';
import { snapCheckpointToGraph, type CheckpointSnap } from './checkpoint-route-experiment';
import type { EdgeCostAugmenterFn } from './graph-shape-goal-mirror';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { decomposeZStrokes, zStrokeProgressSplit } from './letter-street-support-diagnostic';

// ---------------------------------------------------------------------------
// Landmarks and checkpoints.
// ---------------------------------------------------------------------------

export type ProgressLandmark = { label: string; progress: number; coordinate: Vec2 };

export type ProgressCheckpoint = {
  label: string;
  targetProgress: number;
  targetCoordinate: Vec2;
  snap: CheckpointSnap;
};

/** Z's three structural landmarks: end of top / start of diagonal, midpoint of the diagonal, end of diagonal / start of bottom — exactly the three positions requested by this task's Step 4. */
export function buildZLandmarks(target: readonly Vec2[], zBoundary: LetterBoundary): ProgressLandmark[] {
  const { p1, p2 } = zStrokeProgressSplit(zBoundary);
  const strokes = decomposeZStrokes(target, zBoundary);
  return [
    { label: 'topToDiagonal', progress: p1, coordinate: strokes.diagonal[0]! },
    { label: 'diagonalMid', progress: (p1 + p2) / 2, coordinate: strokes.diagonal[Math.floor(strokes.diagonal.length / 2)]! },
    { label: 'diagonalToBottom', progress: p2, coordinate: strokes.diagonal[strokes.diagonal.length - 1]! },
  ];
}

function pointAtProgress(target: readonly Vec2[], progress: number): Vec2 {
  const samples = resamplePolyline(target, 200);
  const idx = Math.min(samples.length - 1, Math.max(0, Math.round(progress * (samples.length - 1))));
  return samples[idx]!;
}

/**
 * Negative-control landmark builder (Step 9): the SAME mechanism — three
 * progress-ordered landmarks inside one letter's own stroke — applied to
 * R/C/I, which have no top/diagonal/bottom structure. These three points
 * are simply the 1/3, 2/3, and end positions of the letter's own progress
 * span, giving a matched "three ordered sub-letter checkpoints" treatment
 * without inventing letter-specific semantics these letters don't have.
 */
export function buildGenericThreeWayLandmarks(target: readonly Vec2[], boundary: LetterBoundary): ProgressLandmark[] {
  const span = boundary.projectedEndProgress - boundary.projectedStartProgress;
  const fractions: Array<{ label: string; frac: number }> = [
    { label: 'thirdOne', frac: 1 / 3 },
    { label: 'thirdTwo', frac: 2 / 3 },
    { label: 'end', frac: 1.0 },
  ];
  return fractions.map(({ label, frac }) => {
    const progress = boundary.projectedStartProgress + span * frac;
    return { label, progress, coordinate: pointAtProgress(target, progress) };
  });
}

export function buildProgressCheckpoints(landmarks: readonly ProgressLandmark[], graph: ShapeGraph, k: number): ProgressCheckpoint[] {
  return landmarks.map((landmark, index) => ({
    label: landmark.label,
    targetProgress: landmark.progress,
    targetCoordinate: landmark.coordinate,
    snap: snapCheckpointToGraph({ index, targetProgress: landmark.progress, targetCoordinate: landmark.coordinate, targetLetter: null }, graph, k),
  }));
}

/** Bit-indexing identical in spirit to checkpoint-anchoring-diagnostic.ts's indexCheckpointBits, adapted to ProgressCheckpoint's shape (no letterIndex concept here — deliberately, see file header). */
export function indexProgressCheckpointBits(checkpoints: readonly ProgressCheckpoint[]): Map<string, number[]> {
  const nodeToBits = new Map<string, number[]>();
  checkpoints.forEach((checkpoint, bit) => {
    for (const candidate of checkpoint.snap.candidates) {
      const list = nodeToBits.get(candidate.nodeId) ?? [];
      list.push(bit);
      nodeToBits.set(candidate.nodeId, list);
    }
  });
  return nodeToBits;
}

/** Small enough not to trivially satisfy a checkpoint at its own landmark progress, large enough to absorb floating-point noise from the arc-length split — well under one progress bin's width (1/28 ~= 0.0357 at GRAPH_SHAPE.progressBins). */
const PROGRESS_EPSILON = 0.002;

/**
 * The sub-letter generalization of makeCheckpointAnchoringAugmenter
 * (checkpoint-anchoring-diagnostic.ts): penalizes an edge that advances
 * progress past a checkpoint's OWN target progress while that checkpoint's
 * bit is still unset in the PARENT state — keyed on progress position
 * rather than letter identity. Same additive, finite-penalty architecture
 * as the original (never a hard block), same reasoning documented there
 * for why "require" is realized as a strongly-weighted finite cost term.
 */
export function makeProgressCheckpointAugmenter(checkpoints: readonly ProgressCheckpoint[], penaltyPerMissedCheckpoint: number): EdgeCostAugmenterFn {
  return (edge, _currentProgress, parentState) => {
    let missed = 0;
    checkpoints.forEach((checkpoint, bit) => {
      if (edge.endProgress <= checkpoint.targetProgress + PROGRESS_EPSILON) return;
      const hit = (parentState.extraMask & (1 << bit)) !== 0;
      if (!hit) missed += 1;
    });
    return missed * penaltyPerMissedCheckpoint;
  };
}

// ---------------------------------------------------------------------------
// Post-hoc measurement: did the FINAL route actually pass near a landmark,
// independent of the search's own internal extraMask bookkeeping — Step 6's
// explicit "graph connectivity != search traversal" distinction, measured
// directly against the produced route rather than inferred from the beam's
// own state.
// ---------------------------------------------------------------------------

export type CheckpointReachResult = { reached: boolean; nearestDistanceMeters: number; nearestIndex: number };

/** radiusMeters defaults to GRAPH_SHAPE.followRadiusMeters (45m) — the SAME "on-target" proximity radius the real search and metricsFromPath already use everywhere else, not a new invented threshold. */
export function checkpointReachedByRoute(pathPoints: readonly Vec2[], targetCoordinate: Vec2, radiusMeters: number = GRAPH_SHAPE.followRadiusMeters): CheckpointReachResult {
  if (pathPoints.length === 0) return { reached: false, nearestDistanceMeters: Number.POSITIVE_INFINITY, nearestIndex: -1 };
  let best = Number.POSITIVE_INFINITY;
  let bestIndex = -1;
  pathPoints.forEach((point, index) => {
    const distance = Math.hypot(point.x - targetCoordinate.x, point.y - targetCoordinate.y);
    if (distance < best) {
      best = distance;
      bestIndex = index;
    }
  });
  return { reached: best <= radiusMeters, nearestDistanceMeters: best, nearestIndex: bestIndex };
}

// ---------------------------------------------------------------------------
// Sub-stroke ink coverage — generalization of computeInkOnlyOccupancy to
// ARBITRARY progress sub-ranges within one letter (not just whole letters),
// reusing computeInkOnlyOccupancy unmodified via a synthetic LetterBoundarySet
// whose "letters" are the sub-ranges of interest. Only boundarySet.boundaries
// is read by computeInkOnlyOccupancy, so the unused LetterBoundarySet fields
// below are harmless placeholders, not fabricated data.
// ---------------------------------------------------------------------------

export type SubStrokeCoverage = { label: string; occupancy: number };

export function measureSubStrokeCoverage(route: readonly Vec2[], target: readonly Vec2[], ranges: readonly { label: string; start: number; end: number }[]): SubStrokeCoverage[] {
  const boundarySet: LetterBoundarySet = {
    boundaries: ranges.map((range, index) => ({
      letter: range.label,
      index,
      projectedStartProgress: range.start,
      projectedEndProgress: range.end,
      lengthStartProgress: range.start,
      lengthEndProgress: range.end,
      letterLength: 0,
    })),
    totalFlattenedLength: 0,
    totalLetterLength: 0,
    interLetterGapLength: 0,
  };
  const ink = computeInkOnlyOccupancy({ route, target, boundarySet });
  return ink.perLetterOccupancy.map((occupancy) => ({ label: occupancy.letter, occupancy: occupancy.occupancy }));
}

export function zStrokeRanges(zBoundary: LetterBoundary): Array<{ label: string; start: number; end: number }> {
  const { p0, p1, p2, p3 } = zStrokeProgressSplit(zBoundary);
  return [
    { label: 'top', start: p0, end: p1 },
    { label: 'diagonal', start: p1, end: p2 },
    { label: 'bottom', start: p2, end: p3 },
  ];
}

// ---------------------------------------------------------------------------
// Step 10 — where does the search lose Z: first-structural-failure classifier.
// Applied to the WHOLE (baseline or treatment) Z corpus; only meaningful
// (per the task) for candidates whose graph support was already established
// as good but whose physical traversal is poor — callers filter accordingly,
// this function itself never assumes that filter.
// ---------------------------------------------------------------------------

export type ZFailureMode =
  | 'A_fails_reach_top'
  | 'B_fails_top_to_diagonal'
  | 'C_fails_through_diagonal'
  | 'D_fails_diagonal_to_bottom'
  | 'E_F_reaches_all_but_not_physically_covered'
  | 'G_not_a_failure_or_unclassified';

export function classifyZFailureMode(input: {
  topInk: number;
  diagonalInk: number;
  bottomInk: number;
  checkpoint1Reached: boolean; // topToDiagonal
  checkpoint2Reached: boolean; // diagonalMid
  checkpoint3Reached: boolean; // diagonalToBottom
  wholeZPhysicallyCovered: boolean;
  inkThreshold: number;
}): ZFailureMode {
  const { topInk, diagonalInk, bottomInk, checkpoint1Reached, checkpoint2Reached, checkpoint3Reached, wholeZPhysicallyCovered, inkThreshold } = input;
  if (topInk < inkThreshold * 0.5) return 'A_fails_reach_top';
  if (!checkpoint1Reached) return 'B_fails_top_to_diagonal';
  if (diagonalInk < inkThreshold && !checkpoint2Reached) return 'C_fails_through_diagonal';
  if (!checkpoint3Reached || bottomInk < inkThreshold) return 'D_fails_diagonal_to_bottom';
  if (!wholeZPhysicallyCovered) return 'E_F_reaches_all_but_not_physically_covered';
  return 'G_not_a_failure_or_unclassified';
}
