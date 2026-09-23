/**
 * DEVELOPMENT ONLY. Instrumented, isolated mirror of graph-shape.ts's
 * private beam search — never called from the live route generation path,
 * never modifies graph-shape.ts.
 *
 * Every private helper below (explodeDirected, analyzeDirected,
 * startStates, prepareStartEdge, trimPolylineFrom, beamSearch, betterState,
 * edgeCost, regionSkipPenalty, regionIndex, isGoal, oStateClosed,
 * oLoopClosed, metricsFromPath, classifyFailure, sampleEdge,
 * indexOutgoing, polylineFromEdges, pathIsConnected, transitionsFromEdges,
 * coverMask, progressGain, forwardRatioLoop, pathProgressSpan,
 * wrapProgress, progressBin, undirectedKey, withKey, unique,
 * countWayRevisits, bitCount, meanPoint, mean, clamp01, resultOf,
 * emptyMetrics) is transcribed VERBATIM from graph-shape.ts's current
 * source (read directly for this task, not from memory/summary) — no
 * formula, constant, weight, or control-flow branch is altered anywhere.
 * The ONLY additions are: (1) recording arrays populated at points that
 * never affect what gets computed or returned, and (2) letter-corridor
 * bookkeeping (Section 4/9/10 of the task) computed from data the search
 * already touches, never fed back into the search itself.
 *
 * Wherever graph-shape.ts already EXPORTS something (GRAPH_SHAPE,
 * ShapeKind, GraphSegment, ShapeGraph, snapNodeId, isClosedTarget,
 * regionsForKind, qualitativeFailureReason, and every GraphShapeResult-
 * family type), this file imports and reuses it directly rather than
 * re-declaring it — reducing the mirror surface and the risk of drift.
 *
 * Faithfulness is proven, not assumed: the self-test calls both this
 * mirror's traceGraphConstrainedShape() and the REAL, unmodified
 * routeGraphConstrainedShape() on identical inputs and requires the
 * returned GraphShapeResult (pathPoints, edgeIds, metrics, failure) to be
 * byte-identical.
 *
 * UPDATE (fine-coverage production experiment, tested and REVERTED): a
 * fine-grained physical-ink coverage reward was added to graph-shape.ts's
 * real edgeCost as a production experiment, benchmarked against this same
 * mirror, found to change route selection in only 3/79 real candidates
 * with no meaningful improvement to downstream coverage/shapeScore/
 * wordTraversal, and reverted (graph-shape.ts is back to its pre-
 * experiment state — it no longer exports a FINE_COVERAGE constant).
 * This mirror keeps the SAME addition as a pure, self-contained SHADOW
 * capability (its own local FINE_COVERAGE constant below, not imported
 * from production) so the experiment can be cheaply re-run at different
 * parameters without touching production again — gated behind
 * `fineCoverageEnabled` in TraceOptions, defaulting to FALSE to match
 * production's current (reverted) behavior.
 */
import {
  distanceToPolyline,
  headingRadians,
  polylineLength,
  projectPointOnPolyline,
  resamplePolyline,
  shortestAngleDelta,
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
  qualitativeFailureReason,
  regionsForKind,
  snapNodeId,
  type GraphSegment,
  type GraphShapeFailure,
  type GraphShapeMetrics,
  type GraphShapeResult,
  type GraphShapeSearchStats,
  type ShapeGraph,
  type ShapeKind,
} from '../generation/graph-shape';
import { coverageThresholdMeters } from '../generation/target-identity';

/**
 * Shadow-only fine-grained physical-ink coverage constant — see the file
 * header's "fine-coverage production experiment" note. NOT imported from
 * graph-shape.ts (which no longer has this after the revert); kept local
 * so this diagnostic capability survives independently of production.
 */
export const FINE_COVERAGE = { bins: 128, rewardPerBin: 0.5 } as const;

// ---------------------------------------------------------------------------
// Verbatim mirror of graph-shape.ts's private types/helpers (see file header)
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
  fineCoverageMask: bigint;
};

export type SearchState = {
  node: string;
  progress: number;
  cost: number;
  length: number;
  covered: number;
  fineCoverage: bigint;
  edgeIds: string[];
  usedUndirected: Set<string>;
  usedInterior: boolean;
};

