/**
 * DEVELOPMENT ONLY. Shadow direction-tolerance evaluator — observation
 * only, never called from the live route generation/scoring/gate path.
 *
 * Traces and mirrors shape-order.ts's private headingConsistency() exactly
 * (re-verified by reading the current source, not relying on prior-session
 * summaries):
 *
 *   function headingConsistency(sampledRoute, targetPolyline, coverageThreshold) {
 *     let weighted = 0, weight = 0;
 *     const far = Math.max(coverageThreshold * 2, 1);
 *     for (let index = 1; index < sampledRoute.length; index += 1) {
 *       const from = sampledRoute[index - 1], to = sampledRoute[index];
 *       if (!from || !to) continue;
 *       const segment = distance2(from, to);
 *       if (segment < 1e-9) continue;            // zero-length route segments are SKIPPED ENTIRELY (excluded from weight too)
 *       weight += segment;                        // EVERY other segment counts toward the denominator...
 *       const hit = projectPointOnPolyline(to, targetPolyline);
 *       if (hit.distance > far) continue;          // ...even ones skipped here for being farther than `far`...
 *       const start = targetPolyline[hit.segmentIndex];
 *       const end = targetPolyline[hit.segmentIndex + 1] ?? start;
 *       if (!start || !end || distance2(start, end) < 1e-9) continue; // ...or here for a degenerate matched target segment.
 *       const delta = Math.abs(shortestAngleDelta(headingRadians(from, to), headingRadians(start, end)));
 *       weighted += clamp01(1 - delta / (Math.PI / 2)) * segment;    // ONLY usable segments add to the numerator.
 *     }
 *     return weight === 0 ? 0 : weighted / weight;
 *   }
 *
 * Confirmed facts (Section 1 of the task): route heading = headingRadians(from,to)
 * between consecutive SAMPLED route points (the letter-local sampled route, not
 * raw GPS); target heading = headingRadians(start,end) of the target segment
 * NEAREST the route point `to` (via projectPointOnPolyline's segmentIndex, i.e.
 * the LETTER-LOCAL target polyline, not global word coordinates); the far cutoff
 * and angular penalty are evaluated per-segment; a segment failing either check
 * still contributes its full length to the denominator (implicit maximal
 * penalty, never an actual angle) — the final score IS normalized by ALL
 * route-segment length, not just usable segments. Zero-length route segments
 * are the only ones excluded from the denominator entirely.
 *
 * The two "suspicious mechanics" this file tests, both PARAMETERIZED (not
 * hardcoded) versions of the exact same two lines above:
 *   - `far = max(coverageThreshold*2, 1) * farCutoffMultiplier`
 *   - `clamp01(1 - delta / angleScaleRadians)` instead of `delta / (π/2)`
 * At farCutoffMultiplier=1 and angleScaleDegrees=90, this reproduces the
 * real directionFit exactly (verified in the self-test).
 */
import {
  distance2,
  headingRadians,
  projectPointOnPolyline,
  shortestAngleDelta,
  type Vec2,
} from '@/lib/geometry';

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export const FAR_CUTOFF_MULTIPLIERS = [0.5, 1, 1.5, 2, 3] as const;
export const ANGLE_SCALES_DEGREES = [90, 120, 135, 180] as const;
const PRODUCTION_ANGLE_SCALE_DEGREES = 90;

export type DirectionSegmentStats = {
  /** = the `weight` denominator at production params: sum of every nonzero-length route segment's length. */
  totalRouteSegmentLength: number;
  usableSegmentLength: number;
  farCutoffSegmentLength: number;
  degenerateSegmentLength: number;
  usableSegmentCount: number;
  farCutoffSegmentCount: number;
  degenerateSegmentCount: number;
  /** Per-usable-segment angular error (degrees), at production far-cutoff — independent of angle scale (the angle scale only affects how a delta is CREDITED, not which segments are usable). */
  angularErrorsDegrees: number[];
  meanAngularErrorDegrees: number | null;
  medianAngularErrorDegrees: number | null;
  maxAngularErrorDegrees: number | null;
  /** farCutoffSegmentLength / totalRouteSegmentLength — how much of the route's own length is excluded purely by distance, at production params. */
  farCutoffFraction: number;
};

