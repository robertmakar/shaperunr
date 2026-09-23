/**
 * DEVELOPMENT ONLY. Letter-aware beam-state shadow experiment — never
 * modifies graph-shape.ts, never called from the live route generation
 * path.
 *
 * Confirmed directly from source for this task:
 * - WordShape.letters[] (src/lib/word-shape.ts) holds each letter's own
 *   flattened point array; letterBoundariesFromWordShape() (multi-letter-
 *   trace.ts, UNCHANGED, reused here) projects each letter's own points
 *   onto the full flattened target to get projectedStartProgress/
 *   projectedEndProgress — the SAME representation target-identity.ts's
 *   own letterIdentities() already uses for wordTraversal/lettersVisitedInOrder.
 * - In routeGraphConstrainedShape() (graph-shape.ts), regions collapses to
 *   ONE span for multi-letter generic words:
 *     regions = input.multiLetter && kind === 'generic'
 *       ? [{ id: 'shape', startProgress: 0, endProgress: 1 }]
 *       : regionsForKind(kind, target);
 *   which makes regionSkipPenalty() permanently return 0 (it requires
 *   regions.length >= 2) — this is the exact, single place the "no notion
 *   of current letter" architecture originates. This experiment does NOT
 *   touch `regions`/regionSkipPenalty at all; it adds a SEPARATE, additive
 *   piece of bookkeeping (currentLetterIndex) alongside it.
 * - Letter identity downstream is reconstructed post-hoc by target-
 *   identity.ts's letterIdentities(), independently of what the beam did
 *   during search — confirmed unchanged and untouched here.
 *
 * Design (Step 8's "minimal state-dependent gating, clearly isolated"):
 * the ONLY thing currentLetterIndex affects is the DEDUPLICATION KEY
 * (Step 9 explicitly sanctions this smallest possible extension). No new
 * reward, no new edgeCost term, no change to regions/regionSkipPenalty,
 * no change to isGoal/betterState/beam width/expansion cap/sort order.
 * At OLD (currentLetterIndex excluded from the key — see
 * LETTER_AWARE_VARIANTS.OLD), this is byte-identical to production
 * (verified in the self-test).
 *
 * "Sufficiently traversed" (Step 5) reuses the SAME fine-grained physical
 * ink-coverage bitmask already carried by SearchState.fineCoverage /
 * Directed.fineCoverageMask (both already present as an existing shadow
 * capability in beam-search-trace.ts, unchanged here) — computed from the
 * SAME coverageThresholdMeters() physical-distance concept used
 * throughout this investigation, never a new geometry/threshold.
 */
import { polylineLength, type Vec2 } from '@/lib/geometry';

import {
  betterState,
  bigintPopcount,
  bitCount,
  classifyFailure,
  clamp01,
  edgeCost,
  emptyMetrics,
  explodeDirected,
  FINE_COVERAGE,
  indexOutgoing,
  isGoal,
  metricsFromPath,
  oLoopClosed,
  pathIsConnected,
  polylineFromEdges,
  prepareStartEdge,
  progressBin,
  resultOf,
  transitionsFromEdges,
  undirectedKey,
  unique,
  withKey,
  wrapProgress,
  type Directed,
  type SearchState,
} from './beam-search-trace';
import { GRAPH_SHAPE, isClosedTarget, regionsForKind, type GraphShapeResult, type ShapeGraph, type ShapeKind } from '../generation/graph-shape';
import { coverageThresholdMeters } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import type { TargetRegion } from './street-fit';

// ---------------------------------------------------------------------------
// Letter range masks — which fine bins (of the SAME 128-bin scheme
// SearchState.fineCoverage already uses) fall inside each letter's own
// projected boundary. Built once per candidate from the EXISTING,
// unmodified letterBoundariesFromWordShape().
// ---------------------------------------------------------------------------

export type LetterRangeMask = {
  letterIndex: number;
  letter: string;
  mask: bigint;
  totalBins: number;
  startProgress: number;
  endProgress: number;
};

export function buildLetterRangeMasks(boundaries: readonly LetterBoundary[]): LetterRangeMask[] {
  return boundaries.map((boundary, index) => {
    const startBin = Math.max(0, Math.floor(boundary.projectedStartProgress * FINE_COVERAGE.bins));
    const endBin = Math.min(FINE_COVERAGE.bins - 1, Math.floor(boundary.projectedEndProgress * FINE_COVERAGE.bins));
    let mask = 0n;
    for (let bin = startBin; bin <= endBin; bin += 1) {
      mask |= 1n << BigInt(bin);
    }
    return { letterIndex: index, letter: boundary.letter, mask, totalBins: bigintPopcount(mask), startProgress: boundary.projectedStartProgress, endProgress: boundary.projectedEndProgress };
  });
}