export function fineCoverageMaskFor(projections: ReadonlyArray<{ progress: number; perpendicularDistance: number }>, coverageThreshold: number): bigint {
  let mask = 0n;
  for (const item of projections) {
    if (item.perpendicularDistance > coverageThreshold) continue;
    const index = Math.min(FINE_COVERAGE.bins - 1, Math.max(0, Math.floor(item.progress * FINE_COVERAGE.bins)));
    mask |= 1n << BigInt(index);
  }
  return mask;
}

export function bigintPopcount(value: bigint): number {
  let count = 0;
  let bits = value;
  while (bits > 0n) {
    count += Number(bits & 1n);
    bits >>= 1n;
  }
  return count;
}

export function fineCoverageReward(parentMask: bigint, edgeMask: bigint, enabled: boolean): number {
  if (!enabled) return 0;
  return FINE_COVERAGE.rewardPerBin * bigintPopcount(edgeMask & ~parentMask);
}

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function meanPoint(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

export function bitCount(value: number): number {
  let count = 0;
  let bits = value >>> 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function countWayRevisits(sequence: string[]): number {
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

export function withKey(used: Set<string>, key: string): Set<string> {
  used.add(key);
  return used;
}

export function undirectedKey(edge: { id: string; reverseId: string }): string {
  const clean = (value: string) => value.replace(/#start$/, '').replace(/[><]$/, '');
  return [clean(edge.id), clean(edge.reverseId)].sort().join('~');
}

export function progressBin(progress: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(clamp01(progress) * bins)));
}

export function wrapProgress(progress: number): number {
  if (progress < 0) return progress + 1;
  if (progress > 1) return progress - 1;
  return progress;
}

export function pathProgressSpan(progresses: readonly number[], loop: boolean): number {
  if (progresses.length === 0) return 0;
  if (!loop) return clamp01(Math.max(...progresses) - Math.min(...progresses));
  const sorted = [...progresses].sort((a, b) => a - b);
  let maxGap = sorted[0]! + 1 - (sorted[sorted.length - 1] ?? 1);
  for (let index = 1; index < sorted.length; index += 1) {
    maxGap = Math.max(maxGap, (sorted[index] ?? 0) - (sorted[index - 1] ?? 0));
  }
  return clamp01(1 - maxGap);
}

export function forwardRatioLoop(progresses: readonly number[]): number | null {
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

export function progressGain(from: number, to: number, loop: boolean): number {
  let delta = to - from;
  if (loop) {
    if (delta < -0.5) delta += 1;
    if (delta > 0.5) delta -= 1;
  }
  return delta;
}

export function coverMask(_existing: number, start: number, end: number, loop: boolean): number {
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

export function sampleEdge(points: Vec2[], count: number): Vec2[] {
  if (points.length <= count) return points.map((point) => ({ ...point }));
  return resamplePolyline(points, count);
}

export function indexOutgoing(directed: Map<string, Directed>): Map<string, Directed[]> {
  const map = new Map<string, Directed[]>();
  for (const edge of directed.values()) {
    const list = map.get(edge.from) ?? [];
    list.push(edge);
    map.set(edge.from, list);
  }
  return map;
}

export function polylineFromEdges(edgeIds: string[], directed: Map<string, Directed>): Vec2[] {
  const points: Vec2[] = [];
  for (const id of edgeIds) {
    const edge = directed.get(id);
    if (!edge) continue;
    const add = points.length === 0 ? edge.points : edge.points.slice(1);
    points.push(...add.map((point) => ({ ...point })));
  }
  return points;
}

export function pathIsConnected(edgeIds: string[], directed: Map<string, Directed>): boolean {
  if (edgeIds.length === 0) return false;
  for (let index = 1; index < edgeIds.length; index += 1) {
    const previous = directed.get(edgeIds[index - 1] ?? '');
    const current = directed.get(edgeIds[index] ?? '');
    if (!previous || !current || previous.to !== current.from) return false;
  }
  return true;
}

export function transitionsFromEdges(edgeIds: string[], directed: Map<string, Directed>): Vec2[] {
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

export function trimPolylineFrom(points: Vec2[], hit: { point: Vec2; segmentIndex: number }): Vec2[] {
  const rest = points.slice(hit.segmentIndex + 1).map((point) => ({ ...point }));
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

export function explodeDirected(
  graph: ShapeGraph,
  target: readonly Vec2[],
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  regions: readonly TargetRegion[],
  coverageThreshold: number,
): Map<string, Directed> {
  const centroid = meanPoint(target);
  const ringRadius = mean(target.map((point) => Math.hypot(point.x - centroid.x, point.y - centroid.y)));
  const directed = new Map<string, Directed>();
  for (const segment of graph.segments) {
    const forwardId = `${segment.id}>`;
    const reverseId = `${segment.id}<`;
    const reversePoints = [...segment.points].reverse();
    directed.set(forwardId, analyzeDirected(segment, forwardId, reverseId, segment.points, target, targetLength, kind, loop, centroid, ringRadius, coverageThreshold));
    directed.set(
      reverseId,
      analyzeDirected({ ...segment, from: segment.to, to: segment.from }, reverseId, forwardId, reversePoints, target, targetLength, kind, loop, centroid, ringRadius, coverageThreshold),
    );
  }
  void regions;
  return directed;
}

export function analyzeDirected(
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
  coverageThreshold: number,
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
    fineCoverageMask: fineCoverageMaskFor(projections, coverageThreshold),
  };
}

export function prepareStartEdge(edge: Directed, origin: Vec2, target: readonly Vec2[], loop: boolean): Directed | null {
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
  return { ...edge, id: `${edge.id}#start`, from: snapNodeId(hit.point), points: trimmed, length: polylineLength(trimmed), startProgress: progress };
}

export function regionIndex(progress: number, regions: readonly TargetRegion[]): number {
  const index = regions.findIndex((region) => progress >= region.startProgress && progress <= region.endProgress);
  return index < 0 ? regions.length - 1 : index;
}

export function regionSkipPenalty(_kind: ShapeKind, from: number, to: number, regions: readonly TargetRegion[]): number {
  if (regions.length < 2) return 0;
  const a = regionIndex(from, regions);
  const b = regionIndex(to, regions);
  if (b < a) return 40;
  if (b > a + 1) return 24;
  return 0;
}

export function edgeCost(edge: Directed, currentProgress: number, targetLength: number, loop: boolean, used: Set<string>, kind: ShapeKind, regions: readonly TargetRegion[]): number {
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

export function startStates(directed: Map<string, Directed>, origin: Vec2, target: readonly Vec2[], targetLength: number, loop: boolean, kind: ShapeKind, regions: readonly TargetRegion[], fineCoverageEnabled: boolean): SearchState[] {
  const prepared: Directed[] = [];
  for (const edge of [...directed.values()]) {
    const startEdge = prepareStartEdge(edge, origin, target, loop);
    if (!startEdge) continue;
    if (startEdge.id !== edge.id) directed.set(startEdge.id, startEdge);
    prepared.push(startEdge);
  }
  const startCost = (edge: Directed) => edgeCost(edge, 0, targetLength, loop, new Set(), kind, regions) - fineCoverageReward(0n, edge.fineCoverageMask, fineCoverageEnabled);
  const ranked = prepared.sort((a, b) => startCost(a) - startCost(b));
  return ranked.slice(0, 24).map((edge) => ({
    node: edge.to,
    progress: edge.endProgress,
    cost: startCost(edge),
    length: edge.length,
    covered: coverMask(0, edge.startProgress, edge.endProgress, loop),
    fineCoverage: edge.fineCoverageMask,
    edgeIds: [edge.id],
    usedUndirected: new Set([undirectedKey(edge)]),
    usedInterior: edge.interior,
  }));
}

export function betterState(candidate: SearchState, current: SearchState, bins: number): boolean {
  const coverDelta = bitCount(candidate.covered) - bitCount(current.covered);
  if (coverDelta !== 0) return coverDelta > 0;
  if (progressBin(candidate.progress, bins) !== progressBin(current.progress, bins)) {
    return progressBin(candidate.progress, bins) > progressBin(current.progress, bins);
  }
  return candidate.cost < current.cost;
}

export function isGoal(state: SearchState, bins: number, kind: ShapeKind, loop: boolean, directed: Map<string, Directed>): boolean {
  const coverage = bitCount(state.covered) / bins;
  if (coverage < GRAPH_SHAPE.goalCoverage) return false;
  if (kind === 'O') return coverage >= 0.7 && oStateClosed(state, directed);
  if (loop) return coverage >= 0.7;
  if (state.progress < GRAPH_SHAPE.goalProgress) return false;
  return true;
}

export function oStateClosed(state: SearchState, directed: Map<string, Directed>): boolean {
  const first = directed.get(state.edgeIds[0] ?? '');
  const last = directed.get(state.edgeIds[state.edgeIds.length - 1] ?? '');
  if (!first || !last) return false;
  if (first.from === last.to) return true;
  const start = first.points[0];
  const end = last.points[last.points.length - 1];
  if (!start || !end) return false;
  return Math.hypot(start.x - end.x, start.y - end.y) <= GRAPH_SHAPE.nodeSnapMeters;
}

export function oLoopClosed(pathPoints: readonly Vec2[], startNode: string | null, endNode: string | null): boolean {
  if (startNode != null && startNode === endNode) return true;
  const first = pathPoints[0];
  const last = pathPoints[pathPoints.length - 1];
  if (!first || !last) return false;
  return Math.hypot(first.x - last.x, first.y - last.y) <= GRAPH_SHAPE.nodeSnapMeters;
}

export function metricsFromPath(path: Vec2[], target: readonly Vec2[], waySequence: string[], connected: boolean, loop: boolean): GraphShapeMetrics {
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

export function emptyMetrics(targetLength: number, connected: boolean): GraphShapeMetrics {
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

export function classifyFailure(metrics: GraphShapeMetrics, loop: boolean, usedInterior: boolean): GraphShapeFailure | null {
  if (metrics.routeDistanceMeters <= 0) return 'search_exhausted';
  if (usedInterior && loop) return 'interior_shortcut';
  if (metrics.targetCoverage < 0.55) return 'low_coverage';
  if (metrics.progressSpan < 0.5) return 'low_coverage';
  if (metrics.headingAgreement < 0.35) return 'low_follow';
  if (metrics.backtracking > 0.45) return 'too_much_backtrack';
  if (metrics.distanceRatio > 2.2) return 'too_long';
  return null;
}

export function resultOf(
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
  return {
    kind,
    pathPoints,
    edgeIds,
    wayIds,
    waySequence,
    metrics,
    failure,
    failureReason: qualitativeFailureReason(failure),
    startNode,
    endNode,
    transitions,
    regions,
    search,
  };
}

// ---------------------------------------------------------------------------
// Instrumentation additions (never alter the mirrored control flow above)
// ---------------------------------------------------------------------------

export type BeamExpansionRecord = {
  expansion: number;
  depth: number;
  node: string;
  previousNode: string;
  edgeId: string;
  wayId: string;
  targetProgress: number;
  routeDistanceMeters: number;
  accumulatedCost: number;
  edgeCostValue: number;
  headingAgreement: number;
  perpendicularDistanceMeters: number;
  followMeters: number;
  overlapMeters: number;
  coverageMask: number;
  coverageBinCount: number;
  coverageBinsNew: number;
  /** = FINE_COVERAGE.bins-resolution popcount of the accumulated fine-coverage bitmask after this edge — always computed, regardless of fineCoverageEnabled (so OLD-vs-NEW runs can be diffed on this metric even when the reward itself is disabled). */
  fineCoverageBinCount: number;
  fineCoverageBinsNew: number;
  fineCoverageRewardApplied: number;
  usedEdgeCount: number;
  /** Discarded immediately by the bestAt dedup check — never entered the `next` candidate list at all. */
  dedupPruned: boolean;
  /** Index within `next` after the real cost+progress sort, before the beamPerBin*4 truncation — null if dedupPruned. */
  beamRankAtInsertion: number | null;
  /** Whether this state survived the same `next.slice(0, beamPerBin*4)` truncation production applies. */
  survivedBeamCut: boolean;
  /** Position of this state (the edge's endpoint) — used for letter-corridor distance checks. */
  position: Vec2;
};

export type BeamTrace = {
  expansions: BeamExpansionRecord[];
  totalExpansions: number;
  hitExpansionCap: boolean;
  finalEdgeIds: string[];
  finalCost: number | null;
  reachedGoal: boolean;
  /** Popcount of the selected route's final fine-coverage bitmask — tracked in this diagnostic's own BeamTrace (not GraphShapeSearchStats, which no longer carries this field after the production experiment's revert). */
  finalFineCoverageBinsCovered: number;
  finalFineCoverageTotalBins: number;
};

/**
 * Verbatim mirror of graph-shape.ts's private beamSearch(), with
 * additive-only recording. Every pruning/selection decision (dedup check,
 * sort comparator, slice width) is copied exactly from the real function.
 */
export function beamSearchTraced(
  starts: SearchState[],
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  regions: readonly TargetRegion[],
  recordExpansions: boolean,
  fineCoverageEnabled: boolean,
): { best: SearchState | null; expansions: number; trace: BeamExpansionRecord[] } {
  const bins = GRAPH_SHAPE.progressBins;
  const bestAt = new Map<string, number>();
  let beam = starts;
  let bestGoal: SearchState | null = null;
  let bestAny: SearchState | null = starts[0] ?? null;
  let expansions = 0;
  let depth = 0;
  const trace: BeamExpansionRecord[] = [];

  while (beam.length > 0 && expansions < GRAPH_SHAPE.maxExpansions) {
    depth += 1;
    const next: SearchState[] = [];
    const pendingRecords: Array<{ record: Omit<BeamExpansionRecord, 'beamRankAtInsertion' | 'survivedBeamCut'>; child: SearchState }> = [];

    for (const state of beam) {
      if (!bestAny || betterState(state, bestAny, bins)) bestAny = state;
      if (isGoal(state, bins, kind, loop, directed) && (!bestGoal || state.cost < bestGoal.cost)) bestGoal = state;

      const edges = outgoing.get(state.node) ?? [];
      for (const edge of edges) {
        expansions += 1;
        if (state.edgeIds.includes(edge.id) || state.edgeIds.includes(edge.reverseId)) continue;
        if (state.usedUndirected.has(undirectedKey(edge))) continue;
        if (state.length + edge.length > targetLength * GRAPH_SHAPE.maxRouteFactor) continue;

        const used = new Set(state.usedUndirected);
        const stepCost = edgeCost(edge, state.progress, targetLength, loop, used, kind, regions) - fineCoverageReward(state.fineCoverage, edge.fineCoverageMask, fineCoverageEnabled);
        const progress = loop ? wrapProgress(edge.endProgress) : clamp01(edge.endProgress);
        const child: SearchState = {
          node: edge.to,
          progress,
          cost: state.cost + stepCost,
          length: state.length + edge.length,
          covered: state.covered | coverMask(state.covered, edge.startProgress, edge.endProgress, loop),
          fineCoverage: state.fineCoverage | edge.fineCoverageMask,
          edgeIds: [...state.edgeIds, edge.id],
          usedUndirected: withKey(used, undirectedKey(edge)),
          usedInterior: state.usedInterior || edge.interior,
        };
        const key = `${child.node}:${progressBin(child.progress, bins)}:${bitCount(child.covered)}`;
        const previous = bestAt.get(key);
        const dedupPruned = previous != null && previous <= child.cost;

        if (recordExpansions) {
          const newBins = bitCount(child.covered & ~state.covered);
          const fineNewBins = bigintPopcount(edge.fineCoverageMask & ~state.fineCoverage);
          pendingRecords.push({
            record: {
              expansion: expansions,
              depth,
              node: child.node,
              previousNode: state.node,
              edgeId: edge.id,
              wayId: edge.wayId,
              targetProgress: child.progress,
              routeDistanceMeters: child.length,
              accumulatedCost: child.cost,
              edgeCostValue: stepCost,
              headingAgreement: edge.headingFit,
              perpendicularDistanceMeters: edge.meanPerp,
              followMeters: edge.followMeters,
              overlapMeters: edge.overlapMeters,
              coverageMask: child.covered,
              coverageBinCount: bitCount(child.covered),
              coverageBinsNew: newBins,
              fineCoverageBinCount: bigintPopcount(child.fineCoverage),
              fineCoverageBinsNew: fineNewBins,
              fineCoverageRewardApplied: fineCoverageEnabled ? FINE_COVERAGE.rewardPerBin * fineNewBins : 0,
              usedEdgeCount: child.usedUndirected.size,
              dedupPruned,
              position: edge.points[edge.points.length - 1] ?? { x: 0, y: 0 },
            },
            child,
          });
        }

        if (dedupPruned) continue;
        bestAt.set(key, child.cost);
        next.push(child);
      }
    }

    next.sort((a, b) => a.cost - b.cost + 0.15 * (progressBin(b.progress, bins) - progressBin(a.progress, bins)));
    const cutIndex = GRAPH_SHAPE.beamPerBin * 4;
    beam = next.slice(0, cutIndex);

    if (recordExpansions) {
      // Rank kept (non-dedup-pruned) children by their position in the SAME sorted `next` array production computed.
      const rankOf = new Map<SearchState, number>();
      next.forEach((state, index) => rankOf.set(state, index));
      for (const pending of pendingRecords) {
        const rank = pending.record.dedupPruned ? null : (rankOf.get(pending.child) ?? null);
        trace.push({
          ...pending.record,
          beamRankAtInsertion: rank,
          survivedBeamCut: rank != null && rank < cutIndex,
        });
      }
    }
  }

  return { best: bestGoal ?? bestAny, expansions, trace };
}

export type TraceOptions = {
  /** Record every expansion's detail. Off by default for aggregate sweeps over many candidates (Section 2's "do not log millions of states blindly"); turn on only for the small set of forensic candidates. */
  recordExpansions?: boolean;
  /** Defaults to true, matching the REAL production function's current (post-experiment) unconditional behavior. Pass false to reproduce the PRE-experiment algorithm for OLD-vs-NEW comparison — the fine-coverage mask is still computed and tracked either way (so trace.expansions.fineCoverageBinCount is always meaningful), only whether it's SUBTRACTED from cost is gated. */
  fineCoverageEnabled?: boolean;
};

/**
 * Verbatim mirror of graph-shape.ts's exported routeGraphConstrainedShape(),
 * returning the SAME GraphShapeResult (proven byte-identical to the real
 * function in the self-test, with fineCoverageEnabled at its default
 * false, matching production's current — reverted — behavior) plus a
 * BeamTrace.
 */
export function traceGraphConstrainedShape(
  input: { target: readonly Vec2[]; graph: ShapeGraph; kind?: ShapeKind; multiLetter?: boolean },
  options: TraceOptions = {},
): { result: GraphShapeResult; trace: BeamTrace } {
  const fineCoverageEnabled = options.fineCoverageEnabled ?? false;
  const kind = input.kind ?? 'generic';
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const regions = input.multiLetter && kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, target);
  const emptySearch = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount: 0, statesExplored: 0 };
  const emptyTrace: BeamTrace = { expansions: [], totalExpansions: 0, hitExpansionCap: false, finalEdgeIds: [], finalCost: null, reachedGoal: false, finalFineCoverageBinsCovered: 0, finalFineCoverageTotalBins: FINE_COVERAGE.bins };

  if (target.length < 2 || targetLength <= 0 || input.graph.segments.length === 0) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_graph', regions, emptySearch, null, null), trace: emptyTrace };
  }

  const loop = kind === 'O' || isClosedTarget(target);
  const coverageThreshold = coverageThresholdMeters(target);
  const directed = explodeDirected(input.graph, target, targetLength, kind, loop, regions, coverageThreshold);
  const candidateEdgeCount = unique([...directed.values()].filter((edge) => !edge.crossing).map((edge) => edge.id.replace(/[><]$/, ''))).length;
  const searchBase = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount, statesExplored: 0 };
  const outgoing = indexOutgoing(directed);
  const origin = target[0] ?? { x: 0, y: 0 };
  const starts = startStates(directed, origin, target, targetLength, loop, kind, regions, fineCoverageEnabled);
  if (starts.length === 0) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_start_node', regions, searchBase, null, null), trace: emptyTrace };
  }

  const { best, expansions, trace } = beamSearchTraced(starts, directed, outgoing, targetLength, kind, loop, regions, options.recordExpansions ?? false, fineCoverageEnabled);
  const search = { ...searchBase, statesExplored: expansions };
  const beamTrace: BeamTrace = {
    expansions: trace,
    totalExpansions: expansions,
    hitExpansionCap: expansions >= GRAPH_SHAPE.maxExpansions,
    finalEdgeIds: best?.edgeIds ?? [],
    finalCost: best?.cost ?? null,
    reachedGoal: best != null && isGoal(best, GRAPH_SHAPE.progressBins, kind, loop, directed),
    finalFineCoverageBinsCovered: best ? bigintPopcount(best.fineCoverage) : 0,
    finalFineCoverageTotalBins: FINE_COVERAGE.bins,
  };

  if (!best) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'search_exhausted', regions, search, null, null), trace: beamTrace };
  }

  const pathPoints = polylineFromEdges(best.edgeIds, directed);
  const waySequence = best.edgeIds.map((id) => directed.get(id)?.wayId).filter((id): id is string => Boolean(id));
  const wayIds = unique(waySequence);
  const connected = pathIsConnected(best.edgeIds, directed);
  const computed = metricsFromPath(pathPoints, target, waySequence, connected, loop);
  const startNode = directed.get(best.edgeIds[0] ?? '')?.from ?? null;
  const endNode = directed.get(best.edgeIds[best.edgeIds.length - 1] ?? '')?.to ?? null;
  let failure = classifyFailure(computed, loop, best.usedInterior);
  if (kind === 'O' && !oLoopClosed(pathPoints, startNode, endNode)) failure = 'low_coverage';

  return {
    result: resultOf(kind, pathPoints, best.edgeIds, wayIds, computed, failure, regions, search, startNode, endNode, waySequence, transitionsFromEdges(best.edgeIds, directed)),
    trace: beamTrace,
  };
}

