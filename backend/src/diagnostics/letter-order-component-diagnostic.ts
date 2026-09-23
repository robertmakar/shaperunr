/**
 * DEVELOPMENT ONLY. Follow-up root-cause diagnostic testing the two
 * specific hypotheses raised by the prior per-letter order diagnostic:
 *
 * (1) headingConsistency() computes headings between CONSECUTIVE ENTRIES
 *     of the FILTERED letterRoute array, which is a .filter() over the
 *     80-point full-route resample — two consecutive letterRoute entries
 *     are not necessarily geometrically adjacent on the real route, so a
 *     "heading" can be synthesized between two points the runner never
 *     walked directly between.
 * (2) progressConsistency()'s jumpAllow = 4/(n-1) and fixed 0.12
 *     revisit-drop threshold may be poorly calibrated for the SMALL
 *     per-letter point counts (n = letterRoute.length, measured mean 15.6
 *     last task) that per-letter calls actually use.
 *
 * Never modifies production. Reuses, unmodified: scoreOrderedPath
 * (lib/shape-order.ts) is READ (for its exact formulas, mirrored below
 * for shadow parameterization) but the REAL production values used for
 * comparison always come from the real function via
 * order-score-diagnostic.ts's already-parity-verified
 * extractLetterOrderInputs/computeLetterOrderDecomposition — never
 * reimplemented for the "actual" baseline.
 *
 * EXACT formulas traced directly from lib/shape-order.ts (Step 1):
 *
 *   progressConsistency(sampledRoute, targetPolyline):
 *     progress[i] = projectPointOnPolyline(sampledRoute[i], targetPolyline).progress
 *     jumpAllow = 4 / max(progress.length - 1, 1)
 *       — for the per-letter call, sampledRoute = letterRoute (the
 *       FILTERED array), so n = letterRoute.length, NOT the full route's
 *       80-sample count and NOT the letterTarget's own point count.
 *     skipAmount = sum(max(0, delta - jumpAllow)) over consecutive deltas
 *     jumpFit = clamp01(1 - skipAmount/0.35)
 *     revisitSteps = count of steps where current < runningMax - 0.12
 *       — runningMax tracks the highest progress seen so far; 0.12 is a
 *       FIXED constant, and since targetPolyline=letterTarget in the
 *       per-letter call, this progress is already LETTER-LOCAL (0..1 over
 *       just this letter), so 0.12 = 12% of the letter's OWN span, not
 *       12% of the whole word.
 *     revisitFit = 1 - revisitSteps/(progress.length-1)
 *     monotonicFit = positiveVariation / (positiveVariation+negativeVariation)
 *
 *   headingConsistency(sampledRoute, targetPolyline, coverageThreshold):
 *     for each CONSECUTIVE PAIR in sampledRoute (= letterRoute for the
 *     per-letter call): compute heading(from,to), project `to` onto
 *     targetPolyline, skip if too far (> max(coverageThreshold*2,1)),
 *     else weight by segment length and compare heading against the
 *     target's local segment heading.
 */
