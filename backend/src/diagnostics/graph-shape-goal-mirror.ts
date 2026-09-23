/**
 * DEVELOPMENT ONLY. A faithful, parity-proven MIRROR of
 * routeGraphConstrainedShape() (graph-shape.ts) — duplicated, not
 * imported, ONLY because its search internals (beamSearch, isGoal,
 * edgeCost, explodeDirected, ...) are private (non-exported) and the goal
 * condition is baked directly into the search loop with no override hook.
 * graph-shape.ts is NOT modified anywhere in this investigation.
 *
 * Every function that IS already exported from graph-shape.ts or
 * ../diagnostics/street-fit (detectCoverageGaps, forwardRatio,
 * headingAgreement, projectOntoTarget, regionsForKind, regionsFromTargetCorners,
 * isClosedTarget, buildShapeGraph, qualitativeFailureReason) is imported
 * and reused UNCHANGED below — only the genuinely private helpers
 * (explodeDirected, analyzeDirected, startStates, prepareStartEdge,
 * trimPolylineFrom, beamSearch, betterState, edgeCost, regionSkipPenalty,
 * regionIndex, isGoal, oStateClosed, oLoopClosed, metricsFromPath,
 * emptyMetrics, classifyFailure, sampleEdge, indexOutgoing,
 * polylineFromEdges, pathIsConnected, transitionsFromEdges, coverMask,
 * progressGain, forwardRatioLoop, pathProgressSpan, wrapProgress,
 * progressBin, undirectedKey, withKey, unique, countWayRevisits, bitCount,
 * meanPoint, mean, clamp01, resultOf) are transcribed here, byte-for-byte
 * from the real implementation, with EXACTLY ONE behavioral addition: the
 * goal check is a pluggable parameter (`goalCheck`) instead of a hard-coded
 * call to the real isGoal — defaulting to an EXACT transcription of the
 * real isGoal, so with the default goalCheck this mirror must produce
 * IDENTICAL output to the real function. This is proven in the self-test
 * against real routeGraphConstrainedShape() on multiple graphs, including
 * a real corridor captured from the live pipeline.
 *
 * This module does not replace, wrap, or call the real
 * routeGraphConstrainedShape() — it is a fully independent, read-only
 * measurement tool for the diagnostic goal-variant comparison in this
 * task.
 */
import {
  headingRadians,
  polylineLength,
  projectPointOnPolyline,
  resamplePolyline,
  type Vec2,
} from '@/lib/geometry';
import { scorePolylines } from '@/lib/shape-match';
import {
  detectCoverageGaps,
  forwardRatio,
  headingAgreement,
  projectOntoTarget,
  type TargetRegion,
} from './street-fit';
import {
  GRAPH_SHAPE,
  isClosedTarget,
  regionsForKind,
  qualitativeFailureReason,
  type ShapeKind,
  type ShapeGraph,
  type GraphSegment,
  type GraphShapeMetrics,
  type GraphShapeFailure,
  type GraphShapeResult,
  type GraphShapeSearchStats,
} from '../generation/graph-shape';

// ---------------------------------------------------------------------------
// Types transcribed exactly from graph-shape.ts (private there).
// ---------------------------------------------------------------------------

export type Directed = GraphSegment & {
  reverseId: string;
  length: number;
  meanPerp: number;
  headingFit: number;
  forward: number;
  startProgress: number;
  endProgress: number;
  minProgress: number;
  maxProgress: number;
  progressSpan: number;
  forwardness: number;
  overlapMeters: number;
  followMeters: number;
  crossing: boolean;
  interior: boolean;
};

export type SearchState = {
  node: string;
  progress: number;
  cost: number;
  length: number;
  covered: number;
  edgeIds: string[];
  usedUndirected: Set<string>;
  usedInterior: boolean;
  /**
   * Generic extra bitmask, unused by REAL_ISGOAL / the default search
   * (always 0). Added for the guidance-mechanism experiments (checkpoint-
   * anchoring's "has this letter's checkpoint been hit" tracking) without
   * touching the base parity-proven fields above. Threaded through exactly
   * like `covered`: updated once per edge expansion via an optional
   * pluggable function, included in the beam's state-dedup key so states
   * with different anchor progress are never incorrectly merged.
   */
  extraMask: number;
};

/** Computes the ADDITIONAL bits (if any) a given edge contributes to the child state's extraMask, given the PARENT state (pre-transition). Defaults to always-0 (no-op), preserving exact parity with the real search when unused. */
export type ExtraMaskUpdateFn = (parentState: SearchState, edge: Directed) => number;
export const NO_EXTRA_MASK: ExtraMaskUpdateFn = () => 0;

/**
 * Computes an ADDITIONAL cost to add on top of the real, unmodified
 * edgeCost() for a given edge/transition — the shadow guidance term. Given
 * the PARENT state (pre-transition, so a checkpoint-style augmenter can
 * check "has the CURRENT letter's checkpoint been hit yet" via
 * parentState.extraMask before this edge moves progress past it). Defaults
 * to always-0, preserving exact parity with the real search when unused.
 */