/** Walks the exact same loop as headingConsistency(), at the PRODUCTION far cutoff, collecting stats headingConsistency() itself computes internally but discards. */
export function computeDirectionSegmentStats(
  sampledRoute: readonly Vec2[],
  targetPolyline: readonly Vec2[],
  coverageThreshold: number,
): DirectionSegmentStats {
  const far = Math.max(coverageThreshold * 2, 1);
  let totalRouteSegmentLength = 0;
  let usableSegmentLength = 0;
  let farCutoffSegmentLength = 0;
  let degenerateSegmentLength = 0;
  let usableSegmentCount = 0;
  let farCutoffSegmentCount = 0;
  let degenerateSegmentCount = 0;
  const angularErrorsDegrees: number[] = [];

  for (let index = 1; index < sampledRoute.length; index += 1) {
    const from = sampledRoute[index - 1];
    const to = sampledRoute[index];
    if (!from || !to) continue;
    const segment = distance2(from, to);
    if (segment < 1e-9) continue;
    totalRouteSegmentLength += segment;

    const hit = projectPointOnPolyline(to, targetPolyline);
    if (hit.distance > far) {
      farCutoffSegmentLength += segment;
      farCutoffSegmentCount += 1;
      continue;
    }
    const start = targetPolyline[hit.segmentIndex];
    const end = targetPolyline[hit.segmentIndex + 1] ?? start;
    if (!start || !end || distance2(start, end) < 1e-9) {
      degenerateSegmentLength += segment;
      degenerateSegmentCount += 1;
      continue;
    }
    const delta = Math.abs(shortestAngleDelta(headingRadians(from, to), headingRadians(start, end)));
    angularErrorsDegrees.push((delta * 180) / Math.PI);
    usableSegmentLength += segment;
    usableSegmentCount += 1;
  }

  const sorted = [...angularErrorsDegrees].sort((a, b) => a - b);
  const median = sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

  return {
    totalRouteSegmentLength,
    usableSegmentLength,
    farCutoffSegmentLength,
    degenerateSegmentLength,
    usableSegmentCount,
    farCutoffSegmentCount,
    degenerateSegmentCount,
    angularErrorsDegrees,
    meanAngularErrorDegrees: angularErrorsDegrees.length ? angularErrorsDegrees.reduce((s, v) => s + v, 0) / angularErrorsDegrees.length : null,
    medianAngularErrorDegrees: median,
    maxAngularErrorDegrees: angularErrorsDegrees.length ? Math.max(...angularErrorsDegrees) : null,
    farCutoffFraction: totalRouteSegmentLength === 0 ? 0 : farCutoffSegmentLength / totalRouteSegmentLength,
  };
}

/**
 * Parameterized mirror of headingConsistency(): farCutoffMultiplier=1 and
 * angleScaleDegrees=90 reproduce the real directionFit exactly (verified
 * in the self-test). Never calls or alters scoreOrderedPath()/production.
 */
export function computeShadowDirectionFit(
  sampledRoute: readonly Vec2[],
  targetPolyline: readonly Vec2[],
  coverageThreshold: number,
  farCutoffMultiplier: number,
  angleScaleDegrees: number,
): number {
  const far = Math.max(coverageThreshold * 2, 1) * farCutoffMultiplier;
  const angleScaleRadians = (angleScaleDegrees * Math.PI) / 180;
  let weighted = 0;
  let weight = 0;

  for (let index = 1; index < sampledRoute.length; index += 1) {
    const from = sampledRoute[index - 1];
    const to = sampledRoute[index];
    if (!from || !to) continue;
    const segment = distance2(from, to);
    if (segment < 1e-9) continue;
    weight += segment;

    const hit = projectPointOnPolyline(to, targetPolyline);
    if (hit.distance > far) continue;
    const start = targetPolyline[hit.segmentIndex];
    const end = targetPolyline[hit.segmentIndex + 1] ?? start;
    if (!start || !end || distance2(start, end) < 1e-9) continue;
    const delta = Math.abs(shortestAngleDelta(headingRadians(from, to), headingRadians(start, end)));
    weighted += clamp01(1 - delta / angleScaleRadians) * segment;
  }

  return weight === 0 ? 0 : weighted / weight;
}

export type DirectionShadowOrder = {
  farCutoffMultiplier: number;
  angleScaleDegrees: number;
  shadowDirectionFit: number;
  /** = 0.5*dtwFit_production + 0.3*progressFit_production + 0.2*shadowDirectionFit — dtw and progress held at production values throughout, per task Section 6. */
  shadowOrder: number;
};

/** dtwFit/progressFit are held at their REAL production values (never altered) — only directionFit is swapped in, per task Section 6. */
export function computeDirectionShadowOrder(
  sampledRoute: readonly Vec2[],
  targetPolyline: readonly Vec2[],
  coverageThreshold: number,
  dtwFitProduction: number,
  progressFitProduction: number,
  farCutoffMultiplier: number,
  angleScaleDegrees: number,
): DirectionShadowOrder {
  const shadowDirectionFit = computeShadowDirectionFit(sampledRoute, targetPolyline, coverageThreshold, farCutoffMultiplier, angleScaleDegrees);
  const shadowOrder = clamp01(0.5 * dtwFitProduction + 0.3 * progressFitProduction + 0.2 * shadowDirectionFit);
  return { farCutoffMultiplier, angleScaleDegrees, shadowDirectionFit, shadowOrder };
}

export type DirectionBoundClassification = 'cutoff_bound' | 'angular_bound' | 'mixed' | 'direction_insensitive';

/** Diagnostic-only "material" delta threshold for labeling — not a production concept. */
const MATERIAL_DELTA = 0.05;

/**
 * Classifies based on MEASURED deltas (task Section 8): a generous cutoff
 * relaxation (3x, angle held at production 90°) vs a generous angle
 * relaxation (180°, cutoff held at production 1x), both compared against
 * the real production directionFit.
 */
export function classifyDirectionBound(
  productionDirectionFit: number,
  cutoffRelaxedDirectionFit: number,
  angleRelaxedDirectionFit: number,
): DirectionBoundClassification {
  const cutoffDelta = cutoffRelaxedDirectionFit - productionDirectionFit;
  const angularDelta = angleRelaxedDirectionFit - productionDirectionFit;
  const cutoffMaterial = cutoffDelta >= MATERIAL_DELTA;
  const angularMaterial = angularDelta >= MATERIAL_DELTA;
  if (cutoffMaterial && angularMaterial) return 'mixed';
  if (cutoffMaterial) return 'cutoff_bound';
  if (angularMaterial) return 'angular_bound';
  return 'direction_insensitive';
}
