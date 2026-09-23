/**
 * Completion-aware goal support for graph-constrained multi-letter routes.
 *
 * Supplies routeGraphConstrainedShape's CompletionAwareGoalSupport hook:
 *  - finalLetterCompleteInOrder: the word's final letter is physically
 *    complete (the existing physical letter test: ink >= 0.6 and coverage
 *    >= 0.4) AND its target window is traversed in word order (the existing
 *    directional traversal classification, category A_correct);
 *  - acceptCandidate: the nine-guard fallback (completion-goal-guards.ts,
 *    continuity rule 'no_valid_to_invalid') comparing the candidate route
 *    with the production-selected route.
 *
 * Every measurement reuses the existing evaluators the rest of the
 * experimental pipeline already relies on (the same ones used to validate
 * this logic): evaluatePhysicalWordTraversal, computeInkOnlyOccupancy,
 * analyzeStrokeTraversal, decomposeTargetSpan, decomposeContinuity and
 * scorePolylines. No new scoring is introduced.
 */
import { distanceToPolyline, polylineLength, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';
import { scorePolylines } from '@/lib/shape-match';

import type { CompletionAwareGoalSupport, GraphShapeResult } from './graph-shape';
import { buildWalkableWordShape } from './walkable-target';
import { analyzeTargetIdentity, coverageThresholdMeters } from './target-identity';
import { evaluateTwoSidedGuard, type GuardQuality } from './completion-goal-guards';
import { computeInkOnlyOccupancy } from '../diagnostics/letter-occupancy';
import { letterBoundariesFromWordShape } from '../diagnostics/multi-letter-trace';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from '../diagnostics/physical-word-traversal-evaluator';
import { analyzeStrokeTraversal, buildRoutePieces, DIRECTION_THRESHOLDS, type RoutePiece } from '../diagnostics/z-diagonal-direction-diagnostic';
import { decomposeTargetSpan } from '../diagnostics/target-span-decomposition-diagnostic';
import { decomposeContinuity } from '../diagnostics/continuity-decomposition-diagnostic';

/** Returns the hook for a multi-letter word, or undefined for single letters (unchanged production behavior). */
export function createCompletionAwareGoalSupport(input: { word: string; target: readonly Vec2[]; geometryVariant: LetterShapeVariant }): CompletionAwareGoalSupport | undefined {
  const { word, target, geometryVariant } = input;
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const boundaries = boundarySet.boundaries;
  if (boundaries.length < 2) return undefined;
  const finalIndex = boundaries.length - 1;
  const finalBoundary = boundaries[finalIndex]!;
  const finalWindow = { label: finalBoundary.letter, start: finalBoundary.projectedStartProgress, end: finalBoundary.projectedEndProgress };

  // Exact necessary condition for an A_correct traversal of the final window
  // (see forwardRunBoundAllows below): precomputed once per target.
  const targetLength = polylineLength(target);
  const finalSlice = sliceByProgress(target, finalWindow.start, finalWindow.end);
  const windowTargetMeters = (finalWindow.end - finalWindow.start) * targetLength;
  const inkRadius = coverageThresholdMeters(target);

  // Route pieces depend only on (segment endpoints, target) apart from their
  // running `index` / `routeMeters`, so they are built once per segment and
  // concatenated in path order. Only analyzeStrokeTraversal(...).category is
  // read here, which never depends on `index` or `routeMeters` (they only feed
  // its per-bin entry counts and analyzeTransition), so the cached pieces are
  // passed as-is.
  const pieceCache = new Map<string, RoutePiece[]>();
  const routePieces = (pathPoints: readonly Vec2[]): RoutePiece[] => {
    const pieces: RoutePiece[] = [];
    for (let i = 0; i + 1 < pathPoints.length; i += 1) {
      const a = pathPoints[i]!;
      const b = pathPoints[i + 1]!;
      const key = `${a.x},${a.y},${b.x},${b.y}`;
      let segment = pieceCache.get(key);
      if (!segment) {
        segment = buildRoutePieces([a, b], target);
        pieceCache.set(key, segment);
      }
      for (const piece of segment) pieces.push(piece);
    }
    return pieces;
  };

  // Per-segment length of pieces whose midpoints lie within inkRadius of the final slice (see forwardRunBoundAllows).
  const nearCache = new Map<string, number>();
  const nearLength = (pathPoints: readonly Vec2[]): number => {
    let total = 0;
    for (let i = 0; i + 1 < pathPoints.length; i += 1) {
      const a = pathPoints[i]!;
      const b = pathPoints[i + 1]!;
      const key = `${a.x},${a.y},${b.x},${b.y}`;
      let near = nearCache.get(key);
      if (near === undefined) {
        near = segmentNearLength(a, b, finalSlice, inkRadius);
        nearCache.set(key, near);
      }
      total += near;
    }
    return total;
  };
  const neededForwardMeters = DIRECTION_THRESHOLDS.meaningfulRunT * windowTargetMeters;

  const finalLetterCompleteInOrder = (pathPoints: readonly Vec2[]): boolean => {
    if (pathPoints.length < 2) return false;
    // All four conditions must hold; they are evaluated cheapest-first, which cannot change the result.
    // 1. An A_correct traversal needs a forward run >= meaningfulRunT of the window: the route must have at
    //    least that much length within inkRadius of the final letter's target slice (exact necessary bound;
    //    the 1e-6 m slack only makes the filter more permissive, absorbing summation-order rounding).
    if (nearLength(pathPoints) < neededForwardMeters - 1e-6) return false;
    // 2. Direction: the existing traversal classification of the final window.
    if (analyzeStrokeTraversal(routePieces(pathPoints), target, finalWindow).category !== 'A_correct') return false;
    // 3. Physical completion needs the final letter's ink-only occupancy >= inkThreshold.
    const ink = computeInkOnlyOccupancy({ route: pathPoints, target, boundarySet }).perLetterOccupancy[finalIndex]?.occupancy ?? 0;
    if (ink < PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold) return false;
    // 4. Physical completion: the existing physical letter test (evaluatePhysicalWordTraversal) is
    //    rawInk >= inkThreshold (step 3) AND target-identity letter coverage >= coverageThreshold.
    return (analyzeTargetIdentity({ route: pathPoints, target, word, geometryVariant }).letters[finalIndex]?.coverage ?? 0) >= PHYSICAL_TRAVERSAL_DEFAULTS.coverageThreshold;
  };

  const guardQuality = (result: GraphShapeResult): GuardQuality => {
    const path = result.pathPoints;
    const scored = scorePolylines(path, target);
    const physical = evaluatePhysicalWordTraversal(word, target, path, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
    return {
      shapeScore: scored.score,
      targetCoverage: result.metrics.targetCoverage,
      backtracking: scored.details.backtrackRatio,
      routeTarget: decomposeTargetSpan(word, target, path, geometryVariant).lengthRatioProjected,
      feasible: result.failure === null,
      wordTraversalPhysical: physical.wordTraversalPhysical,
      letters: physical.letters.map((letter) => ({ physicallyCovered: letter.physicallyCovered, coverage: letter.coverage, rawInk: letter.rawInkCoverage })),
      continuityValid: decomposeContinuity(word, target, path, geometryVariant).continuityValid,
    };
  };

  return {
    finalLetterCompleteInOrder,
    acceptCandidate: (baseline, candidate) => evaluateTwoSidedGuard(guardQuality(baseline), guardQuality(candidate), { continuityRule: 'no_valid_to_invalid' }).accepted,
  };
}

/** The target polyline between two progress values (arc-length fractions), cut exactly at both ends. */
function sliceByProgress(target: readonly Vec2[], start: number, end: number): Vec2[] {
  const total = polylineLength(target);
  const a = Math.max(0, start) * total;
  const b = Math.min(1, end) * total;
  const out: Vec2[] = [];
  let traveled = 0;
  for (let i = 0; i + 1 < target.length; i += 1) {
    const p = target[i]!;
    const q = target[i + 1]!;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const s0 = traveled;
    const s1 = traveled + len;
    if (s1 >= a && s0 <= b && len > 0) {
      const from = Math.max(a, s0);
      const to = Math.min(b, s1);
      const at = (d: number) => ({ x: p.x + ((q.x - p.x) * (d - s0)) / len, y: p.y + ((q.y - p.y) * (d - s0)) / len });
      if (out.length === 0) out.push(at(from));
      out.push(at(to));
    }
    traveled = s1;
  }
  return out.length >= 2 ? out : target.slice(0, 2).map((p) => ({ ...p }));
}

/**
 * Exact necessary condition for analyzeStrokeTraversal(...).category ===
 * 'A_correct' on the final window. A_correct requires a forward run >=
 * meaningfulRunT, and a run's span is a sum of |alongMeters| /
 * windowTargetMeters over IN-WINDOW route pieces, with |alongMeters| <= the
 * piece length. An in-window piece has its midpoint within inkRadius of the
 * target at a progress inside the window, i.e. within inkRadius of the
 * window's own target slice. So the total length of pieces (the same 6 m
 * subdivision as buildRoutePieces) whose midpoints lie within inkRadius of
 * the slice must reach meaningfulRunT x windowTargetMeters.
 * This returns one route segment's contribution to that total.
 */
function segmentNearLength(start: Vec2, end: Vec2, slice: readonly Vec2[], inkRadius: number): number {
  const segLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (segLength < 1e-6) return 0;
  const parts = Math.max(1, Math.ceil(segLength / DIRECTION_THRESHOLDS.pieceMeters));
  const length = segLength / parts;
  let near = 0;
  for (let k = 0; k < parts; k += 1) {
    const t = (k + 0.5) / parts;
    if (distanceToPolyline({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }, slice) <= inkRadius) near += length;
  }
  return near;
}