export type EdgeCostAugmenterFn = (edge: Directed, currentProgress: number, parentState: SearchState) => number;
export const NO_EXTRA_COST: EdgeCostAugmenterFn = () => 0;

/** A pluggable goal check — receives everything the real isGoal receives, plus (for per-letter variants) the letter->bin mapping. Defaults to REAL_ISGOAL below (an exact transcription of graph-shape.ts's real isGoal). */
export type GoalCheckFn = (ctx: {
  state: SearchState;
  bins: number;
  kind: ShapeKind;
  loop: boolean;
  directed: Map<string, Directed>;
  letterBins: readonly LetterBinRange[];
}) => boolean;

export type LetterBinRange = { letter: string; bins: number[] };

/**
 * Optional READ-ONLY search observer (goal-threshold diagnostic). Every hook
 * only receives existing values; none can mutate state, reorder the beam,
 * or change which state is returned. With no observer the loop is
 * byte-for-byte the same computation as before (parity self-test).
 * - onLayer: called once per while-iteration with the beam about to be
 *   expanded (post-sort, post-slice — exactly the states the real search
 *   goal-checks), the expansion count so far, and the layer index.
 * - onGoal: called for every state that passes goalCheck, in visit order,
 *   with whether it became the new bestGoal (lowest cost so far).
 * - onFinish: called once after the loop, with the exact exit reason.
 */
export type SearchObserver = {
  onLayer?: (beam: readonly SearchState[], expansions: number, layer: number, directed: ReadonlyMap<string, Directed>) => void;
  onGoal?: (state: SearchState, layer: number, becameBest: boolean) => void;
  onFinish?: (info: { reason: 'beam_exhausted' | 'max_expansions'; expansions: number; layers: number; best: SearchState | null; bestGoal: SearchState | null; bestAny: SearchState | null }) => void;
  /** Beam-survival trace hooks (read-only). onStarts: the initial start states (layer-0 beam, before any expansion). */
  onStarts?: (starts: readonly SearchState[]) => void;
  /** An outgoing edge was skipped by a hard successor rule before any child was built. */
  onEdgeFiltered?: (parent: SearchState, edge: Directed, reason: 'edge_reuse' | 'undirected_reuse' | 'length_cap', layer: number) => void;
  /** A child state was built; `accepted` false means the dedupe map already held an equal-or-cheaper state for `key`. */
  onChild?: (child: SearchState, parent: SearchState, edge: Directed, stepCost: number, key: string, previousBestCost: number | null, accepted: boolean, layer: number) => void;
  /** After sorting: `sorted` is the full pushed list in rank order, the first `kept` survive into the next beam. */
  onTruncate?: (sorted: readonly SearchState[], kept: number, layer: number) => void;
};

/** Exported copy-free accessor to the mirror's coverMask (identical transcription of graph-shape.ts's private coverMask), for replaying a state's edge prefix. */
export function mirrorCoverMask(start: number, end: number, loop: boolean): number {
  return coverMask(0, start, end, loop);
}

// ---------------------------------------------------------------------------
// Exact transcription of graph-shape.ts's private helpers.
// ---------------------------------------------------------------------------

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function meanPoint(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
}
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
function bitCount(value: number): number {
  let count = 0;
  let bits = value >>> 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}