/** Fraction of the letter's own fine bins already covered by this state's accumulated fineCoverage bitmask. */
export function letterCoverageFraction(fineCoverage: bigint, range: LetterRangeMask): number {
  if (range.totalBins === 0) return 0;
  return bigintPopcount(fineCoverage & range.mask) / range.totalBins;
}

/** "Sufficiently traversed" (Step 5): physically covered enough of the letter's own ink (the fine-coverage fraction) AND the route has reached the letter's progress region. Forward/local progression is already enforced, unchanged, by the real edgeCost's own back/skip/reverseWalk terms — not re-implemented here. */
export function letterSufficientlyTraversed(fineCoverage: bigint, progress: number, range: LetterRangeMask, coverageThreshold: number): boolean {
  return letterCoverageFraction(fineCoverage, range) >= coverageThreshold && progress >= range.startProgress;
}

// ---------------------------------------------------------------------------
// Letter-aware search state and beam search
// ---------------------------------------------------------------------------

export type LetterAwareState = SearchState & { currentLetterIndex: number };

export type LetterAwareMode = 'OLD' | 'NEW';

export type LetterAwareParams = {
  mode: LetterAwareMode;
  /** Ignored when mode='OLD'. */
  letterCoverageThreshold: number;
};

export const LETTER_AWARE_VARIANTS: Record<string, LetterAwareParams> = {
  OLD: { mode: 'OLD', letterCoverageThreshold: 0 },
  NEW_40: { mode: 'NEW', letterCoverageThreshold: 0.4 },
  NEW_50: { mode: 'NEW', letterCoverageThreshold: 0.5 },
  NEW_60: { mode: 'NEW', letterCoverageThreshold: 0.6 },
};

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

/** Advances currentLetterIndex for the CHILD state if the letter it was actively pursuing becomes sufficiently traversed by the child's own accumulated coverage — never decrements, never skips letters, never requires prior letters to be complete (later letters can still accumulate fine coverage regardless of currentLetterIndex; this index is bookkeeping/dedup-key material only, never a hard gate on which edges are explorable). */
function advanceLetterIndex(parentIndex: number, childFineCoverage: bigint, childProgress: number, ranges: readonly LetterRangeMask[], coverageThreshold: number): number {
  if (parentIndex >= ranges.length - 1) return parentIndex;
  const activeRange = ranges[parentIndex]!;
  if (letterSufficientlyTraversed(childFineCoverage, childProgress, activeRange, coverageThreshold)) {
    return parentIndex + 1;
  }
  return parentIndex;
}

export type LetterTransitionEvent = { fromLetterIndex: number; toLetterIndex: number; atExpansion: number };

function beamSearchLetterAware(
  starts: LetterAwareState[],
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  regions: readonly TargetRegion[],
  ranges: readonly LetterRangeMask[],
  params: LetterAwareParams,
): { best: LetterAwareState | null; expansions: number; transitions: LetterTransitionEvent[]; lettersCompletedMax: number } {
  const bins = GRAPH_SHAPE.progressBins;
  const bestAt = new Map<string, number>();
  let beam = starts;
  let bestGoal: LetterAwareState | null = null;
  let bestAny: LetterAwareState | null = starts[0] ?? null;
  let expansions = 0;
  const transitions: LetterTransitionEvent[] = [];
  let lettersCompletedMax = 0;

  while (beam.length > 0 && expansions < GRAPH_SHAPE.maxExpansions) {
    const next: LetterAwareState[] = [];
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
        const stepCost = edgeCost(edge, state.progress, targetLength, loop, used, kind, regions);
        const progress = loop ? wrapProgress(edge.endProgress) : clamp01(edge.endProgress);
        const fineCoverage = state.fineCoverage | edge.fineCoverageMask;
        const childLetterIndex =
          params.mode === 'NEW' ? advanceLetterIndex(state.currentLetterIndex, fineCoverage, progress, ranges, params.letterCoverageThreshold) : state.currentLetterIndex;
        if (childLetterIndex !== state.currentLetterIndex) {
          transitions.push({ fromLetterIndex: state.currentLetterIndex, toLetterIndex: childLetterIndex, atExpansion: expansions });
          lettersCompletedMax = Math.max(lettersCompletedMax, childLetterIndex);
        }

        const child: LetterAwareState = {
          node: edge.to,
          progress,
          cost: state.cost + stepCost,
          length: state.length + edge.length,
          covered: state.covered | coverMaskLocal(state.covered, edge.startProgress, edge.endProgress, loop),
          fineCoverage,
          edgeIds: [...state.edgeIds, edge.id],
          usedUndirected: withKey(used, undirectedKey(edge)),
          usedInterior: state.usedInterior || edge.interior,
          currentLetterIndex: childLetterIndex,
        };
        // The ONLY experimental change to deduplication: currentLetterIndex is appended to the key ONLY in NEW mode. In OLD mode the key is byte-identical to production's own (node, progressBin, coverageBinCount).
        const key = params.mode === 'NEW' ? `${child.node}:${progressBin(child.progress, bins)}:${bitCount(child.covered)}:${child.currentLetterIndex}` : `${child.node}:${progressBin(child.progress, bins)}:${bitCount(child.covered)}`;
        const previous = bestAt.get(key);
        if (previous != null && previous <= child.cost) continue;
        bestAt.set(key, child.cost);
        next.push(child);
      }
    }
    next.sort((a, b) => a.cost - b.cost + 0.15 * (progressBin(b.progress, bins) - progressBin(a.progress, bins)));
    beam = next.slice(0, GRAPH_SHAPE.beamPerBin * 4);
  }

  return { best: bestGoal ?? bestAny, expansions, transitions, lettersCompletedMax };
}

