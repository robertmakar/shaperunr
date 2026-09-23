/**
 * DEVELOPMENT ONLY. Continuity decomposition — diagnostic only, never
 * called from the live route-generation/scoring/gate path.
 *
 * Step 1 — exact trace of the real, UNMODIFIED continuity implementation
 * (inter-letter-continuity-diagnostic.ts + shadow-product-gate-evaluator.ts,
 * both read directly, not assumed; NEITHER is itself wired into production
 * today — continuity as evaluated here is the diagnostic-only shadow
 * signal built two tasks ago, reused unchanged):
 *
 *   evaluateContinuity(transitions, maxRatio=15):
 *     continuityValid = !hasDisconnectedTransition && (worstRatio <= maxRatio)
 *     hasDisconnectedTransition = any transition has routeDistance===null
 *       or straightLineDistance===null (the letter had ZERO route points
 *       assigned to it at all — genuinely never touched in route-space,
 *       not merely a large detour).
 *     worstRatio = max(routeToStraightRatio) across all inter-letter
 *       transitions, where routeToStraightRatio = routeDistance /
 *       straightLineDistance:
 *         routeDistance = sum of consecutive real segment lengths ALONG
 *           the actual 80-sample resampled route between letter A's LAST
 *           assigned point and letter B's FIRST assigned point (route-
 *           space, not target-space — this is continuity's core structural
 *           difference from targetSpan, which measures distance-TO-TARGET,
 *           not path-length-ALONG-ROUTE).
 *         straightLineDistance = Euclidean distance between those same
 *           two points.
 *       This is a RATIO, not an absolute distance and not a sample count —
 *       scale-invariant by construction (a 5m detour on a 10m gap and a
 *       500m detour on a 1000m gap score identically), unlike targetSpan's
 *       absolute-meters distance threshold (18m floor) and absolute
 *       4-consecutive-sample gap tolerance.
 *
 *   Continuity is measured ONLY across ADJACENT LETTER PAIRS (by
 *   construction of extractLetterRouteSpans/computeTransitionRecord) — it
 *   has NO concept of a discontinuity WITHIN one letter's own assigned
 *   points (e.g. a revisit that leaves and returns to the same letter far
 *   apart in route order is invisible to this check; that is a distinct,
 *   currently-unmeasured scope, not a bug in what continuity claims to do).
 *   It is letter-BOUNDARY-aware (it knows where letters start/end, via the
 *   same letter-assignment filter used elsewhere) but not letter-CONTENT-
 *   aware (it does not care whether a letter itself was fully covered —
 *   that is completeness's job).
 *
 *   Resampling: the underlying sampledRoute is TARGET_IDENTITY.sampleCount
 *   (80, fixed) resampled — same fixed count as targetSpan uses — but
 *   because the OUTPUT is a ratio of two route-space distances (not a
 *   count of samples exceeding a threshold), the underlying quantity
 *   should be far less sensitive to the exact sample count than
 *   targetSpan's discrete "4-consecutive-samples" rule. Step 6 verifies
 *   this empirically rather than assuming it.
 *
 * This file is a THIN, read-only wrapper around the real, UNMODIFIED
 * extractLetterRouteSpans / computeTransitionRecord / evaluateContinuity /
 * computeRoutePointContinuity / classifyTransition — nothing here
 * reimplements or changes continuity's calculation. The only genuinely NEW
 * logic is (a) aggregating per-transition records into corpus-level
 * summary statistics, and (b) a diagnostic-only, CONFIGURABLE-sample-count
 * variant of extractLetterRouteSpans/computeTransitionRecord (Step 6 needs
 * this — the real function hardcodes TARGET_IDENTITY.sampleCount=80 with
 * no override, so a parameterized MIRROR is built here, parity-checked
 * against the real one at n=80 in the self-test, per the session's
 * established "mirror and prove parity" pattern).
 */
import { distance2, projectPointOnPolyline, resamplePolyline, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

import { coverageThresholdMeters } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  extractLetterRouteSpans,
  computeTransitionRecord,
  computeRoutePointContinuity,
  classifyTransition,
  type LetterRouteSpan,
  type TransitionRecord,
  type TransitionClass,
  type RoutePointContinuityStats,
} from './inter-letter-continuity-diagnostic';
import { evaluateContinuity, SHADOW_CONTINUITY_DEFAULTS, type ContinuityEvaluation } from './shadow-product-gate-evaluator';

// ---------------------------------------------------------------------------
// Diagnostic classification thresholds (used ONLY to categorize break
// TYPE for reporting — never fed back into continuityValid itself, which
// always comes from the real, unmodified evaluateContinuity).
// ---------------------------------------------------------------------------

export const CONTINUITY_CLASSIFICATION_DEFAULTS = {
  directRatioMax: 2,
  shortDistanceMax: 40,
  disconnectedRatioMin: SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio,
  disconnectedUnassignedFractionMin: 0.25,
} as const;

export type ContinuityBreak = {
  fromLetter: string;
  toLetter: string;
  transitionClass: TransitionClass;
  /** Every break measured by continuity is, by construction, an inter-letter transition — never within one letter's own points, never specifically a "revisit" (a same-letter phenomenon outside this check's scope). */
  scope: 'between-letters';
  kind: 'genuine-disconnection' | 'excessive-detour-ratio' | 'within-tolerance';
  ratio: number | null;
  routeDistance: number | null;
  straightLineDistance: number | null;
};

export type ContinuityDecomposition = {
  continuityValid: boolean;
  hasDisconnectedTransition: boolean;
  worstRatio: number | null;
  numberOfBreaks: number;
  largestBreakRatio: number | null;
  totalDisconnectedTransitions: number;
  maxProgressDiscontinuity: number | null;
  breaks: ContinuityBreak[];
  transitions: TransitionRecord[];
  routePointStats: RoutePointContinuityStats;
};