function progressBin(progress: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(clamp01(progress) * bins)));
}
function wrapProgress(progress: number): number {
  if (progress < 0) return progress + 1;
  if (progress > 1) return progress - 1;
  return progress;
}
function progressGain(from: number, to: number, loop: boolean): number {
  let delta = to - from;
  if (loop) {
    if (delta < -0.5) delta += 1;
    if (delta > 0.5) delta -= 1;
  }
  return delta;
}
function undirectedKey(edge: { id: string; reverseId: string }): string {
  const clean = (value: string) => value.replace(/#start$/, '').replace(/[><]$/, '');
  return [clean(edge.id), clean(edge.reverseId)].sort().join('~');
}
function withKey(used: Set<string>, key: string): Set<string> {
  used.add(key);
  return used;
}
function countWayRevisits(sequence: string[]): number {
  const seen = new Set<string>();
  let previous: string | null = null;
  let revisits = 0;
  for (const way of sequence) {
    if (way === previous) continue;
    if (seen.has(way)) revisits += 1;
    seen.add(way);
    previous = way;
  }
  return revisits;
}
function sampleEdge(points: Vec2[], count: number): Vec2[] {
  if (points.length <= count) return points.map((p) => ({ ...p }));
  return resamplePolyline(points, count);
}
function indexOutgoing(directed: Map<string, Directed>): Map<string, Directed[]> {
  const map = new Map<string, Directed[]>();
  for (const edge of directed.values()) {
    const list = map.get(edge.from) ?? [];
    list.push(edge);
    map.set(edge.from, list);
  }
  return map;
}
function polylineFromEdges(edgeIds: string[], directed: Map<string, Directed>): Vec2[] {
  const points: Vec2[] = [];
  for (const id of edgeIds) {
    const edge = directed.get(id);
    if (!edge) continue;
    const add = points.length === 0 ? edge.points : edge.points.slice(1);
    points.push(...add.map((p) => ({ ...p })));
  }
  return points;
}
function pathIsConnected(edgeIds: string[], directed: Map<string, Directed>): boolean {
  if (edgeIds.length === 0) return false;
  for (let index = 1; index < edgeIds.length; index += 1) {
    const previous = directed.get(edgeIds[index - 1] ?? '');
    const current = directed.get(edgeIds[index] ?? '');
    if (!previous || !current || previous.to !== current.from) return false;
  }
  return true;
}
function transitionsFromEdges(edgeIds: string[], directed: Map<string, Directed>): Vec2[] {
  const points: Vec2[] = [];
  let previousWay: string | null = null;
  for (const id of edgeIds) {
    const edge = directed.get(id);
    if (!edge) continue;
    if (previousWay != null && previousWay !== edge.wayId) {
      const joint = edge.points[0];
      if (joint) points.push({ ...joint });
    }
    previousWay = edge.wayId;
  }
  return points;
}
function coverMask(_existing: number, start: number, end: number, loop: boolean): number {
  const bins = GRAPH_SHAPE.progressBins;
  let mask = 0;
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  const mark = (progress: number) => {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(progress * bins)));
    mask |= 1 << index;
  };
  if (loop && b - a > 0.55) {
    for (let index = 0; index < bins; index += 1) {
      const progress = (index + 0.5) / bins;
      if (progress <= a || progress >= b) mask |= 1 << index;
    }
    return mask;
  }
  const steps = Math.max(2, Math.round((b - a) * bins));
  for (let index = 0; index <= steps; index += 1) {
    mark(a + ((b - a) * index) / steps);
  }
  return mask;
}
function forwardRatioLoop(progresses: readonly number[]): number | null {
  if (progresses.length < 2) return null;
  let forward = 0;
  let backward = 0;
  for (let index = 1; index < progresses.length; index += 1) {
    const gain = progressGain(progresses[index - 1] ?? 0, progresses[index] ?? 0, true);
    if (gain > 1e-6) forward += gain;
    else if (gain < -1e-6) backward += -gain;
  }
  const total = forward + backward;
  return total === 0 ? null : forward / total;
}
function pathProgressSpan(progresses: readonly number[], loop: boolean): number {
  if (progresses.length === 0) return 0;
  if (!loop) return clamp01(Math.max(...progresses) - Math.min(...progresses));
  const sorted = [...progresses].sort((a, b) => a - b);
  let maxGap = sorted[0]! + 1 - (sorted[sorted.length - 1] ?? 1);
  for (let index = 1; index < sorted.length; index += 1) {
    maxGap = Math.max(maxGap, (sorted[index] ?? 0) - (sorted[index - 1] ?? 0));
  }
  return clamp01(1 - maxGap);
}

function analyzeDirected(
  segment: GraphSegment,
  id: string,
  reverseId: string,
  points: Vec2[],
  target: readonly Vec2[],
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  centroid: Vec2,
  ringRadius: number,
): Directed {
  const length = polylineLength(points);
  const samples = sampleEdge(points, 8);
  const projections = samples.map((point) => {
    const hit = projectOntoTarget(point, target);
    return { point, ...hit };
  });
  const headings = samples.slice(1).map((point, index) => {
    const previous = samples[index];
    if (!previous) return null;
    return headingAgreement(headingRadians(previous, point), projections[index + 1]?.targetHeading ?? 0);
  });
  const headingFit = mean(headings.map((item) => item?.agreement ?? 0));
  const progresses = projections.map((item) => item.progress);
  const meanPerp = mean(projections.map((item) => item.perpendicularDistance));
  const startProgress = projections[0]?.progress ?? 0;
  const endProgress = projections[projections.length - 1]?.progress ?? startProgress;
  const forwardness = progressGain(startProgress, endProgress, loop);
  const progressSpan = Math.abs(forwardness);
  const overlapMeters = Math.min(length, progressSpan * targetLength);
  const aligned = headingFit >= 0.55 && meanPerp <= GRAPH_SHAPE.followRadiusMeters;
  const followMeters = aligned ? overlapMeters * headingFit : overlapMeters * headingFit * 0.15;
  const mid = samples[Math.floor(samples.length / 2)] ?? points[0]!;
  const distCenter = Math.hypot(mid.x - centroid.x, mid.y - centroid.y);
  const interior = loop && ringRadius > 0 && distCenter < ringRadius * 0.62 && meanPerp > 22;
  const crossing =
    (progressSpan * targetLength < GRAPH_SHAPE.minProgressSpanMeters && headingFit < 0.55) ||
    (followMeters < GRAPH_SHAPE.minFollowMeters && headingFit < 0.45);

  return {
    ...segment,
    id,
    reverseId,
    points,
    length,
    meanPerp,
    headingFit,
    forward: forwardRatio(progresses) ?? (forwardness >= 0 ? 1 : 0),
    startProgress,
    endProgress,
    minProgress: Math.min(...progresses),
    maxProgress: Math.max(...progresses),
    progressSpan,
    forwardness,
    overlapMeters,
    followMeters,
    crossing,
    interior,
  };
}