// ---------------------------------------------------------------------------
// Letter-corridor bookkeeping (external to the search, never fed back into it)
// ---------------------------------------------------------------------------

export type LetterCorridor = {
  letter: string;
  index: number;
  target: readonly Vec2[];
  thresholdMeters: number;
};

export type LetterEntryClassification =
  | 'NO_ENTRY'
  | 'ENTERED_AND_PRUNED'
  | 'SURVIVED_BUT_NOT_SELECTED'
  | 'SELECTED_BUT_LOW_COVERAGE'
  | 'EXPANSION_CAP'
  | 'OTHER';

export type LetterEntryAnalysis = {
  letter: string;
  index: number;
  everEntered: boolean;
  everSurvivedBeamCut: boolean;
  finalRouteUsesRegion: boolean;
  rawInkCoverage: number;
  firstEntryExpansion: number | null;
  firstEntryDepth: number | null;
  bestEntryCoverageBinsNew: number | null;
  beamRankAtFirstEntry: number | null;
  classification: LetterEntryClassification;
};

/** Whether a beam-expansion record's position lies within `corridor.thresholdMeters` of that letter's own target ink. */
export function positionInsideCorridor(position: Vec2, corridor: LetterCorridor): boolean {
  if (corridor.target.length < 2) return false;
  return distanceToPolyline(position, corridor.target) <= corridor.thresholdMeters;
}

