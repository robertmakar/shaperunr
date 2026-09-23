/**
 * DEVELOPMENT ONLY. Letter-to-letter transition feasibility diagnostic —
 * never modifies graph-shape.ts, never called from the live route
 * generation path.
 *
 * Question: when the beam search fails to move from one letter's corridor
 * to the next, is that because the pedestrian graph has no connected path
 * between them, or because a connected path exists but the beam's own
 * transition costs (backward-progress penalty, corridor/heading penalties,
 * detour/crossing penalties, etc. — all read from the real, unmodified
 * edgeCost() via beam-search-trace.ts's already-verified mirror) make it
 * unattractive relative to competing branches?
 *
 * This file adds TWO things, both read-only and independent of the beam
 * objective:
 * 1. A plain graph-connectivity search (multi-source Dijkstra by edge
 *    LENGTH, ignoring shape cost entirely) between two letter corridors'
 *    entry/exit nodes — answers "is B reachable from A through the graph
 *    at all," independent of whether the beam actually found it.
 * 2. A cost-component breakdown (edgeCostBreakdown) that mirrors
 *    graph-shape.ts's real, unmodified edgeCost() formula term-by-term —
 *    verified in the self-test to sum to the exact same total edgeCost()
 *    already returns, so no new scoring is invented.
 *
 * Reuses beam-search-trace.ts's already-parity-verified mirror
 * (explodeDirected, edgeCost, progressGain, GRAPH_SHAPE, etc.) for
 * everything else.
 */
import { distanceToPolyline, type Vec2 } from '@/lib/geometry';

import {
  edgeCost,
  positionInsideCorridor,
  progressGain,
  undirectedKey,
  type Directed,
  type LetterCorridor,
} from './beam-search-trace';
import { GRAPH_SHAPE, type ShapeKind } from '../generation/graph-shape';
import type { TargetRegion } from './street-fit';

// ---------------------------------------------------------------------------
// 1. Plain graph connectivity (shape-cost-agnostic)
// ---------------------------------------------------------------------------

export function corridorEntryExitNodes(directed: Map<string, Directed>, corridor: LetterCorridor): Set<string> {
  const nodes = new Set<string>();
  for (const edge of directed.values()) {
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];
    if (start && positionInsideCorridor(start, corridor)) nodes.add(edge.from);
    if (end && positionInsideCorridor(end, corridor)) nodes.add(edge.to);
  }
  return nodes;
}

export type ConnectivityPath = {
  edgeIds: string[];
  totalLengthMeters: number;
};