function explodeDirected(graph: ShapeGraph, target: readonly Vec2[], targetLength: number, kind: ShapeKind, loop: boolean, regions: readonly TargetRegion[]): Map<string, Directed> {
  const centroid = meanPoint(target);
  const ringRadius = mean(target.map((point) => Math.hypot(point.x - centroid.x, point.y - centroid.y)));
  const directed = new Map<string, Directed>();
  for (const segment of graph.segments) {
    const forwardId = `${segment.id}>`;
    const reverseId = `${segment.id}<`;
    const reversePoints = [...segment.points].reverse();
    directed.set(forwardId, analyzeDirected(segment, forwardId, reverseId, segment.points, target, targetLength, kind, loop, centroid, ringRadius));
    directed.set(reverseId, analyzeDirected({ ...segment, from: segment.to, to: segment.from }, reverseId, forwardId, reversePoints, target, targetLength, kind, loop, centroid, ringRadius));
  }
  void regions;
  return directed;
}

function trimPolylineFrom(points: Vec2[], hit: { point: Vec2; segmentIndex: number }): Vec2[] {
  const rest = points.slice(hit.segmentIndex + 1).map((p) => ({ ...p }));
  const trimmed = [{ ...hit.point }, ...rest];
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const second = trimmed[1];
    if (first && second && Math.hypot(second.x - first.x, second.y - first.y) < 0.5) {
      return [{ ...hit.point }, ...rest.slice(1)];
    }
  }
  return trimmed;
}

function prepareStartEdge(edge: Directed, origin: Vec2, target: readonly Vec2[], loop: boolean): Directed | null {
  if (edge.crossing && edge.followMeters < 8) return null;
  if (edge.meanPerp > GRAPH_SHAPE.corridorMeters) return null;
  const fromPoint = edge.points[0];
  if (!fromPoint) return null;
  const distFrom = Math.hypot(fromPoint.x - origin.x, fromPoint.y - origin.y);
  const hit = projectPointOnPolyline(origin, edge.points);
  const nearFrom = distFrom <= GRAPH_SHAPE.startRadiusMeters;
  const nearGeom = hit.distance <= GRAPH_SHAPE.startRadiusMeters;
  if (!nearFrom && !nearGeom) return null;
  if (nearFrom) {
    if (edge.startProgress > GRAPH_SHAPE.startProgress && !(loop && edge.startProgress > 0.9)) return null;
    return edge;
  }
  const progress = projectOntoTarget(hit.point, target).progress;
  if (progress > GRAPH_SHAPE.startProgress && !(loop && progress > 0.9)) return null;
  const trimmed = trimPolylineFrom(edge.points, hit);
  if (trimmed.length < 2 || polylineLength(trimmed) < 4) return null;
  return { ...edge, id: `${edge.id}#start`, from: snapNodeIdLocal(hit.point), points: trimmed, length: polylineLength(trimmed), startProgress: progress };
}

function snapNodeIdLocal(point: Vec2, snapMeters = GRAPH_SHAPE.nodeSnapMeters): string {
  return `${Math.round(point.x / snapMeters) * snapMeters},${Math.round(point.y / snapMeters) * snapMeters}`;
}

function regionIndex(progress: number, regions: readonly TargetRegion[]): number {
  const index = regions.findIndex((region) => progress >= region.startProgress && progress <= region.endProgress);
  return index < 0 ? regions.length - 1 : index;
}
function regionSkipPenalty(_kind: ShapeKind, from: number, to: number, regions: readonly TargetRegion[]): number {
  if (regions.length < 2) return 0;
  const a = regionIndex(from, regions);
  const b = regionIndex(to, regions);
  if (b < a) return 40;
  if (b > a + 1) return 24;
  return 0;
}

