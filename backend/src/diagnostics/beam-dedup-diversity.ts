/**
 * DEVELOPMENT ONLY. Shadow experiment: current production beam-state
 * deduplication vs a coverage-aware alternative — never modifies
 * graph-shape.ts, never called from the live route generation path.
 *
 * Production's real deduplication key (confirmed by reading the current
 * graph-shape.ts source directly, beamSearch()):
 *
 *   const key = `${child.node}:${progressBin(child.progress, bins)}:${bitCount(child.covered)}`;
 *   const previous = bestAt.get(key);
 *   if (previous != null && previous <= child.cost) continue;   // rejected
 *   bestAt.set(key, child.cost);
 *
 * i.e. (node, progressBin, coverageBinCount) — two states reaching the
 * same node/progress-bin with the SAME COUNT of covered bins collapse to
 * whichever is cheaper, even if they cover completely different bins.
 * The experimental key used below is (node, progressBin, coveredMask) —
 * the raw 28-bit `covered` integer itself, so states with the same bin
 * COUNT but a different PATTERN of covered bins are no longer collapsed.
 * No other part of the search (edge costs, beam width, expansion cap,
 * sort/tiebreak, start states, graph, target) is touched — this file
 * reuses graph-shape.ts's real GRAPH_SHAPE constants and beam-search-
 * trace.ts's already-parity-verified mirror helpers (explodeDirected,
 * analyzeDirected, startStates, edgeCost, coverMask, progressBin,
 * bitCount, betterState, isGoal, metricsFromPath, etc. — all exported,
 * none re-transcribed here) for everything except the dedup key itself
 * and the loop that applies it.
 */
import { polylineLength, type Vec2 } from '@/lib/geometry';

import {
  betterState,
  bitCount,
  classifyFailure,
  clamp01,
  edgeCost,
  emptyMetrics,
  explodeDirected,
  indexOutgoing,
  isGoal,
  metricsFromPath,
  oLoopClosed,
  pathIsConnected,
  polylineFromEdges,
  positionInsideCorridor,
  progressBin,
  resultOf,
  startStates,
  transitionsFromEdges,
  undirectedKey,
  unique,
  withKey,
  wrapProgress,
  type Directed,
  type LetterCorridor,
  type SearchState,
} from './beam-search-trace';
import { GRAPH_SHAPE, isClosedTarget, regionsForKind, type GraphShapeResult, type ShapeGraph, type ShapeKind } from '../generation/graph-shape';
import { coverageThresholdMeters } from '../generation/target-identity';
import type { TargetRegion } from './street-fit';

export type DedupMode = 'current' | 'coverageAware';

export type DedupCollisionStats = {
  totalDedupAttempts: number;
  totalDedupRejections: number;
  rejectionsIdenticalMask: number;
  rejectionsDifferentMask: number;
  hammingDistances: number[];
  /** node:progressBin -> distinct masks ever produced there across the whole search (regardless of which mode actually drove acceptance). */
  distinctMasksPerGroup: Record<string, number>;
};

