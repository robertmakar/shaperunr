/**
 * DEVELOPMENT ONLY. Crossing-penalty shadow experiment — never modifies
 * graph-shape.ts, never called from the live route generation path.
 *
 * Exact production crossing formula (re-read directly from the current
 * graph-shape.ts source for this task, lines confirmed below):
 *
 *   // analyzeDirected() — a STATIC per-edge geometric property, computed
 *   // once from the directed edge's own geometry (progressSpan, headingFit,
 *   // followMeters, length), never from beam/route state:
 *   const crossing =
 *     (progressSpan * targetLength < GRAPH_SHAPE.minProgressSpanMeters && headingFit < 0.55) ||
 *     (followMeters < GRAPH_SHAPE.minFollowMeters && headingFit < 0.45);
 *
 *   // edgeCost() — applied per edge, added into the same additive sum as
 *   // every other term (perp, heading, back, skip, detour, interior,
 *   // repeat, reverseWalk, regionSkip, followBonus, overlapBonus):
 *   const tinySpan = edge.progressSpan * targetLength < GRAPH_SHAPE.minProgressSpanMeters ? 22 + edge.length * 0.4 : 0;
 *   const crossing = edge.crossing ? 18 + edge.length * 0.35 + tinySpan : tinySpan;
 *
 * GRAPH_SHAPE.minProgressSpanMeters = 10, GRAPH_SHAPE.minFollowMeters = 18
 * (both read directly from the real, unmodified GRAPH_SHAPE constant).
 *
 * Because `crossing`'s two threshold-dependent quantities (the boolean and
 * `tinySpan`) are both derivable purely from a Directed edge's own already-
 * computed, threshold-INDEPENDENT geometry (progressSpan, headingFit,
 * followMeters, length — all set once by the real, unmodified
 * analyzeDirected()), this experiment does NOT need its own copy of
 * analyzeDirected/explodeDirected at all: it reuses beam-search-trace.ts's
 * already-parity-verified explodeDirected() unchanged, and only
 * RECOMPUTES the crossing boolean/tinySpan/final term at edgeCost time
 * with configurable threshold and magnitude multipliers — every other
 * edgeCost component (perp, heading, back, skip, detour, interior, repeat,
 * reverseWalk, regionSkip, followBonus, overlapBonus) is read from the
 * real, unmodified letter-transition-diagnostic.ts::edgeCostBreakdown(),
 * itself already verified to sum to the real edgeCost().
 */
import { polylineLength, type Vec2 } from '@/lib/geometry';

import {
  betterState,
  bitCount,
  classifyFailure,
  clamp01,
  emptyMetrics,
  explodeDirected,
  indexOutgoing,
  isGoal,
  metricsFromPath,
  oLoopClosed,
  pathIsConnected,
  polylineFromEdges,
  positionInsideCorridor,
  prepareStartEdge,
  progressBin,
  resultOf,
  transitionsFromEdges,
  undirectedKey,
  unique,
  withKey,
  wrapProgress,
  type Directed,
  type LetterCorridor,
  type SearchState,
} from './beam-search-trace';
import { edgeCostBreakdown } from './letter-transition-diagnostic';
import { GRAPH_SHAPE, isClosedTarget, regionsForKind, type GraphShapeResult, type ShapeGraph, type ShapeKind } from '../generation/graph-shape';
import { coverageThresholdMeters } from '../generation/target-identity';
import type { TargetRegion } from './street-fit';

// ---------------------------------------------------------------------------
// Shadow crossing formula — parameterized re-derivation of the real formula
// ---------------------------------------------------------------------------

export type CrossingParams = {
  /** Multiplies the FINAL crossing cost term (18 + length*0.35 + tinySpan, or just tinySpan when not crossing). 1 = baseline production magnitude. */
  crossingMultiplier: number;
  /** Multiplies GRAPH_SHAPE.minProgressSpanMeters and GRAPH_SHAPE.minFollowMeters BEFORE the crossing boolean/tinySpan comparisons. 1 = baseline production thresholds. */
  thresholdMultiplier: number;
};

export const CROSSING_VARIANTS: Record<string, CrossingParams> = {
  A_BASELINE: { crossingMultiplier: 1, thresholdMultiplier: 1 },
  B_HALF_CROSSING: { crossingMultiplier: 0.5, thresholdMultiplier: 1 },
  C_QUARTER_CROSSING: { crossingMultiplier: 0.25, thresholdMultiplier: 1 },
  D_NO_CROSSING: { crossingMultiplier: 0, thresholdMultiplier: 1 },
  E_THRESHOLD_RELAXED: { crossingMultiplier: 1, thresholdMultiplier: 2 },
  F_RELAXED_PLUS_HALF: { crossingMultiplier: 0.5, thresholdMultiplier: 2 },
};