function edgeCost(edge: Directed, currentProgress: number, targetLength: number, loop: boolean, used: Set<string>, kind: ShapeKind, regions: readonly TargetRegion[]): number {
  const gain = progressGain(currentProgress, edge.endProgress, loop);
  const skip = loop ? 0 : Math.max(0, edge.minProgress - currentProgress - 0.1);
  const expected = Math.max(gain, 0.002) * targetLength;
  const detour = Math.max(0, edge.length - expected * 1.85);
  const back = Math.max(0, -gain);
  const tinySpan = edge.progressSpan * targetLength < GRAPH_SHAPE.minProgressSpanMeters ? 22 + edge.length * 0.4 : 0;
  const crossing = edge.crossing ? 18 + edge.length * 0.35 + tinySpan : tinySpan;
  const interior = edge.interior ? 80 + edge.length * 1.2 : 0;
  const repeat = used.has(undirectedKey(edge)) ? 120 + edge.length : 0;
  const reverseWalk = edge.forwardness < 0 ? 16 + Math.abs(edge.forwardness) * 80 : 0;
  const followBonus = -Math.min(edge.followMeters, 80) * 0.12;
  const overlapBonus = -Math.min(edge.overlapMeters, 120) * 0.08;
  const perp = edge.meanPerp * (0.35 + edge.length / Math.max(targetLength, 1));
  const heading = (1 - edge.headingFit) * (8 + edge.length * 0.08);
  const regionSkip = regionSkipPenalty(kind, currentProgress, edge.endProgress, regions);
  return 4 + perp + heading + back * 140 + skip * 90 + detour * 0.22 + crossing + interior + repeat + reverseWalk + regionSkip + followBonus + overlapBonus;
}

function oStateClosed(state: SearchState, directed: Map<string, Directed>): boolean {
  const first = directed.get(state.edgeIds[0] ?? '');
  const last = directed.get(state.edgeIds[state.edgeIds.length - 1] ?? '');
  if (!first || !last) return false;
  if (first.from === last.to) return true;
  const start = first.points[0];
  const end = last.points[last.points.length - 1];
  if (!start || !end) return false;
  return Math.hypot(start.x - end.x, start.y - end.y) <= GRAPH_SHAPE.nodeSnapMeters;
}
function oLoopClosed(pathPoints: readonly Vec2[], startNode: string | null, endNode: string | null): boolean {
  if (startNode != null && startNode === endNode) return true;
  const first = pathPoints[0];
  const last = pathPoints[pathPoints.length - 1];
  if (!first || !last) return false;
  return Math.hypot(first.x - last.x, first.y - last.y) <= GRAPH_SHAPE.nodeSnapMeters;
}

/** Exact transcription of the real isGoal — this is the DEFAULT goalCheck, proven in the self-test to reproduce the real function's output exactly. */
export const REAL_ISGOAL: GoalCheckFn = ({ state, bins, kind, loop, directed }) => {
  const coverage = bitCount(state.covered) / bins;
  if (coverage < GRAPH_SHAPE.goalCoverage) return false;
  if (kind === 'O') return coverage >= 0.7 && oStateClosed(state, directed);
  if (loop) return coverage >= 0.7;
  if (state.progress < GRAPH_SHAPE.goalProgress) return false;
  return true;
};

function startStates(directed: Map<string, Directed>, origin: Vec2, target: readonly Vec2[], targetLength: number, loop: boolean, kind: ShapeKind, regions: readonly TargetRegion[]): SearchState[] {
  const prepared: Directed[] = [];
  for (const edge of [...directed.values()]) {
    const startEdge = prepareStartEdge(edge, origin, target, loop);
    if (!startEdge) continue;
    if (startEdge.id !== edge.id) directed.set(startEdge.id, startEdge);
    prepared.push(startEdge);
  }
  const ranked = prepared.sort((a, b) => edgeCost(a, 0, targetLength, loop, new Set(), kind, regions) - edgeCost(b, 0, targetLength, loop, new Set(), kind, regions));
  return ranked.slice(0, 24).map((edge) => ({
    node: edge.to,
    progress: edge.endProgress,
    cost: edgeCost(edge, 0, targetLength, loop, new Set(), kind, regions),
    length: edge.length,
    covered: coverMask(0, edge.startProgress, edge.endProgress, loop),
    edgeIds: [edge.id],
    usedUndirected: new Set([undirectedKey(edge)]),
    usedInterior: edge.interior,
    extraMask: 0,
  }));
}

function betterState(candidate: SearchState, current: SearchState, bins: number): boolean {
  const coverDelta = bitCount(candidate.covered) - bitCount(current.covered);
  if (coverDelta !== 0) return coverDelta > 0;
  if (progressBin(candidate.progress, bins) !== progressBin(current.progress, bins)) {
    return progressBin(candidate.progress, bins) > progressBin(current.progress, bins);
  }
  return candidate.cost < current.cost;
}

