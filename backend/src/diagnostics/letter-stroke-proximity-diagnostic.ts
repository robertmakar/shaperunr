/**
 * DEVELOPMENT ONLY. Mechanism A — soft letter-stroke proximity guidance,
 * a diagnostic-only shadow cost term for graph-shape-goal-mirror.ts's beam
 * search. Never wired into graph-shape.ts.
 *
 * Step 3's distance definition: for an edge, sample its geometry (the SAME
 * 8-point sampleEdge() pattern graph-shape.ts's own analyzeDirected()
 * already uses for headingFit/meanPerp — reused conceptually, not
 * imported since sampleEdge is private, but at the SAME sample count) and
 * take the MINIMUM of distanceToPolyline(samplePoint, activeLetterPolyline)
 * across all samples — never just the nearest endpoint, so a long edge
 * that only brushes the stroke at one end is not treated as fully close.
 *
 * Step 6's active-letter definition: uses the real, unmodified
 * letterBoundariesFromWordShape() progress windows. When a progress value
 * falls strictly inside exactly one letter's window, that letter is
 * active. When it falls in a connector/gap between two letters (or before
 * the first / after the last), the NEAREST letter by progress distance is
 * used (ties broken toward the earlier letter) — never "always the next
 * letter", which would just recreate the artificial-connector-driven
 * misattribution problem an earlier task in this investigation already
 * found and fixed for a different diagnostic. This is documented here,
 * not silently assumed.
 *
 * The active letter's own PLACED polyline (not the abstract word-shape
 * geometry) is obtained by slicing the real, already-projected target
 * polyline by that letter's progress window — the same slicing pattern
 * (resample then filter by progress) already used and validated in
 * inter-letter-continuity-diagnostic.ts's sliceTargetByProgressLocal, so
 * this reuses an established pattern rather than inventing a new one.
 */
import { distanceToPolyline, resamplePolyline, type Vec2 } from '@/lib/geometry';
import type { LetterBoundary } from './multi-letter-trace';
import type { Directed, EdgeCostAugmenterFn } from './graph-shape-goal-mirror';

const EDGE_SAMPLE_COUNT = 8;

function sampleEdgePoints(points: readonly Vec2[], count: number): Vec2[] {
  if (points.length <= count) return points.map((p) => ({ ...p }));
  return resamplePolyline(points, count);
}

/** Step 6: nearest-letter-by-progress-distance active-letter resolution, explicit connector handling. */
export function resolveActiveLetter(progress: number, boundaries: readonly LetterBoundary[]): LetterBoundary | null {
  if (boundaries.length === 0) return null;
  let best: LetterBoundary | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const boundary of boundaries) {
    const inside = progress >= boundary.projectedStartProgress && progress <= boundary.projectedEndProgress;
    const distance = inside ? 0 : Math.min(Math.abs(progress - boundary.projectedStartProgress), Math.abs(progress - boundary.projectedEndProgress));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = boundary;
    }
  }
  return best;
}

/** Slices the REAL, placed target polyline to one letter's own progress window — the letter's actual stroke geometry in the SAME local-meters frame as the corridor graph, not the abstract word-shape geometry. */
export function sliceLetterStrokePolyline(target: readonly Vec2[], boundary: LetterBoundary, resampleCount = 64): Vec2[] {
  const samples = resamplePolyline(target, resampleCount);
  const sliced = samples.filter((_, index) => {
    const progress = samples.length === 1 ? 0 : index / (samples.length - 1);
    return progress >= boundary.projectedStartProgress - 0.01 && progress <= boundary.projectedEndProgress + 0.01;
  });
  return sliced.length >= 2 ? sliced : samples.slice(0, 2);
}

/** Step 3: raw stroke distance for one edge against one letter's placed stroke polyline — the minimum over sampled edge points, never just an endpoint. */
export function computeEdgeStrokeDistance(edge: Directed, letterStroke: readonly Vec2[]): number {
  if (letterStroke.length < 2) return Number.POSITIVE_INFINITY;
  const samples = sampleEdgePoints(edge.points, EDGE_SAMPLE_COUNT);
  let min = Number.POSITIVE_INFINITY;
  for (const point of samples) {
    const distance = distanceToPolyline(point, letterStroke);
    if (distance < min) min = distance;
  }
  return min;
}

export type StrokeProximityConfig = { lambda: number; distanceScaleMeters: number };

/**
 * Builds the EdgeCostAugmenterFn for Mechanism A. Step 4/5: the penalty is
 * a SOFT, continuously-normalized term (never a binary pass/fail), added
 * on top of the real edgeCost — never replacing it. `letterStrokes` is
 * precomputed once per search (one slice per letter) so the per-edge cost
 * is cheap: one active-letter lookup + one polyline-distance sample loop.
 */
export function makeStrokeProximityAugmenter(boundaries: readonly LetterBoundary[], target: readonly Vec2[], config: StrokeProximityConfig): { augmenter: EdgeCostAugmenterFn; letterStrokes: Map<string, Vec2[]> } {
  const letterStrokes = new Map<string, Vec2[]>();
  boundaries.forEach((boundary, index) => {
    letterStrokes.set(`${boundary.letter}#${index}`, sliceLetterStrokePolyline(target, boundary));
  });
  const augmenter: EdgeCostAugmenterFn = (edge, currentProgress) => {
    if (boundaries.length === 0) return 0;
    const activeIndex = boundaries.findIndex((b) => b === resolveActiveLetter(edge.endProgress ?? currentProgress, boundaries));
    if (activeIndex < 0) return 0;
    const boundary = boundaries[activeIndex]!;
    const stroke = letterStrokes.get(`${boundary.letter}#${activeIndex}`) ?? [];
    const strokeDistanceMeters = computeEdgeStrokeDistance(edge, stroke);
    const strokePenalty = Number.isFinite(strokeDistanceMeters) ? Math.min(1, Math.max(0, strokeDistanceMeters / config.distanceScaleMeters)) : 1;
    return config.lambda * strokePenalty;
  };
  return { augmenter, letterStrokes };
}

/** Diagnostic-only: computes the raw strokeDistanceMeters for every letter against a single point (an edge sample, a route sample, etc.) — used by the run script to build the Step 7 distribution report, independent of any cost/lambda. */
export function rawStrokeDistanceForPoint(point: Vec2, boundaries: readonly LetterBoundary[], letterStrokes: ReadonlyMap<string, Vec2[]>, progress: number): number {
  const active = resolveActiveLetter(progress, boundaries);
  if (!active) return Number.POSITIVE_INFINITY;
  const index = boundaries.indexOf(active);
  const stroke = letterStrokes.get(`${active.letter}#${index}`) ?? [];
  return stroke.length >= 2 ? distanceToPolyline(point, stroke) : Number.POSITIVE_INFINITY;
}