import { distance2, headingRadians, projectPointOnPolyline, resamplePolyline, shortestAngleDelta, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

import { coverageThresholdMeters, TARGET_IDENTITY } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { extractLetterOrderInputs, computeLetterOrderDecomposition, type LetterOrderInputs } from './order-score-diagnostic';

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ---------------------------------------------------------------------------
// Step 2 — filtered-heading segment audit: for every consecutive pair in
// letterRoute, report the ORIGINAL (full 80-sample route) index gap.
// ---------------------------------------------------------------------------

export type FilteredHeadingSegment = {
  letter: string;
  filteredIndexA: number;
  filteredIndexB: number;
  originalIndexA: number;
  originalIndexB: number;
  originalIndexGap: number;
  geometricDistanceUnits: number;
  headingDegrees: number;
};

/** For each letter, re-derives letterRoute EXACTLY as production does (same filter), but keeps each selected point's original index in the 80-sample full-route resample, then reports every consecutive-in-letterRoute pair's original-index gap and the (artificial, if gap>1) heading actually used by the real headingConsistency(). */
export function auditFilteredHeadingSegments(word: string, target: readonly Vec2[], route: readonly Vec2[], geometryVariant: LetterShapeVariant): FilteredHeadingSegment[][] {
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  if (!shape.word || shape.letters.length === 0 || target.length < 2) return [];
  const wordThreshold = coverageThresholdMeters(target);
  const sampledRoute = resamplePolyline(route, TARGET_IDENTITY.sampleCount);
  const fullProjections = sampledRoute.map((point) => projectPointOnPolyline(point, target));

  return shape.letters.map((letter) => {
    const projections = letter.points.map((point) => projectPointOnPolyline(point, shape.points).progress);
    const startProgress = projections.length === 0 ? 0 : Math.min(...projections);
    const endProgress = projections.length === 0 ? 0 : Math.max(...projections);
    const samples48 = resamplePolyline(target, 48);
    const letterTargetSlice = samples48.filter((_, index) => {
      const progress = samples48.length === 1 ? 0 : index / (samples48.length - 1);
      return progress >= startProgress - 0.02 && progress <= endProgress + 0.02;
    });
    const effectiveLetterTarget = letterTargetSlice.length >= 2 ? letterTargetSlice : samples48.slice(0, 2);
    const letterThreshold = Math.min(wordThreshold, coverageThresholdMeters(effectiveLetterTarget));

    const selected: Array<{ originalIndex: number; point: Vec2 }> = [];
    sampledRoute.forEach((point, i) => {
      const hit = fullProjections[i]!;
      if (hit.distance <= letterThreshold * 2 && hit.progress >= startProgress - 0.03 && hit.progress <= endProgress + 0.03) {
        selected.push({ originalIndex: i, point });
      }
    });

    const segments: FilteredHeadingSegment[] = [];
    for (let i = 1; i < selected.length; i += 1) {
      const a = selected[i - 1]!;
      const b = selected[i]!;
      const heading = distance2(a.point, b.point) > 1e-9 ? (headingRadians(a.point, b.point) * 180) / Math.PI : 0;
      segments.push({
        letter: letter.char,
        filteredIndexA: i - 1,
        filteredIndexB: i,
        originalIndexA: a.originalIndex,
        originalIndexB: b.originalIndex,
        originalIndexGap: b.originalIndex - a.originalIndex,
        geometricDistanceUnits: distance2(a.point, b.point),
        headingDegrees: heading,
      });
    }
    return segments;
  });
}

// ---------------------------------------------------------------------------
// Step 3 — shadow "real-segment" direction: only ever use REAL adjacent
// route pairs, membership decided per-segment (either endpoint qualifies
// under the SAME distance+progress test the current filter already uses).
// ---------------------------------------------------------------------------

export type RealSegmentDirectionResult = {
  directionFit: number;
  segmentCount: number;
  realHeadings: Array<{ fromOriginalIndex: number; toOriginalIndex: number; headingDegrees: number; contribution: number | null }>;
};

export function computeRealSegmentDirectionFit(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: LetterShapeVariant,
  letterIndex: number,
): RealSegmentDirectionResult {
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  const letter = shape.letters[letterIndex];
  if (!letter || target.length < 2) return { directionFit: 0, segmentCount: 0, realHeadings: [] };

  const wordThreshold = coverageThresholdMeters(target);
  const sampledRoute = resamplePolyline(route, TARGET_IDENTITY.sampleCount);
  const fullProjections = sampledRoute.map((point) => projectPointOnPolyline(point, target));

  const projections = letter.points.map((point) => projectPointOnPolyline(point, shape.points).progress);
  const startProgress = projections.length === 0 ? 0 : Math.min(...projections);
  const endProgress = projections.length === 0 ? 0 : Math.max(...projections);

  // letterTarget for local heading comparison — same slice production uses.
  const samples48 = resamplePolyline(target, 48);
  const letterTarget = samples48.filter((_, index) => {
    const progress = samples48.length === 1 ? 0 : index / (samples48.length - 1);
    return progress >= startProgress - 0.02 && progress <= endProgress + 0.02;
  });
  const effectiveLetterTarget = letterTarget.length >= 2 ? letterTarget : samples48.slice(0, 2);
  const perLetterThreshold = Math.min(wordThreshold, coverageThresholdMeters(effectiveLetterTarget));
  const far = Math.max(perLetterThreshold * 2, 1);

  const membership = (hit: { distance: number; progress: number }) => hit.distance <= perLetterThreshold * 2 && hit.progress >= startProgress - 0.03 && hit.progress <= endProgress + 0.03;

  let weighted = 0;
  let weight = 0;
  const realHeadings: RealSegmentDirectionResult['realHeadings'] = [];
  for (let i = 1; i < sampledRoute.length; i += 1) {
    const fromHit = fullProjections[i - 1]!;
    const toHit = fullProjections[i]!;
    if (!membership(fromHit) && !membership(toHit)) continue;
    const from = sampledRoute[i - 1]!;
    const to = sampledRoute[i]!;
    const segmentLength = distance2(from, to);
    if (segmentLength < 1e-9) continue;
    const headingDeg = (headingRadians(from, to) * 180) / Math.PI;
    const hit = projectPointOnPolyline(to, effectiveLetterTarget);
    if (hit.distance > far) {
      realHeadings.push({ fromOriginalIndex: i - 1, toOriginalIndex: i, headingDegrees: headingDeg, contribution: null });
      continue;
    }
    const start = effectiveLetterTarget[hit.segmentIndex];
    const end = effectiveLetterTarget[hit.segmentIndex + 1] ?? start;
    if (!start || !end || distance2(start, end) < 1e-9) {
      realHeadings.push({ fromOriginalIndex: i - 1, toOriginalIndex: i, headingDegrees: headingDeg, contribution: null });
      continue;
    }
    const deltaRadians = Math.abs(shortestAngleDelta(headingRadians(from, to), headingRadians(start, end)));
    const contribution = clamp01(1 - deltaRadians / (Math.PI / 2));
    weight += segmentLength;
    weighted += contribution * segmentLength;
    realHeadings.push({ fromOriginalIndex: i - 1, toOriginalIndex: i, headingDegrees: headingDeg, contribution });
  }

  return { directionFit: weight === 0 ? 0 : weighted / weight, segmentCount: realHeadings.length, realHeadings };
}

// ---------------------------------------------------------------------------
// Steps 6/7 — jumpAllow shadow variants (mirrors progressConsistency exactly,
// parameterized numerator; monotonicFit/revisitFit use the CURRENT 0.12
// unless explicitly varied in Step 9).
// ---------------------------------------------------------------------------

export type ProgressConsistencyResult = { monotonicFit: number; jumpFit: number; revisitFit: number; skipAmount: number; revisitSteps: number; sampleCount: number };

export function progressConsistencyShadow(sampledRoute: readonly Vec2[], targetPolyline: readonly Vec2[], jumpAllowNumerator: number, revisitThreshold: number): ProgressConsistencyResult {
  const progress = sampledRoute.map((point) => projectPointOnPolyline(point, targetPolyline).progress);
  if (progress.length < 2) return { monotonicFit: 1, jumpFit: 1, revisitFit: 1, skipAmount: 0, revisitSteps: 0, sampleCount: progress.length };

  let positive = 0;
  let negative = 0;
  let skipAmount = 0;
  let revisitSteps = 0;
  let maxProgress = progress[0] ?? 0;
  const jumpAllow = jumpAllowNumerator / Math.max(progress.length - 1, 1);

  for (let index = 1; index < progress.length; index += 1) {
    const current = progress[index] ?? 0;
    const previous = progress[index - 1] ?? 0;
    const delta = current - previous;
    if (delta >= 0) positive += delta;
    else negative += -delta;
    skipAmount += Math.max(0, delta - jumpAllow);
    maxProgress = Math.max(maxProgress, previous);
    if (current < maxProgress - revisitThreshold) revisitSteps += 1;
  }

  const variation = positive + negative;
  const monotonicFit = variation === 0 ? 1 : positive / variation;
  const jumpFit = clamp01(1 - skipAmount / 0.35);
  const revisitFit = 1 - revisitSteps / (progress.length - 1);
  return { monotonicFit, jumpFit, revisitFit, skipAmount, revisitSteps, sampleCount: progress.length };
}

export const JUMP_ALLOW_VARIANTS: Record<string, number> = { A_current_4: 4, B_6: 6, C_8: 8, D_12: 12 };
export const REVISIT_THRESHOLD_VARIANTS: Record<string, number> = { current_012: 0.12, v_008: 0.08, v_016: 0.16, v_020: 0.2, v_025: 0.25 };

// ---------------------------------------------------------------------------
// Recombination helpers — UNCHANGED weights (0.5/0.3/0.2 for progressFit's
// own sub-weights, 0.5/0.3/0.2 for order's dtw/progress/direction weights).
// ---------------------------------------------------------------------------

export function combineProgressFit(monotonicFit: number, jumpFit: number, revisitFit: number): number {
  return clamp01(0.5 * monotonicFit + 0.3 * jumpFit + 0.2 * revisitFit);
}

export function combineOrder(dtwFit: number, progressFit: number, directionFit: number): number {
  return clamp01(0.5 * dtwFit + 0.3 * progressFit + 0.2 * directionFit);
}

export { extractLetterOrderInputs, computeLetterOrderDecomposition, type LetterOrderInputs };