function beamSearchMirror(
  starts: SearchState[],
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  regions: readonly TargetRegion[],
  goalCheck: GoalCheckFn,
  letterBins: readonly LetterBinRange[],
  extraCost: EdgeCostAugmenterFn = NO_EXTRA_COST,
  extraMaskUpdate: ExtraMaskUpdateFn = NO_EXTRA_MASK,
  observer: SearchObserver | null = null,
  beamWidth: number = GRAPH_SHAPE.beamPerBin * 4,
  maxExpansions: number = GRAPH_SHAPE.maxExpansions,
): { best: SearchState | null; expansions: number } {
  const bins = GRAPH_SHAPE.progressBins;
  let layer = 0;
  observer?.onStarts?.(starts);
  const bestAt = new Map<string, number>();
  let beam = starts;
  let bestGoal: SearchState | null = null;
  let bestAny: SearchState | null = starts[0] ?? null;
  let expansions = 0;

  while (beam.length > 0 && expansions < maxExpansions) {
    observer?.onLayer?.(beam, expansions, layer, directed);
    const next: SearchState[] = [];
    for (const state of beam) {
      if (!bestAny || betterState(state, bestAny, bins)) bestAny = state;
      if (observer?.onGoal) {
        // Observed path: identical decision, split only so the hook can see it.
        if (goalCheck({ state, bins, kind, loop, directed, letterBins })) {
          const becameBest = !bestGoal || state.cost < bestGoal.cost;
          if (becameBest) bestGoal = state;
          observer.onGoal(state, layer, becameBest);
        }
      } else if (goalCheck({ state, bins, kind, loop, directed, letterBins }) && (!bestGoal || state.cost < bestGoal.cost)) bestGoal = state;
      const edges = outgoing.get(state.node) ?? [];
      for (const edge of edges) {
        expansions += 1;
        if (state.edgeIds.includes(edge.id) || state.edgeIds.includes(edge.reverseId)) {
          observer?.onEdgeFiltered?.(state, edge, 'edge_reuse', layer);
          continue;
        }
        if (state.usedUndirected.has(undirectedKey(edge))) {
          observer?.onEdgeFiltered?.(state, edge, 'undirected_reuse', layer);
          continue;
        }
        if (state.length + edge.length > targetLength * GRAPH_SHAPE.maxRouteFactor) {
          observer?.onEdgeFiltered?.(state, edge, 'length_cap', layer);
          continue;
        }
        const used = new Set(state.usedUndirected);
        const stepCost = edgeCost(edge, state.progress, targetLength, loop, used, kind, regions) + extraCost(edge, state.progress, state);
        const progress = loop ? wrapProgress(edge.endProgress) : clamp01(edge.endProgress);
        const child: SearchState = {
          node: edge.to,
          progress,
          cost: state.cost + stepCost,
          length: state.length + edge.length,
          covered: state.covered | coverMask(state.covered, edge.startProgress, edge.endProgress, loop),
          edgeIds: [...state.edgeIds, edge.id],
          usedUndirected: withKey(used, undirectedKey(edge)),
          usedInterior: state.usedInterior || edge.interior,
          extraMask: state.extraMask | extraMaskUpdate(state, edge),
        };
        const key = `${child.node}:${progressBin(child.progress, bins)}:${bitCount(child.covered)}:${child.extraMask}`;
        const previous = bestAt.get(key);
        if (previous != null && previous <= child.cost) {
          observer?.onChild?.(child, state, edge, stepCost, key, previous, false, layer);
          continue;
        }
        observer?.onChild?.(child, state, edge, stepCost, key, previous ?? null, true, layer);
        bestAt.set(key, child.cost);
        next.push(child);
      }
    }
    next.sort((a, b) => a.cost - b.cost + 0.15 * (progressBin(b.progress, bins) - progressBin(a.progress, bins)));
    observer?.onTruncate?.(next, Math.min(next.length, beamWidth), layer);
    beam = next.slice(0, beamWidth);
    layer += 1;
  }
  observer?.onFinish?.({ reason: beam.length === 0 ? 'beam_exhausted' : 'max_expansions', expansions, layers: layer, best: bestGoal ?? bestAny, bestGoal, bestAny });
  return { best: bestGoal ?? bestAny, expansions };
}

