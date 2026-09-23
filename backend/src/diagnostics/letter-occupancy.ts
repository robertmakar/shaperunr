/**
 * DEVELOPMENT ONLY. Diagnostic ink-only occupancy — observation only, never
 * called from the live route-generation or product-gate path, never fed
 * into wordTraversal/traversesMostOfWord, never changes any accepted route.
 *
 * Reuses existing machinery rather than re-implementing shape matching:
 * - projectPointOnPolyline / resamplePolyline (lib/geometry.ts)
 * - TARGET_IDENTITY.sampleCount/progressBins and coverageThresholdMeters
 *   (generation/target-identity.ts) — the SAME sample density and distance
 *   threshold analyzeTargetIdentity's own spanOccupancy already uses.
 * - letterBoundariesFromWordShape (diagnostics/multi-letter-trace.ts) — the
 *   SAME projected per-letter boundaries target-identity.ts's letterIdentities
 *   computes (after the Part 1 geometryVariant fix, both now agree).
 *
 * What's new: spanOccupancy() (target-identity.ts, UNCHANGED by this file)
 * measures dense route-coverage over the "longest connected on-target span"
 * — a range that includes whatever inter-letter connector segments happen
 * to fall inside it. inkOnlyOccupancy measures the same kind of dense
 * bin-coverage, but restricted to bins that fall inside SOME letter's own
 * ink (per letterBoundariesFromWordShape), pooled across every letter —
 * connector-only bins are never counted as either occupied or unoccupied,
 * they simply don't exist in this metric's denominator.
 */
import { projectPointOnPolyline, resamplePolyline, type Vec2 } from '@/lib/geometry';

import { coverageThresholdMeters, TARGET_IDENTITY } from '../generation/target-identity';
import type { LetterBoundarySet } from './multi-letter-trace';

export type LetterOccupancy = {
  letter: string;
  index: number;
  /** Dense bin-occupancy restricted to this letter's own projected progress range only. Same bin width (1/progressBins) and same on-target distance threshold as the existing spanOccupancy(). */
  occupancy: number;
  /** Reused directly from the existing per-letter identity check (TargetIdentity.letters[i].meaningfullyVisited) — not re-derived here, so "completed" always means exactly what wordTraversal's own gate already means. */
  completed: boolean;
};

export type InkOnlyOccupancyResult = {
  /** Dense occupancy pooled across every letter's own ink bins only — the diagnostic counterpart to TargetIdentity.spanOccupancy, but never including inter-letter connector bins. */
  inkOnlyOccupancy: number;
  perLetterOccupancy: LetterOccupancy[];
  /** How many of the total bins fell inside some letter's own ink vs inside a connector gap — direct, quantified evidence of how much the connector geometry affects the bin-based calculation. */
  inkBinCount: number;
  gapBinCount: number;
  totalBinCount: number;
};

function computeBinOccupancy(
  projections: ReadonlyArray<{ progress: number; distance: number }>,
  threshold: number,
  start: number,
  end: number,
  bins: number,
): { occupied: number; total: number } {
  let occupied = 0;
  let total = 0;
  for (let index = 0; index < bins; index += 1) {
    const progress = (index + 0.5) / bins;
    if (progress < start || progress > end) {
      continue;
    }
    total += 1;
    if (projections.some((item) => item.distance <= threshold && Math.abs(item.progress - progress) <= 1 / bins)) {
      occupied += 1;
    }
  }
  return { occupied, total };
}

export function computeInkOnlyOccupancy(input: {
  route: readonly Vec2[];
  target: readonly Vec2[];
  boundarySet: LetterBoundarySet;
  /** TargetIdentity.letters[i].meaningfullyVisited, in the same order as boundarySet.boundaries — reused for the `completed` field so it always matches wordTraversal's own definition. Omit to leave every letter's `completed` as false. */
  letterMeaningfullyVisited?: readonly boolean[];
  bins?: number;
}): InkOnlyOccupancyResult {
  const bins = input.bins ?? TARGET_IDENTITY.progressBins;
  const threshold = coverageThresholdMeters(input.target);
  const sampledRoute = input.route.length >= 2 ? resamplePolyline(input.route, TARGET_IDENTITY.sampleCount) : [];
  const projections = sampledRoute.map((point) => projectPointOnPolyline(point, input.target));

  let totalOccupied = 0;
  let totalInkBins = 0;
  const perLetterOccupancy: LetterOccupancy[] = input.boundarySet.boundaries.map((boundary, index) => {
    const { occupied, total } = computeBinOccupancy(
      projections,
      threshold,
      boundary.projectedStartProgress,
      boundary.projectedEndProgress,
      bins,
    );
    totalOccupied += occupied;
    totalInkBins += total;
    return {
      letter: boundary.letter,
      index,
      occupancy: total === 0 ? 0 : occupied / total,
      completed: input.letterMeaningfullyVisited?.[index] ?? false,
    };
  });

  return {
    inkOnlyOccupancy: totalInkBins === 0 ? 0 : totalOccupied / totalInkBins,
    perLetterOccupancy,
    inkBinCount: totalInkBins,
    gapBinCount: Math.max(0, bins - totalInkBins),
    totalBinCount: bins,
  };
}

/**
 * The compact per-candidate diagnostic object (task's suggested shape,
 * adapted to this project's existing TargetIdentity fields — reused, not
 * duplicated): currentOccupiedSpan/currentSpanOccupancy/completedLetterCount/
 * completionRatio/lettersVisitedInOrder/wordTraversal all come straight off
 * an existing TargetIdentity result; only inkOnlyOccupancy and
 * perLetterOccupancy are newly computed here.
 */
export type CandidateOccupancyRecord = {
  word: string;
  geometryVariant: string;
  candidateRank: number;
  shapeScore: number | null;
  coverage: number | null;
  order: number | null;
  backtracking: number | null;
  /** = TargetIdentity.targetSpan (connected-span length × spanOccupancy), UNCHANGED, the value the 0.7 threshold is actually compared against. */
  currentOccupiedSpan: number;
  /** = TargetIdentity.spanOccupancy, UNCHANGED — the raw dense-occupancy fraction within the longest connected span. */
  currentSpanOccupancy: number;
  /** NEW — dense-occupancy fraction within letter ink only, pooled across all letters. */
  inkOnlyOccupancy: number;
  letters: LetterOccupancy[];
  /** = TargetIdentity.lettersVisited, UNCHANGED. */
  completedLetterCount: number;
  expectedLetterCount: number;
  /** = TargetIdentity.wordTraversal (the fraction, not the boolean gate), UNCHANGED. */
  completionRatio: number;
  /** = TargetIdentity.lettersVisitedInOrder, UNCHANGED. */
  lettersVisitedInOrder: boolean;
  /** = TargetIdentity.traversesMostOfWord, UNCHANGED — the actual product-gate boolean. */
  wordTraversal: boolean;
};