/** Multi-source Dijkstra by edge LENGTH only (shape cost, edge repeat, and beam pruning are all ignored) — the plain question "does a connected walk exist at all." */
export function findShortestConnectingPath(directed: Map<string, Directed>, outgoing: Map<string, Directed[]>, fromNodes: ReadonlySet<string>, toNodes: ReadonlySet<string>): ConnectivityPath | null {
  if (fromNodes.size === 0 || toNodes.size === 0) return null;
  const dist = new Map<string, number>();
  const prevEdge = new Map<string, string>();
  const visited = new Set<string>();
  const queue: Array<{ node: string; dist: number }> = [];
  for (const node of fromNodes) {
    dist.set(node, 0);
    queue.push({ node, dist: 0 });
  }

  while (queue.length > 0) {
    queue.sort((a, b) => a.dist - b.dist);
    const current = queue.shift()!;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    if (toNodes.has(current.node) && !fromNodes.has(current.node)) {
      const edgeIds: string[] = [];
      let cursor = current.node;
      while (prevEdge.has(cursor)) {
        const edgeId = prevEdge.get(cursor)!;
        edgeIds.push(edgeId);
        cursor = directed.get(edgeId)!.from;
      }
      edgeIds.reverse();
      return { edgeIds, totalLengthMeters: current.dist };
    }
    const edges = outgoing.get(current.node) ?? [];
    for (const edge of edges) {
      const nextDist = current.dist + edge.length;
      const known = dist.get(edge.to);
      if (known == null || nextDist < known) {
        dist.set(edge.to, nextDist);
        prevEdge.set(edge.to, edge.id);
        queue.push({ node: edge.to, dist: nextDist });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Real edgeCost(), decomposed into its own terms (mirrors the exact
//    formula; verified in the self-test to sum to the real edgeCost()).
// ---------------------------------------------------------------------------

export type EdgeCostBreakdown = {
  total: number;
  base: number;
  perp: number;
  heading: number;
  backward: number;
  skip: number;
  detour: number;
  crossing: number;
  interior: number;
  repeat: number;
  reverseWalk: number;
  regionSkip: number;
  followBonus: number;
  overlapBonus: number;
};

function regionSkipPenaltyLocal(_kind: ShapeKind, from: number, to: number, regions: readonly TargetRegion[]): number {
  if (regions.length < 2) return 0;
  const regionIndex = (progress: number) => {
    const index = regions.findIndex((region) => progress >= region.startProgress && progress <= region.endProgress);
    return index < 0 ? regions.length - 1 : index;
  };
  const a = regionIndex(from);
  const b = regionIndex(to);
  if (b < a) return 40;
  if (b > a + 1) return 24;
  return 0;
}

/** Mirrors graph-shape.ts's private edgeCost() exactly, term-by-term. Parity with the real (imported, unmodified) edgeCost() is verified in the self-test. */
export function edgeCostBreakdown(edge: Directed, currentProgress: number, targetLength: number, loop: boolean, used: ReadonlySet<string>, kind: ShapeKind, regions: readonly TargetRegion[]): EdgeCostBreakdown {
  const gain = progressGain(currentProgress, edge.endProgress, loop);
  const skipRaw = loop ? 0 : Math.max(0, edge.minProgress - currentProgress - 0.1);
  const expected = Math.max(gain, 0.002) * targetLength;
  const detourRaw = Math.max(0, edge.length - expected * 1.85);
  const backRaw = Math.max(0, -gain);
  const tinySpan = edge.progressSpan * targetLength < GRAPH_SHAPE.minProgressSpanMeters ? 22 + edge.length * 0.4 : 0;
  const crossing = edge.crossing ? 18 + edge.length * 0.35 + tinySpan : tinySpan;
  const interior = edge.interior ? 80 + edge.length * 1.2 : 0;
  const repeat = used.has(undirectedKey(edge)) ? 120 + edge.length : 0;
  const reverseWalk = edge.forwardness < 0 ? 16 + Math.abs(edge.forwardness) * 80 : 0;
  const followBonus = -Math.min(edge.followMeters, 80) * 0.12;
  const overlapBonus = -Math.min(edge.overlapMeters, 120) * 0.08;
  const perp = edge.meanPerp * (0.35 + edge.length / Math.max(targetLength, 1));
  const heading = (1 - edge.headingFit) * (8 + edge.length * 0.08);
  const regionSkip = regionSkipPenaltyLocal(kind, currentProgress, edge.endProgress, regions);
  const backward = backRaw * 140;
  const skip = skipRaw * 90;
  const detour = detourRaw * 0.22;
  const base = 4;
  const total = base + perp + heading + backward + skip + detour + crossing + interior + repeat + reverseWalk + regionSkip + followBonus + overlapBonus;
  return { total, base, perp, heading, backward, skip, detour, crossing, interior, repeat, reverseWalk, regionSkip, followBonus, overlapBonus };
}

/** Real edgeCost() (imported, unmodified) called with the SAME arguments — used to cross-check edgeCostBreakdown's total in the self-test. */
export function realEdgeCost(edge: Directed, currentProgress: number, targetLength: number, loop: boolean, used: Set<string>, kind: ShapeKind, regions: readonly TargetRegion[]): number {
  return edgeCost(edge, currentProgress, targetLength, loop, used, kind, regions);
}

// ---------------------------------------------------------------------------
// 3. Transition path analysis: direct vs detour (backward progress /
//    corridor escape), and cost of walking the found path.
// ---------------------------------------------------------------------------

export type TransitionPathAnalysis = {
  edgeIds: string[];
  totalLengthMeters: number;
  minProgressDuringTransition: number;
  maxProgressDuringTransition: number;
  startingProgress: number;
  endingProgress: number;
  requiredBackwardProgress: number;
  maxPerpendicularDistanceMeters: number;
  requiresCorridorEscape45m: boolean;
  requiresCorridorEscape70m: boolean;
  totalCost: number;
  costBreakdownSum: EdgeCostBreakdown;
  perEdgeCost: EdgeCostBreakdown[];
};

function sumBreakdowns(items: readonly EdgeCostBreakdown[]): EdgeCostBreakdown {
  const zero: EdgeCostBreakdown = { total: 0, base: 0, perp: 0, heading: 0, backward: 0, skip: 0, detour: 0, crossing: 0, interior: 0, repeat: 0, reverseWalk: 0, regionSkip: 0, followBonus: 0, overlapBonus: 0 };
  return items.reduce((sum, item) => ({
    total: sum.total + item.total,
    base: sum.base + item.base,
    perp: sum.perp + item.perp,
    heading: sum.heading + item.heading,
    backward: sum.backward + item.backward,
    skip: sum.skip + item.skip,
    detour: sum.detour + item.detour,
    crossing: sum.crossing + item.crossing,
    interior: sum.interior + item.interior,
    repeat: sum.repeat + item.repeat,
    reverseWalk: sum.reverseWalk + item.reverseWalk,
    regionSkip: sum.regionSkip + item.regionSkip,
    followBonus: sum.followBonus + item.followBonus,
    overlapBonus: sum.overlapBonus + item.overlapBonus,
  }), zero);
}

/** Walks a found connecting path edge-by-edge, computing the REAL edgeCost breakdown for each edge at the progress the path had actually reached, and tracking backward-progress / corridor-escape characteristics along the way. */
export function analyzeTransitionPath(
  path: ConnectivityPath,
  directed: Map<string, Directed>,
  targetLength: number,
  loop: boolean,
  kind: ShapeKind,
  regions: readonly TargetRegion[],
  startingProgress: number,
): TransitionPathAnalysis {
  let progress = startingProgress;
  let minProgress = startingProgress;
  let maxProgress = startingProgress;
  let maxPerp = 0;
  const used = new Set<string>();
  const perEdgeCost: EdgeCostBreakdown[] = [];

  for (const edgeId of path.edgeIds) {
    const edge = directed.get(edgeId);
    if (!edge) continue;
    const breakdown = edgeCostBreakdown(edge, progress, targetLength, loop, used, kind, regions);
    perEdgeCost.push(breakdown);
    used.add(undirectedKey(edge));
    maxPerp = Math.max(maxPerp, edge.meanPerp);
    const nextProgress = loop ? edge.endProgress : Math.min(1, Math.max(0, edge.endProgress));
    minProgress = Math.min(minProgress, nextProgress);
    maxProgress = Math.max(maxProgress, nextProgress);
    progress = nextProgress;
  }

  const requiredBackwardProgress = Math.max(0, startingProgress - minProgress);

  return {
    edgeIds: path.edgeIds,
    totalLengthMeters: path.totalLengthMeters,
    minProgressDuringTransition: minProgress,
    maxProgressDuringTransition: maxProgress,
    startingProgress,
    endingProgress: progress,
    requiredBackwardProgress,
    maxPerpendicularDistanceMeters: maxPerp,
    requiresCorridorEscape45m: maxPerp > GRAPH_SHAPE.followRadiusMeters,
    requiresCorridorEscape70m: maxPerp > GRAPH_SHAPE.corridorMeters,
    totalCost: perEdgeCost.reduce((s, b) => s + b.total, 0),
    costBreakdownSum: sumBreakdowns(perEdgeCost),
    perEdgeCost,
  };
}

// ---------------------------------------------------------------------------
// 4. Whether the beam's own selected route actually achieves A -> B in order
// ---------------------------------------------------------------------------

export function beamAchievesTransition(pathPoints: readonly Vec2[], corridorA: LetterCorridor, corridorB: LetterCorridor): boolean {
  let sawA = false;
  for (const point of pathPoints) {
    if (!sawA && positionInsideCorridor(point, corridorA)) {
      sawA = true;
      continue;
    }
    if (sawA && positionInsideCorridor(point, corridorB)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 5. Top-level classification
// ---------------------------------------------------------------------------

export type TransitionClassification = 'DIRECT_AND_FOUND' | 'DETOUR_AND_FOUND' | 'CONNECTED_BUT_BEAM_BLOCKED' | 'DISCONNECTED' | 'NO_DATA';

/** Diagnostic-only tolerance for "roughly monotonic" — matches the order of magnitude of GRAPH_SHAPE's own maxBacktrack-style tolerances elsewhere in this codebase, used purely for labeling. */
const BACKWARD_PROGRESS_TOLERANCE = 0.02;

export function classifyTransition(pathAnalysis: TransitionPathAnalysis | null, beamAchieves: boolean, hasData: boolean): TransitionClassification {
  if (!hasData) return 'NO_DATA';
  if (!pathAnalysis) return 'DISCONNECTED';
  if (beamAchieves) {
    const isDetour = pathAnalysis.requiredBackwardProgress > BACKWARD_PROGRESS_TOLERANCE || pathAnalysis.requiresCorridorEscape45m;
    return isDetour ? 'DETOUR_AND_FOUND' : 'DIRECT_AND_FOUND';
  }
  return 'CONNECTED_BUT_BEAM_BLOCKED';
}