function metricsFromPath(path: Vec2[], target: readonly Vec2[], waySequence: string[], connected: boolean, loop: boolean): GraphShapeMetrics {
  const targetLength = polylineLength(target);
  const routeLength = polylineLength(path);
  const uniqueWays = unique(waySequence).length;
  const repeatedWays = countWayRevisits(waySequence);
  if (path.length < 2) return emptyMetrics(targetLength, false);
  const sampled = resamplePolyline(path, 48);
  const sampledTarget = resamplePolyline(target, 48);
  const perps = sampled.map((point) => projectOntoTarget(point, target).perpendicularDistance);
  const headings = sampled.slice(1).map((point, index) => {
    const previous = sampled[index];
    if (!previous) return 0;
    const hit = projectOntoTarget(point, target);
    return headingAgreement(headingRadians(previous, point), hit.targetHeading).agreement;
  });
  const progresses = sampled.map((point) => projectOntoTarget(point, target).progress);
  const coveredProgresses = sampledTarget
    .map((point) => {
      const distance = Math.min(...sampled.map((routePoint) => Math.hypot(routePoint.x - point.x, routePoint.y - point.y)));
      return distance <= GRAPH_SHAPE.followRadiusMeters ? projectOntoTarget(point, target).progress : -1;
    })
    .filter((progress) => progress >= 0);
  const gaps = detectCoverageGaps(coveredProgresses, targetLength);
  const scored = scorePolylines(path, target);
  const fwd = (loop ? forwardRatioLoop(progresses) : forwardRatio(progresses)) ?? 0;
  const heading = mean(headings);
  const meanPerp = mean(perps);
  const progressSpan = pathProgressSpan(progresses, loop);
  const distanceRatio = targetLength > 0 ? routeLength / targetLength : 0;
  const largestGap = targetLength > 0 ? gaps.maxGapMeters / targetLength : 1;
  const graphShapeScore = clamp01(
    0.26 * gaps.coverage + 0.2 * fwd + 0.16 * heading + 0.14 * progressSpan + 0.08 * (1 - Math.min(1, meanPerp / 50)) + 0.06 * (connected ? 1 : 0) - 0.12 * (1 - fwd) - 0.08 * Math.min(1, repeatedWays / 4) - 0.06 * Math.min(1, Math.abs(distanceRatio - 1)),
  );
  return {
    routeDistanceMeters: routeLength,
    targetDistanceMeters: targetLength,
    distanceRatio,
    targetCoverage: gaps.coverage,
    forwardProgress: fwd,
    meanPerpendicularError: meanPerp,
    maxPerpendicularError: perps.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...perps),
    headingAgreement: heading,
    headingAgreementDegrees: (1 - heading) * 90,
    progressSpan,
    backtracking: 1 - fwd,
    uniqueWays,
    repeatedWays,
    largestTargetProgressGap: largestGap,
    connected,
    graphShapeScore,
    shapeScore: scored.score,
    graphPathLength: Math.max(0, path.length - 1),
    perpendicularError: meanPerp,
  };
}
function emptyMetrics(targetLength: number, connected: boolean): GraphShapeMetrics {
  return {
    routeDistanceMeters: 0,
    targetDistanceMeters: targetLength,
    distanceRatio: 0,
    targetCoverage: 0,
    forwardProgress: 0,
    meanPerpendicularError: Number.POSITIVE_INFINITY,
    maxPerpendicularError: Number.POSITIVE_INFINITY,
    headingAgreement: 0,
    headingAgreementDegrees: 90,
    progressSpan: 0,
    backtracking: 1,
    uniqueWays: 0,
    repeatedWays: 0,
    largestTargetProgressGap: 1,
    connected,
    graphShapeScore: 0,
    shapeScore: 0,
    graphPathLength: 0,
    perpendicularError: Number.POSITIVE_INFINITY,
  };
}
function classifyFailure(metrics: GraphShapeMetrics, loop: boolean, usedInterior: boolean): GraphShapeFailure | null {
  if (metrics.routeDistanceMeters <= 0) return 'search_exhausted';
  if (usedInterior && loop) return 'interior_shortcut';
  if (metrics.targetCoverage < 0.55) return 'low_coverage';
  if (metrics.progressSpan < 0.5) return 'low_coverage';
  if (metrics.headingAgreement < 0.35) return 'low_follow';
  if (metrics.backtracking > 0.45) return 'too_much_backtrack';
  if (metrics.distanceRatio > 2.2) return 'too_long';
  return null;
}