function startStatesLetterAware(directed: Map<string, Directed>, origin: Vec2, target: readonly Vec2[], targetLength: number, loop: boolean, kind: ShapeKind, regions: readonly TargetRegion[], ranges: readonly LetterRangeMask[], params: LetterAwareParams): LetterAwareState[] {
  const prepared: Directed[] = [];
  for (const edge of [...directed.values()]) {
    const startEdge = prepareStartEdge(edge, origin, target, loop);
    if (!startEdge) continue;
    if (startEdge.id !== edge.id) directed.set(startEdge.id, startEdge);
    prepared.push(startEdge);
  }
  const startCost = (edge: Directed) => edgeCost(edge, 0, targetLength, loop, new Set(), kind, regions);
  const ranked = prepared.sort((a, b) => startCost(a) - startCost(b));
  return ranked.slice(0, 24).map((edge) => {
    const fineCoverage = edge.fineCoverageMask;
    const letterIndex = params.mode === 'NEW' && ranges.length > 0 ? advanceLetterIndex(0, fineCoverage, edge.endProgress, ranges, params.letterCoverageThreshold) : 0;
    return {
      node: edge.to,
      progress: edge.endProgress,
      cost: startCost(edge),
      length: edge.length,
      covered: coverMaskLocal(0, edge.startProgress, edge.endProgress, loop),
      fineCoverage,
      edgeIds: [edge.id],
      usedUndirected: new Set([undirectedKey(edge)]),
      usedInterior: edge.interior,
      currentLetterIndex: letterIndex,
    };
  });
}

export type LetterAwareResult = {
  result: GraphShapeResult;
  expansions: number;
  transitions: LetterTransitionEvent[];
  lettersCompletedMax: number;
  finalCurrentLetterIndex: number;
};

export function traceLetterAwareBeam(
  input: { word: string; target: readonly Vec2[]; graph: ShapeGraph; kind?: ShapeKind; multiLetter?: boolean; geometryVariant?: 'smooth' | 'angular' | 'hybrid' },
  params: LetterAwareParams,
): LetterAwareResult {
  const kind = input.kind ?? 'generic';
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const regions = input.multiLetter && kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, target);
  const emptySearch = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount: 0, statesExplored: 0 };
  const emptyReturn: LetterAwareResult = { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_graph', regions, emptySearch, null, null), expansions: 0, transitions: [], lettersCompletedMax: 0, finalCurrentLetterIndex: 0 };

  if (target.length < 2 || targetLength <= 0 || input.graph.segments.length === 0) return emptyReturn;

  const wordShape = buildWalkableWordShape(input.word, { letterVariant: input.geometryVariant ?? 'smooth' });
  const boundarySet = letterBoundariesFromWordShape(wordShape);
  const ranges = buildLetterRangeMasks(boundarySet.boundaries);

  const loop = kind === 'O' || isClosedTarget(target);
  const coverageThreshold = coverageThresholdMeters(target);
  const directed = explodeDirected(input.graph, target, targetLength, kind, loop, regions, coverageThreshold);
  const candidateEdgeCount = unique([...directed.values()].filter((edge) => !edge.crossing).map((edge) => edge.id.replace(/[><]$/, ''))).length;
  const searchBase = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount, statesExplored: 0 };
  const outgoing = indexOutgoing(directed);
  const origin = target[0] ?? { x: 0, y: 0 };
  const starts = startStatesLetterAware(directed, origin, target, targetLength, loop, kind, regions, ranges, params);
  if (starts.length === 0) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_start_node', regions, searchBase, null, null), expansions: 0, transitions: [], lettersCompletedMax: 0, finalCurrentLetterIndex: 0 };
  }

  const { best, expansions, transitions, lettersCompletedMax } = beamSearchLetterAware(starts, directed, outgoing, targetLength, kind, loop, regions, ranges, params);
  const search = { ...searchBase, statesExplored: expansions };

  if (!best) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'search_exhausted', regions, search, null, null), expansions, transitions, lettersCompletedMax, finalCurrentLetterIndex: 0 };
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
    transitions,
    lettersCompletedMax,
    finalCurrentLetterIndex: best.currentLetterIndex,
  };
}