function popcount28(value: number): number {
  let count = 0;
  let bits = value >>> 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

function hamming(a: number, b: number): number {
  return popcount28((a ^ b) >>> 0);
}

/**
 * Verbatim mirror of graph-shape.ts's beamSearch(), parameterized ONLY by
 * which dedup key decides real acceptance/rejection. When collectStats is
 * true, ALSO maintains a shadow map with the OTHER key so every real
 * CURRENT-mode rejection can be classified as "the coverage-aware key
 * would also reject this" vs "the coverage-aware key would keep this" —
 * the shadow bookkeeping never influences which states actually survive.
 */
function beamSearchDedup(
  starts: SearchState[],
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  regions: readonly TargetRegion[],
  dedupMode: DedupMode,
  collectStats: boolean,
  corridors: readonly LetterCorridor[],
): { best: SearchState | null; expansions: number; maxBeamSize: number; stats: DedupCollisionStats; everEntered: boolean[]; everSurvivedBeamCut: boolean[] } {
  const bins = GRAPH_SHAPE.progressBins;
  const bestAt = new Map<string, number>();
  // Pure simulation of what CURRENT-mode's own dedup decision would be at each currentKey, updated independently of whichever dedupMode actually drives real acceptance below — this is what lets Step 5's stats be computed identically regardless of dedupMode.
  const currentModeSim = new Map<string, { cost: number; mask: number }>();
  const distinctMasksPerGroup = new Map<string, Set<number>>();
  const everEntered = corridors.map(() => false);
  const everSurvivedBeamCut = corridors.map(() => false);

  let beam = starts;
  let bestGoal: SearchState | null = null;
  let bestAny: SearchState | null = starts[0] ?? null;
  let expansions = 0;
  let maxBeamSize = starts.length;

  const stats: DedupCollisionStats = {
    totalDedupAttempts: 0,
    totalDedupRejections: 0,
    rejectionsIdenticalMask: 0,
    rejectionsDifferentMask: 0,
    hammingDistances: [],
    distinctMasksPerGroup: {},
  };

  while (beam.length > 0 && expansions < GRAPH_SHAPE.maxExpansions) {
    const next: SearchState[] = [];
    const pendingCorridorHits: Array<{ child: SearchState; corridorIndices: number[] }> = [];
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
        const covered = state.covered | coverMaskLocal(state.covered, edge.startProgress, edge.endProgress, loop);
        const child: SearchState = {
          node: edge.to,
          progress,
          cost: state.cost + stepCost,
          length: state.length + edge.length,
          covered,
          fineCoverage: state.fineCoverage,
          edgeIds: [...state.edgeIds, edge.id],
          usedUndirected: withKey(used, undirectedKey(edge)),
          usedInterior: state.usedInterior || edge.interior,
        };

        const bin = progressBin(child.progress, bins);
        const groupKey = `${child.node}:${bin}`;
        if (collectStats) {
          const set = distinctMasksPerGroup.get(groupKey) ?? new Set<number>();
          set.add(child.covered);
          distinctMasksPerGroup.set(groupKey, set);
        }

        const currentKey = `${child.node}:${bin}:${bitCount(child.covered)}`;
        const coverageAwareKey = `${child.node}:${bin}:${child.covered}`;
        const activeKey = dedupMode === 'current' ? currentKey : coverageAwareKey;

        if (collectStats) {
          stats.totalDedupAttempts += 1;
          const simPrevious = currentModeSim.get(currentKey);
          const currentRejects = simPrevious != null && simPrevious.cost <= child.cost;
          if (currentRejects) {
            stats.totalDedupRejections += 1;
            if (simPrevious!.mask === child.covered) {
              stats.rejectionsIdenticalMask += 1;
            } else {
              stats.rejectionsDifferentMask += 1;
              stats.hammingDistances.push(hamming(simPrevious!.mask, child.covered));
            }
          } else {
            currentModeSim.set(currentKey, { cost: child.cost, mask: child.covered });
          }
        }

        // REAL acceptance decision — drives actual search behavior, using whichever key dedupMode selects.
        const previous = bestAt.get(activeKey);
        const rejected = previous != null && previous <= child.cost;
        if (rejected) continue;
        bestAt.set(activeKey, child.cost);
        next.push(child);

        if (corridors.length > 0) {
          const position = edge.points[edge.points.length - 1] ?? { x: 0, y: 0 };
          const hitCorridors: number[] = [];
          corridors.forEach((corridor, index) => {
            if (positionInsideCorridor(position, corridor)) {
              everEntered[index] = true;
              hitCorridors.push(index);
            }
          });
          if (hitCorridors.length > 0) pendingCorridorHits.push({ child, corridorIndices: hitCorridors });
        }
      }
    }

    next.sort((a, b) => a.cost - b.cost + 0.15 * (progressBin(b.progress, bins) - progressBin(a.progress, bins)));
    beam = next.slice(0, GRAPH_SHAPE.beamPerBin * 4);
    maxBeamSize = Math.max(maxBeamSize, beam.length);

    if (pendingCorridorHits.length > 0) {
      const survivedSet = new Set(beam);
      for (const pending of pendingCorridorHits) {
        if (survivedSet.has(pending.child)) {
          for (const index of pending.corridorIndices) everSurvivedBeamCut[index] = true;
        }
      }
    }
  }

  if (collectStats) {
    for (const [key, set] of distinctMasksPerGroup) {
      stats.distinctMasksPerGroup[key] = set.size;
    }
  }

  return { best: bestGoal ?? bestAny, expansions, maxBeamSize, stats, everEntered, everSurvivedBeamCut };
}

