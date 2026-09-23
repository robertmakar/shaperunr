/**
 * DEVELOPMENT ONLY. TargetSpan decomposition — diagnostic only, never
 * called from the live route-generation/scoring/gate path.
 *
 * Step 1 — exact trace of the real, UNMODIFIED targetSpan implementation
 * (generation/target-identity.ts, read directly, not assumed):
 *
 *   targetSpan = analyzeTargetIdentity(...).targetSpan
 *              = longestConnectedSpan(projections, threshold).span
 *                * spanOccupancy(projections, threshold, connected.start, connected.end)
 *
 *   where `projections` are the 80 whole-route-resampled samples (route
 *   CHRONOLOGICAL order), each projected onto the FULL target polyline
 *   (word-global progress, same target representation whole-route order
 *   uses) via projectPointOnPolyline.
 *
 *   longestConnectedSpan walks the 80 samples IN ROUTE ORDER and finds the
 *   single longest run where:
 *     - each sample is either "on target" (distance <= coverageThresholdMeters,
 *       an ABSOLUTE meters threshold, scale-dependent — floors at 18m) or a
 *       "near miss" (distance <= threshold*nearMissMultiplier=2) that keeps
 *       an already-open run alive without extending it;
 *     - up to maxOffTargetGapSamples=4 CONSECUTIVE off-target samples are
 *       tolerated before the run closes (an ABSOLUTE sample count out of the
 *       fixed 80 — not a proportion, not adaptive to route length or word
 *       length);
 *     - progress must not jump backward more than maxBacktrack=0.16 or
 *       forward more than maxForwardJump=0.12 (both WORD-GLOBAL progress
 *       fractions) in a single step, or the run closes and a new one may
 *       start. Unlike scoreOrderedPath's jumpAllow, exceeding this does NOT
 *       accumulate a penalty amount — it simply ends the current run, and
 *       only the run's own span (not any partial credit beyond it) counts.
 *   The run's `span` is (end progress - start progress) of that ROUTE-ORDER
 *   window, not literally which letters were visited — targetSpan has NO
 *   letter awareness at all.
 *
 *   spanOccupancy then divides that run's own [start,end] progress range
 *   into 32 fixed bins and requires an on-target sample within 1/32 of each
 *   bin's center to count it "occupied" — a DENSITY check on top of the
 *   connectivity check, independently able to punish a nominally-connected
 *   run that is unevenly sampled within its own range.
 *
 *   targetSpan = span * occupancy, so it is penalized by EITHER dimension:
 *   a short-but-dense run, or a long-but-sparse run, both lose credit.
 *
 * Relationship to other signals (established by inspection, not inference):
 *   - Letter completeness / sequence integrity: NOT letter-aware. targetSpan
 *     has no concept of which letter a sample belongs to — it operates
 *     purely on raw word-global progress bins and route-chronological
 *     connectivity. It has an IMPLICIT ordering requirement (a single run
 *     must move generally forward, tolerating <=0.16 backtrack per step)
 *     that is structurally different from — and much cruder than — the
 *     letter-boundary-based chronological sequence evaluator.
 *   - broadOrder (median global progress per letter, strictly increasing):
 *     letter-aware, per-letter-median-based; targetSpan is NOT letter-aware
 *     and operates on raw per-sample progress bins, not per-letter medians.
 *     The two can diverge: a route that visits every letter in the right
 *     order (broadOrder passes) can still fracture into multiple runs under
 *     targetSpan's route-chronological windowing if a single detour pushes
 *     more than 4 consecutive resampled points off-target, or a connector
 *     gap between letters exceeds the WORD-GLOBAL 0.12 forward-jump cap.
 *   - physical coverage / wordTraversal: independently computed elsewhere
 *     (physical-word-traversal-evaluator.ts, letterIdentities() inside
 *     target-identity.ts itself) — targetSpan does not read either.
 *
 * This file is a THIN, read-only wrapper: it calls the real,
 * UNMODIFIED analyzeTargetIdentity() and exposes fields it already
 * computes (Step 2's request), plus one small derived convenience
 * (first/last MEANINGFULLY VISITED letter, from identity.letters).
 * Nothing here reimplements or modifies targetSpan's calculation.
 */
import type { Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

import { analyzeTargetIdentity, type LetterIdentity } from '../generation/target-identity';

export type TargetSpanDecomposition = {
  targetSpan: number;
  naiveSpan: number;
  spanOccupancy: number;
  largestTargetGap: number;
  /** onTargetProgressMin/Max — the naive (unconnected) on-target progress bounds, before longestConnectedSpan's run-continuity requirement is applied. */
  firstTargetProgressReached: number | null;
  lastTargetProgressReached: number | null;
  /** startProgress/endProgress — the FIRST and LAST route sample's raw progress, in route-chronological order, regardless of whether either sample was on-target. */
  routeStartProgress: number;
  routeEndProgress: number;
  perLetterTargetProgress: Array<Pick<LetterIdentity, 'letter' | 'startProgress' | 'endProgress' | 'coverage' | 'order' | 'meaningfullyVisited'>>;
  firstVisitedLetter: string | null;
  lastVisitedLetter: string | null;
  wordTraversal: number;
  lettersVisitedInOrder: boolean;
  traversesMostOfWord: boolean;
  lengthRatioProjected: number;
};

export function decomposeTargetSpan(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: LetterShapeVariant,
  requestedDistanceMeters?: number,
): TargetSpanDecomposition {
  const identity = analyzeTargetIdentity({ route, target, word, geometryVariant, requestedDistanceMeters });
  const visited = identity.letters.filter((l) => l.meaningfullyVisited);
  return {
    targetSpan: identity.targetSpan,
    naiveSpan: identity.naiveSpan,
    spanOccupancy: identity.spanOccupancy,
    largestTargetGap: identity.largestTargetGap,
    firstTargetProgressReached: identity.onTargetProgressMin,
    lastTargetProgressReached: identity.onTargetProgressMax,
    routeStartProgress: identity.startProgress,
    routeEndProgress: identity.endProgress,
    perLetterTargetProgress: identity.letters.map((l) => ({ letter: l.letter, startProgress: l.startProgress, endProgress: l.endProgress, coverage: l.coverage, order: l.order, meaningfullyVisited: l.meaningfullyVisited })),
    firstVisitedLetter: visited[0]?.letter ?? null,
    lastVisitedLetter: visited[visited.length - 1]?.letter ?? null,
    wordTraversal: identity.wordTraversal,
    lettersVisitedInOrder: identity.lettersVisitedInOrder,
    traversesMostOfWord: identity.traversesMostOfWord,
    lengthRatioProjected: identity.lengthRatioProjected,
  };
}