/** Recomputes the crossing boolean + tinySpan + final term with configurable thresholds/magnitude, from the edge's own real, threshold-independent geometry (progressSpan, headingFit, followMeters, length) — never touches analyzeDirected. */
export function shadowCrossingCost(edge: Directed, targetLength: number, params: CrossingParams): number {
  const minProgressSpanMeters = GRAPH_SHAPE.minProgressSpanMeters * params.thresholdMultiplier;
  const minFollowMeters = GRAPH_SHAPE.minFollowMeters * params.thresholdMultiplier;
  const tinySpan = edge.progressSpan * targetLength < minProgressSpanMeters ? 22 + edge.length * 0.4 : 0;
  const isCrossing = (edge.progressSpan * targetLength < minProgressSpanMeters && edge.headingFit < 0.55) || (edge.followMeters < minFollowMeters && edge.headingFit < 0.45);
  const raw = isCrossing ? 18 + edge.length * 0.35 + tinySpan : tinySpan;
  return raw * params.crossingMultiplier;
}

/** The full shadow edgeCost: every term except crossing comes from the real, unmodified edgeCostBreakdown(); crossing is replaced by shadowCrossingCost(). At CROSSING_VARIANTS.A_BASELINE this is byte-identical to the real edgeCost() (verified in the self-test). */
export function shadowEdgeCost(edge: Directed, currentProgress: number, targetLength: number, loop: boolean, used: Set<string>, kind: ShapeKind, regions: readonly TargetRegion[], params: CrossingParams): number {
  const breakdown = edgeCostBreakdown(edge, currentProgress, targetLength, loop, used, kind, regions);
  const crossing = shadowCrossingCost(edge, targetLength, params);
  return breakdown.total - breakdown.crossing + crossing;
}

// ---------------------------------------------------------------------------
// Beam search using shadowEdgeCost — otherwise byte-identical to production
// (same dedup key, same beam width, same expansion cap, same sort/tiebreak)
// ---------------------------------------------------------------------------

function startStatesCrossing(directed: Map<string, Directed>, origin: Vec2, target: readonly Vec2[], targetLength: number, loop: boolean, kind: ShapeKind, regions: readonly TargetRegion[], params: CrossingParams): SearchState[] {
  const prepared: Directed[] = [];
  for (const edge of [...directed.values()]) {
    // Reuses the REAL, unmodified prepareStartEdge() (exported from beam-search-trace.ts) — this function is threshold-independent (only uses GRAPH_SHAPE.startRadiusMeters/startProgress/corridorMeters, none of which are part of this experiment), including its trimmed-start-edge case, so start-state selection is identical across every crossing variant and matches production exactly at baseline.
    const startEdge = prepareStartEdge(edge, origin, target, loop);
    if (!startEdge) continue;
    if (startEdge.id !== edge.id) directed.set(startEdge.id, startEdge);
    prepared.push(startEdge);
  }
  const startCost = (edge: Directed) => shadowEdgeCost(edge, 0, targetLength, loop, new Set(), kind, regions, params);
  const ranked = prepared.sort((a, b) => startCost(a) - startCost(b));
  return ranked.slice(0, 24).map((edge) => ({
    node: edge.to,
    progress: edge.endProgress,
    cost: startCost(edge),
    length: edge.length,
    covered: coverMaskLocal(0, edge.startProgress, edge.endProgress, loop),
    fineCoverage: edge.fineCoverageMask,
    edgeIds: [edge.id],
    usedUndirected: new Set([undirectedKey(edge)]),
    usedInterior: edge.interior,
  }));
}