function resultOf(
  kind: ShapeKind,
  pathPoints: Vec2[],
  edgeIds: string[],
  wayIds: string[],
  metrics: GraphShapeMetrics,
  failure: GraphShapeFailure | null,
  regions: TargetRegion[],
  search: GraphShapeSearchStats,
  startNode: string | null,
  endNode: string | null,
  waySequence: string[] = wayIds,
  transitions: Vec2[] = [],
): GraphShapeResult {
  return { kind, pathPoints, edgeIds, wayIds, waySequence, metrics, failure, failureReason: qualitativeFailureReason(failure), startNode, endNode, transitions, regions, search };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function routeGraphConstrainedShapeMirror(input: {
  target: readonly Vec2[];
  graph: ShapeGraph;
  kind?: ShapeKind;
  multiLetter?: boolean;
  /** Defaults to REAL_ISGOAL (exact transcription) — pass a different GoalCheckFn to test a variant. */
  goalCheck?: GoalCheckFn;
  /** Which global progress bins belong to which letter — required only for per-letter goal variants; ignored by REAL_ISGOAL. */
  letterBins?: readonly LetterBinRange[];
  /** Optional shadow cost term added on top of the real, unmodified edgeCost() — defaults to always-0 (exact parity with production). */
  extraCost?: EdgeCostAugmenterFn;
  /** Optional extra per-state bitmask tracker (e.g. checkpoint-hit tracking) — defaults to always-0 (exact parity with production). */
  extraMaskUpdate?: ExtraMaskUpdateFn;
  /** Optional read-only search observer — never changes the search (see SearchObserver). */
  observer?: SearchObserver;
  /** DIAGNOSTIC COUNTERFACTUAL ONLY: beam width override. Defaults to production (GRAPH_SHAPE.beamPerBin * 4). */
  beamWidth?: number;
  /** DIAGNOSTIC COUNTERFACTUAL ONLY: expansion-cap override. Defaults to production (GRAPH_SHAPE.maxExpansions). */
  maxExpansions?: number;
}): GraphShapeResult {
  const kind = input.kind ?? 'generic';
  const goalCheck = input.goalCheck ?? REAL_ISGOAL;
  const letterBins = input.letterBins ?? [];
  const extraCost = input.extraCost ?? NO_EXTRA_COST;
  const extraMaskUpdate = input.extraMaskUpdate ?? NO_EXTRA_MASK;
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const regions = input.multiLetter && kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, target);
  const emptySearch = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount: 0, statesExplored: 0 };

  if (target.length < 2 || targetLength <= 0) return resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_graph', regions, emptySearch, null, null);
  if (input.graph.segments.length === 0) return resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_graph', regions, emptySearch, null, null);

  const loop = kind === 'O' || isClosedTarget(target);
  const directed = explodeDirected(input.graph, target, targetLength, kind, loop, regions);
  const candidateEdgeCount = unique([...directed.values()].filter((edge) => !edge.crossing).map((edge) => edge.id.replace(/[><]$/, ''))).length;
  const searchBase = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount, statesExplored: 0 };
  const outgoing = indexOutgoing(directed);
  const origin = target[0] ?? { x: 0, y: 0 };
  const starts = startStates(directed, origin, target, targetLength, loop, kind, regions);
  if (starts.length === 0) return resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_start_node', regions, searchBase, null, null);

  const { best, expansions } = beamSearchMirror(starts, directed, outgoing, targetLength, kind, loop, regions, goalCheck, letterBins, extraCost, extraMaskUpdate, input.observer ?? null, input.beamWidth ?? GRAPH_SHAPE.beamPerBin * 4, input.maxExpansions ?? GRAPH_SHAPE.maxExpansions);
  const search = { ...searchBase, statesExplored: expansions };
  if (!best) return resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'search_exhausted', regions, search, null, null);

  return mirrorResultForState(best, directed, target, kind, loop, regions, search);
}

/**
 * The exact post-search tail of routeGraphConstrainedShapeMirror (path,
 * metrics, failure classification), factored out UNCHANGED so a diagnostic
 * can evaluate ANY already-found search state exactly as the search would
 * have evaluated it had that state been the one returned. The mirror's own
 * entry point calls this for its returned state (parity self-test).
 */
export function mirrorResultForState(best: SearchState, directed: ReadonlyMap<string, Directed>, target: readonly Vec2[], kind: ShapeKind, loop: boolean, regions: TargetRegion[], search: GraphShapeSearchStats): GraphShapeResult {
  const dir = directed as Map<string, Directed>;
  const pathPoints = polylineFromEdges(best.edgeIds, dir);
  const waySequence = best.edgeIds.map((id) => dir.get(id)?.wayId).filter((id): id is string => Boolean(id));
  const wayIds = unique(waySequence);
  const connected = pathIsConnected(best.edgeIds, dir);
  const computed = metricsFromPath(pathPoints, target, waySequence, connected, loop);
  const startNode = dir.get(best.edgeIds[0] ?? '')?.from ?? null;
  const endNode = dir.get(best.edgeIds[best.edgeIds.length - 1] ?? '')?.to ?? null;
  let failure = classifyFailure(computed, loop, best.usedInterior);
  if (kind === 'O' && !oLoopClosed(pathPoints, startNode, endNode)) failure = 'low_coverage';
  return resultOf(kind, pathPoints, best.edgeIds, wayIds, computed, failure, regions, search, startNode, endNode, waySequence, transitionsFromEdges(best.edgeIds, dir));
}

// ---------------------------------------------------------------------------
// Bin-to-letter mapping helper (Step 2's answer: derivable cheaply from
// existing state, since `covered` is already a bitmask over
// GRAPH_SHAPE.progressBins global progress bins — this just maps each bin
// index to whichever letter's projected progress range contains it).
// ---------------------------------------------------------------------------

export function computeLetterBinRanges(boundaries: readonly { letter: string; projectedStartProgress: number; projectedEndProgress: number }[], bins: number = GRAPH_SHAPE.progressBins): LetterBinRange[] {
  return boundaries.map((boundary) => {
    const binIndices: number[] = [];
    for (let index = 0; index < bins; index += 1) {
      const progress = (index + 0.5) / bins;
      if (progress >= boundary.projectedStartProgress && progress <= boundary.projectedEndProgress) {
        binIndices.push(index);
      }
    }
    return { letter: boundary.letter, bins: binIndices };
  });
}