/**
 * Classifies, per letter, whether the beam ever entered that letter's tight
 * corridor and what happened to it — Section 4/6 of the task. `finalRoute`
 * is the SAME pathPoints array traceGraphConstrainedShape already returned
 * (never recomputed).
 */
export function analyzeLetterEntries(trace: BeamTrace, corridors: readonly LetterCorridor[], finalRoutePoints: readonly Vec2[], rawInkByLetter: readonly number[], hitExpansionCap: boolean): LetterEntryAnalysis[] {
  return corridors.map((corridor, corridorIndex) => {
    const entries = trace.expansions.filter((record) => positionInsideCorridor(record.position, corridor));
    const everEntered = entries.length > 0;
    const survived = entries.filter((record) => record.survivedBeamCut);
    const everSurvivedBeamCut = survived.length > 0;
    const finalRouteUsesRegion = finalRoutePoints.some((point) => distanceToPolyline(point, corridor.target) <= corridor.thresholdMeters);
    const rawInkCoverage = rawInkByLetter[corridorIndex] ?? 0;
    const first = entries[0] ?? null;

    let classification: LetterEntryClassification;
    if (!everEntered) {
      classification = hitExpansionCap ? 'EXPANSION_CAP' : 'NO_ENTRY';
    } else if (!everSurvivedBeamCut) {
      classification = 'ENTERED_AND_PRUNED';
    } else if (!finalRouteUsesRegion) {
      classification = 'SURVIVED_BUT_NOT_SELECTED';
    } else if (rawInkCoverage < 0.32) {
      classification = 'SELECTED_BUT_LOW_COVERAGE';
    } else {
      classification = 'OTHER'; // effectively "successfully used" — see the run script's own pass/fail split, which treats this case separately from a true failure.
    }

    return {
      letter: corridor.letter,
      index: corridor.index,
      everEntered,
      everSurvivedBeamCut,
      finalRouteUsesRegion,
      rawInkCoverage,
      firstEntryExpansion: first?.expansion ?? null,
      firstEntryDepth: first?.depth ?? null,
      bestEntryCoverageBinsNew: entries.length ? Math.max(...entries.map((record) => record.coverageBinsNew)) : null,
      beamRankAtFirstEntry: first?.beamRankAtInsertion ?? null,
      classification,
    };
  });
}