function classifyBreak(record: TransitionRecord, maxRatio: number): ContinuityBreak['kind'] {
  if (record.routeDistance === null || record.straightLineDistance === null) return 'genuine-disconnection';
  if (record.routeToStraightRatio !== null && record.routeToStraightRatio > maxRatio) return 'excessive-detour-ratio';
  return 'within-tolerance';
}

export function decomposeContinuity(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: LetterShapeVariant,
  maxRatio: number = SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio,
): ContinuityDecomposition {
  const { spans, sampledRoute } = extractLetterRouteSpans(word, target, route, geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  const evaluation: ContinuityEvaluation = evaluateContinuity(transitions, maxRatio);
  const routePointStats = computeRoutePointContinuity(sampledRoute, spans);

  const breaks: ContinuityBreak[] = transitions.map((t) => ({
    fromLetter: t.fromLetter,
    toLetter: t.toLetter,
    transitionClass: classifyTransition(t, sampledRoute.length, CONTINUITY_CLASSIFICATION_DEFAULTS),
    scope: 'between-letters',
    kind: classifyBreak(t, maxRatio),
    ratio: t.routeToStraightRatio,
    routeDistance: t.routeDistance,
    straightLineDistance: t.straightLineDistance,
  }));

  const progressGaps = transitions.map((t) => t.targetProgressGap).filter((g): g is number => g !== null);
  const finiteRatios = breaks.map((b) => b.ratio).filter((r): r is number => r !== null && Number.isFinite(r));

  return {
    continuityValid: evaluation.continuityValid,
    hasDisconnectedTransition: evaluation.hasDisconnectedTransition,
    worstRatio: evaluation.maxRatio,
    numberOfBreaks: breaks.filter((b) => b.kind !== 'within-tolerance').length,
    largestBreakRatio: finiteRatios.length ? Math.max(...finiteRatios) : null,
    totalDisconnectedTransitions: breaks.filter((b) => b.kind === 'genuine-disconnection').length,
    maxProgressDiscontinuity: progressGaps.length ? Math.max(...progressGaps.map((g) => Math.abs(g))) : null,
    breaks,
    transitions,
    routePointStats,
  };
}

// ---------------------------------------------------------------------------
// Step 6 — configurable-sample-count MIRROR of extractLetterRouteSpans /
// computeTransitionRecord, for sampling-density sensitivity testing only.
// Parity with the real functions at sampleCount=80 is proven in the
// self-test. The real production code has no sample-count override.
// ---------------------------------------------------------------------------

function sliceTargetByProgressMirror(target: readonly Vec2[], start: number, end: number): Vec2[] {
  const samples = resamplePolyline(target, 48);
  const sliced = samples.filter((_, index) => {
    const progress = samples.length === 1 ? 0 : index / (samples.length - 1);
    return progress >= start - 0.02 && progress <= end + 0.02;
  });
  return sliced.length >= 2 ? sliced : samples.slice(0, 2);
}

export function extractLetterRouteSpansAtSampleCount(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: LetterShapeVariant,
  sampleCount: number,
): { spans: LetterRouteSpan[]; sampledRoute: Vec2[] } {
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  const sampledRoute = resamplePolyline(route, sampleCount);
  if (!shape.word || shape.letters.length === 0 || target.length < 2) return { spans: [], sampledRoute };
  const wordThreshold = coverageThresholdMeters(target);
  const fullProjections = sampledRoute.map((point) => projectPointOnPolyline(point, target));

  const spans = shape.letters.map((letter, letterIndex) => {
    const projections = letter.points.map((point) => projectPointOnPolyline(point, shape.points).progress);
    const startProgress = projections.length === 0 ? 0 : Math.min(...projections);
    const endProgress = projections.length === 0 ? 0 : Math.max(...projections);
    const letterTarget = sliceTargetByProgressMirror(target, startProgress, endProgress);
    const letterThreshold = Math.min(wordThreshold, coverageThresholdMeters(letterTarget));

    const assigned: Array<{ originalIndex: number; point: Vec2; progress: number }> = [];
    sampledRoute.forEach((point, i) => {
      const hit = fullProjections[i]!;
      if (hit.distance <= letterThreshold * 2 && hit.progress >= startProgress - 0.03 && hit.progress <= endProgress + 0.03) {
        assigned.push({ originalIndex: i, point, progress: hit.progress });
      }
    });
    const first = assigned[0] ?? null;
    const last = assigned[assigned.length - 1] ?? null;
    const progresses = assigned.map((a) => a.progress);
    return {
      letterIndex,
      letter: letter.char,
      assignedOriginalIndices: assigned.map((a) => a.originalIndex),
      firstOriginalIndex: first?.originalIndex ?? null,
      lastOriginalIndex: last?.originalIndex ?? null,
      firstPoint: first?.point ?? null,
      lastPoint: last?.point ?? null,
      reachedStartProgress: progresses.length ? Math.min(...progresses) : null,
      reachedEndProgress: progresses.length ? Math.max(...progresses) : null,
    };
  });
  return { spans, sampledRoute };
}

export function decomposeContinuityAtSampleCount(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  geometryVariant: LetterShapeVariant,
  sampleCount: number,
  maxRatio: number = SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio,
): { continuityValid: boolean; worstRatio: number | null } {
  const { spans, sampledRoute } = extractLetterRouteSpansAtSampleCount(word, target, route, geometryVariant, sampleCount);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  const evaluation = evaluateContinuity(transitions, maxRatio);
  return { continuityValid: evaluation.continuityValid, worstRatio: evaluation.maxRatio };
}

export { distance2 };