/** Verbatim of graph-shape.ts's private coverMask(), reproduced here because it is not exported by beam-search-trace.ts (only the higher-level helpers around it are) — identical formula, GRAPH_SHAPE.progressBins read from the same real constant. */
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

export type DedupTraceOptions = {
  dedupMode: DedupMode;
  collectStats?: boolean;
  corridors?: readonly LetterCorridor[];
};

export type LetterEntrySummary = {
  letter: string;
  everEntered: boolean;
  everSurvivedBeamCut: boolean;
  finalRouteUsesRegion: boolean;
};

/**
 * Mirrors graph-shape.ts's exported routeGraphConstrainedShape() exactly,
 * except the deduplication key is selected by `dedupMode`. At
 * dedupMode='current' this reproduces the real production function
 * byte-identically (proven in the self-test).
 */
export function traceGraphConstrainedShapeDedup(
  input: { target: readonly Vec2[]; graph: ShapeGraph; kind?: ShapeKind; multiLetter?: boolean },
  options: DedupTraceOptions,
): { result: GraphShapeResult; expansions: number; maxBeamSize: number; stats: DedupCollisionStats; letters: LetterEntrySummary[] } {
  const corridors = options.corridors ?? [];
  const kind = input.kind ?? 'generic';
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const regions = input.multiLetter && kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, target);
  const emptySearch = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount: 0, statesExplored: 0 };
  const emptyStats: DedupCollisionStats = { totalDedupAttempts: 0, totalDedupRejections: 0, rejectionsIdenticalMask: 0, rejectionsDifferentMask: 0, hammingDistances: [], distinctMasksPerGroup: {} };
  const emptyLetters = corridors.map((corridor) => ({ letter: corridor.letter, everEntered: false, everSurvivedBeamCut: false, finalRouteUsesRegion: false }));

  if (target.length < 2 || targetLength <= 0 || input.graph.segments.length === 0) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_graph', regions, emptySearch, null, null), expansions: 0, maxBeamSize: 0, stats: emptyStats, letters: emptyLetters };
  }

  const loop = kind === 'O' || isClosedTarget(target);
  const coverageThreshold = coverageThresholdMeters(target);
  const directed = explodeDirected(input.graph, target, targetLength, kind, loop, regions, coverageThreshold);
  const candidateEdgeCount = unique([...directed.values()].filter((edge) => !edge.crossing).map((edge) => edge.id.replace(/[><]$/, ''))).length;
  const searchBase = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount, statesExplored: 0 };
  const outgoing = indexOutgoing(directed);
  const origin = target[0] ?? { x: 0, y: 0 };
  const starts = startStates(directed, origin, target, targetLength, loop, kind, regions, false);
  if (starts.length === 0) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_start_node', regions, searchBase, null, null), expansions: 0, maxBeamSize: 0, stats: emptyStats, letters: emptyLetters };
  }

  const { best, expansions, maxBeamSize, stats, everEntered, everSurvivedBeamCut } = beamSearchDedup(
    starts,
    directed,
    outgoing,
    targetLength,
    kind,
    loop,
    regions,
    options.dedupMode,
    options.collectStats ?? false,
    corridors,
  );
  const search = { ...searchBase, statesExplored: expansions };

  if (!best) {
    return { result: resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'search_exhausted', regions, search, null, null), expansions, maxBeamSize, stats, letters: emptyLetters };
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

  const letters: LetterEntrySummary[] = corridors.map((corridor, index) => ({
    letter: corridor.letter,
    everEntered: everEntered[index] ?? false,
    everSurvivedBeamCut: everSurvivedBeamCut[index] ?? false,
    finalRouteUsesRegion: pathPoints.some((point) => positionInsideCorridor(point, corridor)),
  }));

  return {
    result: resultOf(kind, pathPoints, best.edgeIds, wayIds, computed, failure, regions, search, startNode, endNode, waySequence, transitionsFromEdges(best.edgeIds, directed)),
    expansions,
    maxBeamSize,
    stats,
    letters,
  };
}