function coverMaskLocal(_existing: number, start: number, end: number, loop: boolean): number {
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

export type CrossingExpansionRecord = {
  edgeId: string;
  crossingCostBaseline: number;
  crossingCostShadow: number;
  crossingTriggered: boolean;
  progressSpan: number;
  followMeters: number;
  edgeLength: number;
  headingFit: number;
  perpendicularDistanceMeters: number;
  followBonus: number;
  overlapBonus: number;
  totalEdgeCostShadow: number;
};

function beamSearchCrossing(
  starts: SearchState[],
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  regions: readonly TargetRegion[],
  params: CrossingParams,
  recordExpansions: boolean,
): { best: SearchState | null; expansions: number; trace: CrossingExpansionRecord[] } {
  const bins = GRAPH_SHAPE.progressBins;
  const bestAt = new Map<string, number>();
  let beam = starts;
  let bestGoal: SearchState | null = null;
  let bestAny: SearchState | null = starts[0] ?? null;
  let expansions = 0;
  const trace: CrossingExpansionRecord[] = [];

  while (beam.length > 0 && expansions < GRAPH_SHAPE.maxExpansions) {
    const next: SearchState[] = [];
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
        const stepCost = shadowEdgeCost(edge, state.progress, targetLength, loop, used, kind, regions, params);
        const progress = loop ? wrapProgress(edge.endProgress) : clamp01(edge.endProgress);
        const child: SearchState = {
          node: edge.to,
          progress,
          cost: state.cost + stepCost,
          length: state.length + edge.length,
          covered: state.covered | coverMaskLocal(state.covered, edge.startProgress, edge.endProgress, loop),
          fineCoverage: state.fineCoverage,
          edgeIds: [...state.edgeIds, edge.id],
          usedUndirected: withKey(used, undirectedKey(edge)),
          usedInterior: state.usedInterior || edge.interior,
        };
        const key = `${child.node}:${progressBin(child.progress, bins)}:${bitCount(child.covered)}`;
        const previous = bestAt.get(key);
        if (previous != null && previous <= child.cost) continue;
        bestAt.set(key, child.cost);
        next.push(child);

        if (recordExpansions) {
          const baseline = shadowCrossingCost(edge, targetLength, CROSSING_VARIANTS.A_BASELINE!);
          const shadow = shadowCrossingCost(edge, targetLength, params);
          trace.push({
            edgeId: edge.id,
            crossingCostBaseline: baseline,
            crossingCostShadow: shadow,
            crossingTriggered: edge.crossing,
            progressSpan: edge.progressSpan,
            followMeters: edge.followMeters,
            edgeLength: edge.length,
            headingFit: edge.headingFit,
            perpendicularDistanceMeters: edge.meanPerp,
            followBonus: -Math.min(edge.followMeters, 80) * 0.12,
            overlapBonus: -Math.min(edge.overlapMeters, 120) * 0.08,
            totalEdgeCostShadow: stepCost,
          });
        }
      }
    }
    next.sort((a, b) => a.cost - b.cost + 0.15 * (progressBin(b.progress, bins) - progressBin(a.progress, bins)));
    beam = next.slice(0, GRAPH_SHAPE.beamPerBin * 4);
  }

  return { best: bestGoal ?? bestAny, expansions, trace };
}

export type CrossingTraceOptions = {
  params: CrossingParams;
  recordExpansions?: boolean;
};

export function traceGraphConstrainedShapeCrossing(
  input: { target: readonly Vec2[]; graph: ShapeGraph; kind?: ShapeKind; multiLetter?: boolean },
  options: CrossingTraceOptions,
): { result: GraphShapeResult; expansions: number; trace: CrossingExpansionRecord[] } {
  const kind = input.kind ?? 'generic';
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const regions = input.multiLetter && kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, target);
  const emptySearch = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount: 0, statesExplored: 0 };

  if (target.length < 2 || targetLength <= 0 || input.graph.segments.length === 0) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_graph', regions, emptySearch, null, null), expansions: 0, trace: [] };
  }

  const loop = kind === 'O' || isClosedTarget(target);
  const coverageThreshold = coverageThresholdMeters(target);
  const directed = explodeDirected(input.graph, target, targetLength, kind, loop, regions, coverageThreshold);
  const candidateEdgeCount = unique([...directed.values()].filter((edge) => !edge.crossing).map((edge) => edge.id.replace(/[><]$/, ''))).length;
  const searchBase = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount, statesExplored: 0 };
  const outgoing = indexOutgoing(directed);
  const origin = target[0] ?? { x: 0, y: 0 };
  const starts = startStatesCrossing(directed, origin, target, targetLength, loop, kind, regions, options.params);
  if (starts.length === 0) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_start_node', regions, searchBase, null, null), expansions: 0, trace: [] };
  }

  const { best, expansions, trace } = beamSearchCrossing(starts, directed, outgoing, targetLength, kind, loop, regions, options.params, options.recordExpansions ?? false);
  const search = { ...searchBase, statesExplored: expansions };

  if (!best) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'search_exhausted', regions, search, null, null), expansions, trace };
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
    expansions,
    trace,
  };
}

export { positionInsideCorridor, type LetterCorridor };
