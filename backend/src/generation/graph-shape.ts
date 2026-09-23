/**
 * DEVELOPMENT ONLY. Graph-constrained shape router.
 *
 * Searches connected pedestrian street segments for a walk that follows
 * a target letter. Scoring measures FOLLOWING (heading + target-progress
 * span), not mere proximity. Does not snap independent points or call
 * Valhalla /route during search.
 *
 * Connectivity is reconstructed from real graph-edge polylines: two edges
 * meet only when their endpoints snap to the same node. Nearby parallel
 * streets are never joined mid-block.
 */
import {
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
} from '../diagnostics/street-fit';

export const GRAPH_SHAPE_EXPERIMENT = true;

export const GRAPH_SHAPE = {
  corridorMeters: 70,
  nodeSnapMeters: 8,
  followRadiusMeters: 45,
  minFollowMeters: 18,
  minProgressSpanMeters: 10,
  progressBins: 28,
  beamPerBin: 48,
  maxExpansions: 12_000,
  maxRouteFactor: 2.4,
  startProgress: 0.12,
  startRadiusMeters: 55,
  goalProgress: 0.88,
  goalCoverage: 0.62,
} as const;

export type ShapeKind = 'O' | 'Z' | 'L' | 'generic';

export type GraphSegment = {
  id: string;
  wayId: string;
  from: string;
  to: string;
  points: Vec2[];
};

export type ShapeGraph = {
  nodes: Record<string, Vec2>;
  segments: GraphSegment[];
};

export type GraphShapeFailure =
  | 'no_graph'
  | 'no_start_node'
  | 'search_exhausted'
  | 'low_coverage'
  | 'low_follow'
  | 'interior_shortcut'
  | 'too_much_backtrack'
  | 'too_long';

export type GraphShapeFailureReason =
  | 'insufficient aligned streets'
  | 'disconnected candidate paths'
  | 'poor target-progress coverage'
  | 'excessive backtracking'
  | 'excessive route length'
  | 'no viable graph path';

export type GraphShapeMetrics = {
  routeDistanceMeters: number;
  targetDistanceMeters: number;
  distanceRatio: number;
  targetCoverage: number;
  forwardProgress: number;
  meanPerpendicularError: number;
  maxPerpendicularError: number;
  headingAgreement: number;
  headingAgreementDegrees: number;
  progressSpan: number;
  backtracking: number;
  uniqueWays: number;
  repeatedWays: number;
  largestTargetProgressGap: number;
  connected: boolean;
  graphShapeScore: number;
  shapeScore: number;
  graphPathLength: number;
  /** @deprecated use meanPerpendicularError */
  perpendicularError: number;
};

export type GraphShapeSearchStats = {
  graphEdgeCount: number;
  candidateEdgeCount: number;
  statesExplored: number;
};

/**
 * Optional completion-aware goal support (multi-letter words only). When
 * provided, routeGraphConstrainedShape keeps the exact production search and
 * production-selected route (the cheapest goal), and additionally:
 *  - goal-checks the states left in the final beam when the expansion cap
 *    ends the search (they are never expanded, so were never checked);
 *  - treats a state whose FINAL letter is physically complete and traversed
 *    in word order, with search coverage >= goalCoverage, as a
 *    completion-aware goal even when its progress is < goalProgress (this
 *    never changes which states are ordinary goals);
 *  - prefers the cheapest completion-aware goal, else the cheapest goal;
 *  - returns that candidate only if acceptCandidate() (the nine guards)
 *    accepts it against the production-selected route, otherwise returns
 *    the production-selected route unchanged.
 * Goal logic never affects expansion, so the search itself is identical.
 */
export type CompletionAwareGoalSupport = {
  /** True when the path's final letter is physically complete AND traversed in word order. */
  finalLetterCompleteInOrder(pathPoints: readonly Vec2[]): boolean;
  /** Nine-guard verdict: may `candidate` replace the production-selected `baseline`? */
  acceptCandidate(baseline: GraphShapeResult, candidate: GraphShapeResult): boolean;
};

export type GraphShapeResult = {
  kind: ShapeKind;
  pathPoints: Vec2[];
  edgeIds: string[];
  wayIds: string[];
  waySequence: string[];
  metrics: GraphShapeMetrics;
  failure: GraphShapeFailure | null;
  failureReason: GraphShapeFailureReason | null;
  startNode: string | null;
  endNode: string | null;
  transitions: Vec2[];
  regions: TargetRegion[];
  search: GraphShapeSearchStats;
};

export function snapNodeId(point: Vec2, snapMeters = GRAPH_SHAPE.nodeSnapMeters): string {
  return `${Math.round(point.x / snapMeters) * snapMeters},${Math.round(point.y / snapMeters) * snapMeters}`;
}

export function buildShapeGraph(segments: Array<Omit<GraphSegment, 'from' | 'to'> & { from?: string; to?: string }>): ShapeGraph {
  const nodes: Record<string, Vec2> = {};
  const built: GraphSegment[] = [];
  for (const segment of segments) {
    if (segment.points.length < 2) {
      continue;
    }
    const start = segment.points[0] as Vec2;
    const end = segment.points[segment.points.length - 1] as Vec2;
    const from = segment.from ?? snapNodeId(start);
    const to = segment.to ?? snapNodeId(end);
    nodes[from] = nodes[from] ?? { ...start };
    nodes[to] = nodes[to] ?? { ...end };
    built.push({
      id: segment.id,
      wayId: segment.wayId,
      from,
      to,
      points: segment.points.map((point) => ({ ...point })),
    });
  }
  return { nodes, segments: built };
}

export function isClosedTarget(target: readonly Vec2[], relativeEpsilon = 0.04): boolean {
  const first = target[0];
  const last = target[target.length - 1];
  if (!first || !last || target.length < 4) {
    return false;
  }
  const length = polylineLength(target);
  if (length <= 0) {
    return false;
  }
  return Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(length * relativeEpsilon, 1e-6);
}

export function regionsFromTargetCorners(
  target: readonly Vec2[],
  minTurnDegrees = 45,
): TargetRegion[] {
  const length = polylineLength(target);
  if (length <= 0 || target.length < 3) {
    return [{ id: 'shape', startProgress: 0, endProgress: 1 }];
  }
  const splits = [0];
  let traveled = 0;
  for (let index = 1; index < target.length - 1; index += 1) {
    const previous = target[index - 1];
    const current = target[index];
    const next = target[index + 1];
    if (!previous || !current || !next) {
      continue;
    }
    traveled += Math.hypot(current.x - previous.x, current.y - previous.y);
    const turn = Math.abs(shortestAngleDelta(headingRadians(previous, current), headingRadians(current, next)));
    if (turn >= (minTurnDegrees * Math.PI) / 180 && traveled / length >= 0.08 && traveled / length <= 0.92) {
      const progress = traveled / length;
      const last = splits[splits.length - 1] ?? 0;
      if (progress - last >= 0.08) {
        splits.push(progress);
      }
    }
  }
  splits.push(1);
  if (splits.length <= 2) {
    return [{ id: 'shape', startProgress: 0, endProgress: 1 }];
  }
  return splits.slice(0, -1).map((start, index) => ({
    id: `seg-${index + 1}`,
    startProgress: start,
    endProgress: splits[index + 1] ?? 1,
  }));
}

export function regionsForKind(kind: ShapeKind, target: readonly Vec2[]): TargetRegion[] {
  const length = polylineLength(target);
  if (length <= 0) {
    return [{ id: 'shape', startProgress: 0, endProgress: 1 }];
  }
  if (kind === 'O' || isClosedTarget(target)) {
    return [{ id: 'loop', startProgress: 0, endProgress: 1 }];
  }
  if (kind === 'L' && target.length >= 3) {
    const vertical = polylineLength(target.slice(0, 2));
    const split = clamp01(vertical / length);
    return [
      { id: 'vertical', startProgress: 0, endProgress: split },
      { id: 'horizontal', startProgress: split, endProgress: 1 },
    ];
  }
  if (kind === 'Z' && target.length >= 4) {
    const top = polylineLength(target.slice(0, 2));
    const diagonal = polylineLength(target.slice(1, 3));
    const topEnd = clamp01(top / length);
    const diagonalEnd = clamp01((top + diagonal) / length);
    return [
      { id: 'top', startProgress: 0, endProgress: topEnd },
      { id: 'diagonal', startProgress: topEnd, endProgress: diagonalEnd },
      { id: 'bottom', startProgress: diagonalEnd, endProgress: 1 },
    ];
  }
  return regionsFromTargetCorners(target);
}

export function routeGraphConstrainedShape(input: {
  target: readonly Vec2[];
  graph: ShapeGraph;
  kind?: ShapeKind;
  multiLetter?: boolean;
  /** Completion-aware goal selection with nine-guard fallback (see CompletionAwareGoalSupport). Omit for production cheapest-goal behavior. */
  completionAware?: CompletionAwareGoalSupport;
}): GraphShapeResult {
  const kind = input.kind ?? 'generic';
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const regions =
    input.multiLetter && kind === 'generic'
      ? [{ id: 'shape', startProgress: 0, endProgress: 1 }]
      : regionsForKind(kind, target);
  const emptySearch = { graphEdgeCount: input.graph.segments.length, candidateEdgeCount: 0, statesExplored: 0 };

  if (target.length < 2 || targetLength <= 0) {
    return resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_graph', regions, emptySearch, null, null);
  }
  if (input.graph.segments.length === 0) {
    return resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'no_graph', regions, emptySearch, null, null);
  }

  const loop = kind === 'O' || isClosedTarget(target);
  const directed = explodeDirected(input.graph, target, targetLength, kind, loop, regions);
  const candidateEdgeCount = unique(
    [...directed.values()].filter((edge) => !edge.crossing).map((edge) => edge.id.replace(/[><]$/, '')),
  ).length;
  const searchBase = {
    graphEdgeCount: input.graph.segments.length,
    candidateEdgeCount,
    statesExplored: 0,
  };
  const outgoing = indexOutgoing(directed);
  const origin = target[0] ?? { x: 0, y: 0 };
  const starts = startStates(directed, origin, target, targetLength, loop, kind, regions);
  if (starts.length === 0) {
    return resultOf(
      kind,
      [],
      [],
      [],
      emptyMetrics(targetLength, false),
      'no_start_node',
      regions,
      searchBase,
      null,
      null,
    );
  }

  const completionAware = input.completionAware && input.multiLetter && kind === 'generic' && !loop ? input.completionAware : undefined;
  const retained: RetainedSearch | undefined = completionAware ? { goals: [], visited: [], finalBeam: [], sequence: new Map() } : undefined;
  const { best, expansions } = beamSearch(starts, directed, outgoing, targetLength, kind, loop, regions, retained);
  const search = { ...searchBase, statesExplored: expansions };
  if (!best) {
    return resultOf(kind, [], [], [], emptyMetrics(targetLength, false), 'search_exhausted', regions, search, null, null);
  }

  const baseline = resultForState(best, directed, target, kind, loop, regions, search);
  if (!completionAware || !retained) {
    return baseline;
  }
  const candidate = selectCompletionAwareGoal(retained, best, directed, kind, loop, completionAware);
  if (candidate === best) {
    return baseline;
  }
  const candidateResult = resultForState(candidate, directed, target, kind, loop, regions, search);
  return completionAware.acceptCandidate(baseline, candidateResult) ? candidateResult : baseline;
}

/** The production result tail for a selected state (unchanged; factored out so a completion-aware candidate is evaluated exactly like the production pick). */
function resultForState(
  best: SearchState,
  directed: Map<string, Directed>,
  target: readonly Vec2[],
  kind: ShapeKind,
  loop: boolean,
  regions: TargetRegion[],
  search: GraphShapeSearchStats,
): GraphShapeResult {
  const pathPoints = polylineFromEdges(best.edgeIds, directed);
  const waySequence = best.edgeIds
    .map((id) => directed.get(id)?.wayId)
    .filter((id): id is string => Boolean(id));
  const wayIds = unique(waySequence);
  const connected = pathIsConnected(best.edgeIds, directed);
  const computed = metricsFromPath(pathPoints, target, waySequence, connected, loop);
  const startNode = directed.get(best.edgeIds[0] ?? '')?.from ?? null;
  const endNode = directed.get(best.edgeIds[best.edgeIds.length - 1] ?? '')?.to ?? null;
  let failure = classifyFailure(computed, loop, best.usedInterior);
  if (kind === 'O' && !oLoopClosed(pathPoints, startNode, endNode)) {
    failure = 'low_coverage';
  }
  return resultOf(
    kind,
    pathPoints,
    best.edgeIds,
    wayIds,
    computed,
    failure,
    regions,
    search,
    startNode,
    endNode,
    waySequence,
    transitionsFromEdges(best.edgeIds, directed),
  );
}

type Directed = GraphSegment & {
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

type SearchState = {
  node: string;
  progress: number;
  cost: number;
  length: number;
  covered: number;
  edgeIds: string[];
  usedUndirected: Set<string>;
  usedInterior: boolean;
};

function explodeDirected(
  graph: ShapeGraph,
  target: readonly Vec2[],
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  regions: readonly TargetRegion[],
): Map<string, Directed> {
  const centroid = meanPoint(target);
  const ringRadius = mean(target.map((point) => Math.hypot(point.x - centroid.x, point.y - centroid.y)));
  const directed = new Map<string, Directed>();

  for (const segment of graph.segments) {
    const forwardId = `${segment.id}>`;
    const reverseId = `${segment.id}<`;
    const reversePoints = [...segment.points].reverse();
    directed.set(
      forwardId,
      analyzeDirected(segment, forwardId, reverseId, segment.points, target, targetLength, kind, loop, centroid, ringRadius),
    );
    directed.set(
      reverseId,
      analyzeDirected(
        { ...segment, from: segment.to, to: segment.from },
        reverseId,
        forwardId,
        reversePoints,
        target,
        targetLength,
        kind,
        loop,
        centroid,
        ringRadius,
      ),
    );
  }
  void regions;
  return directed;
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
    if (!previous) {
      return null;
    }
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

function startStates(
  directed: Map<string, Directed>,
  origin: Vec2,
  target: readonly Vec2[],
  targetLength: number,
  loop: boolean,
  kind: ShapeKind,
  regions: readonly TargetRegion[],
): SearchState[] {
  const prepared: Directed[] = [];
  for (const edge of [...directed.values()]) {
    const startEdge = prepareStartEdge(edge, origin, target, loop);
    if (!startEdge) {
      continue;
    }
    if (startEdge.id !== edge.id) {
      directed.set(startEdge.id, startEdge);
    }
    prepared.push(startEdge);
  }
  const ranked = prepared.sort(
    (a, b) =>
      edgeCost(a, 0, targetLength, loop, new Set(), kind, regions) -
      edgeCost(b, 0, targetLength, loop, new Set(), kind, regions),
  );
  return ranked.slice(0, 24).map((edge) => ({
    node: edge.to,
    progress: edge.endProgress,
    cost: edgeCost(edge, 0, targetLength, loop, new Set(), kind, regions),
    length: edge.length,
    covered: coverMask(0, edge.startProgress, edge.endProgress, loop),
    edgeIds: [edge.id],
    usedUndirected: new Set([undirectedKey(edge)]),
    usedInterior: edge.interior,
  }));
}

function prepareStartEdge(edge: Directed, origin: Vec2, target: readonly Vec2[], loop: boolean): Directed | null {
  if (edge.crossing && edge.followMeters < 8) {
    return null;
  }
  if (edge.meanPerp > GRAPH_SHAPE.corridorMeters) {
    return null;
  }
  const fromPoint = edge.points[0];
  if (!fromPoint) {
    return null;
  }
  const distFrom = Math.hypot(fromPoint.x - origin.x, fromPoint.y - origin.y);
  const hit = projectPointOnPolyline(origin, edge.points);
  const nearFrom = distFrom <= GRAPH_SHAPE.startRadiusMeters;
  const nearGeom = hit.distance <= GRAPH_SHAPE.startRadiusMeters;
  if (!nearFrom && !nearGeom) {
    return null;
  }

  if (nearFrom) {
    if (edge.startProgress > GRAPH_SHAPE.startProgress && !(loop && edge.startProgress > 0.9)) {
      return null;
    }
    return edge;
  }

  const progress = projectOntoTarget(hit.point, target).progress;
  if (progress > GRAPH_SHAPE.startProgress && !(loop && progress > 0.9)) {
    return null;
  }
  const trimmed = trimPolylineFrom(edge.points, hit);
  if (trimmed.length < 2 || polylineLength(trimmed) < 4) {
    return null;
  }
  return {
    ...edge,
    id: `${edge.id}#start`,
    from: snapNodeId(hit.point),
    points: trimmed,
    length: polylineLength(trimmed),
    startProgress: progress,
  };
}

function trimPolylineFrom(
  points: Vec2[],
  hit: { point: Vec2; segmentIndex: number },
): Vec2[] {
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

function beamSearch(
  starts: SearchState[],
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
  regions: readonly TargetRegion[],
  retained?: RetainedSearch,
): { best: SearchState | null; expansions: number } {
  const bins = GRAPH_SHAPE.progressBins;
  const bestAt = new Map<string, number>();
  let beam = starts;
  let bestGoal: SearchState | null = null;
  let bestAny: SearchState | null = starts[0] ?? null;
  let expansions = 0;
  let sequence = 0;
  if (retained) {
    for (const start of starts) {
      retained.sequence.set(start, sequence);
      sequence += 1;
    }
  }

  while (beam.length > 0 && expansions < GRAPH_SHAPE.maxExpansions) {
    const next: SearchState[] = [];
    for (const state of beam) {
      if (!bestAny || betterState(state, bestAny, bins)) {
        bestAny = state;
      }
      const goal = isGoal(state, bins, kind, loop, directed);
      if (goal && (!bestGoal || state.cost < bestGoal.cost)) {
        bestGoal = state;
      }
      if (retained) {
        (goal ? retained.goals : retained.visited).push(state);
      }
      const edges = outgoing.get(state.node) ?? [];
      for (const edge of edges) {
        expansions += 1;
        if (state.edgeIds.includes(edge.id) || state.edgeIds.includes(edge.reverseId)) {
          continue;
        }
        if (state.usedUndirected.has(undirectedKey(edge))) {
          continue;
        }
        if (state.length + edge.length > targetLength * GRAPH_SHAPE.maxRouteFactor) {
          continue;
        }
        const used = new Set(state.usedUndirected);
        const stepCost = edgeCost(edge, state.progress, targetLength, loop, used, kind, regions);
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
        };
        if (retained) {
          retained.sequence.set(child, sequence);
          sequence += 1;
        }
        const key = `${child.node}:${progressBin(child.progress, bins)}:${bitCount(child.covered)}`;
        const previous = bestAt.get(key);
        if (previous != null && previous <= child.cost) {
          continue;
        }
        bestAt.set(key, child.cost);
        next.push(child);
      }
    }
    next.sort((a, b) => a.cost - b.cost + 0.15 * (progressBin(b.progress, bins) - progressBin(a.progress, bins)));
    beam = next.slice(0, GRAPH_SHAPE.beamPerBin * 4);
  }

  if (retained && beam.length > 0) {
    // The expansion cap ended the search: this beam was built but never expanded, so never goal-checked.
    retained.finalBeam = beam;
  }
  return { best: bestGoal ?? bestAny, expansions };
}

/** States kept for completion-aware goal selection (only when CompletionAwareGoalSupport is provided). */
type RetainedSearch = {
  /** Beam states that passed isGoal, in goal-check order. */
  goals: SearchState[];
  /** Beam states that were goal-checked and did not pass isGoal. */
  visited: SearchState[];
  /** The final beam left unexpanded when the expansion cap ended the search (empty if the beam was exhausted). */
  finalBeam: SearchState[];
  /** Creation order of every state (starts first), used only to break exact cost ties deterministically. */
  sequence: Map<SearchState, number>;
};

/**
 * Completion-aware goal selection over the retained search:
 *  ordinary goals = goal-checked goals ∪ final-beam states that pass isGoal;
 *  completion-aware goals = ordinary goals, plus goal-checked or final-beam
 *  states with search coverage >= goalCoverage, whose final letter is
 *  physically complete and in word order.
 * Returns the cheapest completion-aware goal, else the cheapest ordinary goal,
 * else the production pick. Ties: creation order.
 */
function selectCompletionAwareGoal(
  retained: RetainedSearch,
  best: SearchState,
  directed: Map<string, Directed>,
  kind: ShapeKind,
  loop: boolean,
  support: CompletionAwareGoalSupport,
): SearchState {
  const bins = GRAPH_SHAPE.progressBins;
  const order = (a: SearchState, b: SearchState) => a.cost - b.cost || (retained.sequence.get(a) ?? 0) - (retained.sequence.get(b) ?? 0);
  const finalBeamGoals: SearchState[] = [];
  const completionOnly: SearchState[] = [];
  for (const state of retained.finalBeam) {
    if (isGoal(state, bins, kind, loop, directed)) {
      finalBeamGoals.push(state);
    } else if (bitCount(state.covered) / bins >= GRAPH_SHAPE.goalCoverage) {
      completionOnly.push(state);
    }
  }
  for (const state of retained.visited) {
    if (bitCount(state.covered) / bins >= GRAPH_SHAPE.goalCoverage) {
      completionOnly.push(state);
    }
  }
  const ordinary = [...retained.goals, ...finalBeamGoals].sort(order);
  const candidates = [...ordinary, ...completionOnly].sort(order);
  for (const state of candidates) {
    if (support.finalLetterCompleteInOrder(polylineFromEdges(state.edgeIds, directed))) {
      return state;
    }
  }
  return ordinary[0] ?? best;
}

function betterState(candidate: SearchState, current: SearchState, bins: number): boolean {
  const coverDelta = bitCount(candidate.covered) - bitCount(current.covered);
  if (coverDelta !== 0) {
    return coverDelta > 0;
  }
  if (progressBin(candidate.progress, bins) !== progressBin(current.progress, bins)) {
    return progressBin(candidate.progress, bins) > progressBin(current.progress, bins);
  }
  return candidate.cost < current.cost;
}

function edgeCost(
  edge: Directed,
  currentProgress: number,
  targetLength: number,
  loop: boolean,
  used: Set<string>,
  kind: ShapeKind,
  regions: readonly TargetRegion[],
): number {
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
  return (
    4 +
    perp +
    heading +
    back * 140 +
    skip * 90 +
    detour * 0.22 +
    crossing +
    interior +
    repeat +
    reverseWalk +
    regionSkip +
    followBonus +
    overlapBonus
  );
}

function regionSkipPenalty(
  _kind: ShapeKind,
  from: number,
  to: number,
  regions: readonly TargetRegion[],
): number {
  if (regions.length < 2) {
    return 0;
  }
  const a = regionIndex(from, regions);
  const b = regionIndex(to, regions);
  if (b < a) {
    return 40;
  }
  if (b > a + 1) {
    return 24;
  }
  return 0;
}

function regionIndex(progress: number, regions: readonly TargetRegion[]): number {
  const index = regions.findIndex((region) => progress >= region.startProgress && progress <= region.endProgress);
  return index < 0 ? regions.length - 1 : index;
}

function isGoal(
  state: SearchState,
  bins: number,
  kind: ShapeKind,
  loop: boolean,
  directed: Map<string, Directed>,
): boolean {
  const coverage = bitCount(state.covered) / bins;
  if (coverage < GRAPH_SHAPE.goalCoverage) {
    return false;
  }
  if (kind === 'O') {
    return coverage >= 0.7 && oStateClosed(state, directed);
  }
  if (loop) {
    return coverage >= 0.7;
  }
  if (state.progress < GRAPH_SHAPE.goalProgress) {
    return false;
  }
  return true;
}

function oStateClosed(state: SearchState, directed: Map<string, Directed>): boolean {
  const first = directed.get(state.edgeIds[0] ?? '');
  const last = directed.get(state.edgeIds[state.edgeIds.length - 1] ?? '');
  if (!first || !last) {
    return false;
  }
  if (first.from === last.to) {
    return true;
  }
  const start = first.points[0];
  const end = last.points[last.points.length - 1];
  if (!start || !end) {
    return false;
  }
  return Math.hypot(start.x - end.x, start.y - end.y) <= GRAPH_SHAPE.nodeSnapMeters;
}

function oLoopClosed(
  pathPoints: readonly Vec2[],
  startNode: string | null,
  endNode: string | null,
): boolean {
  if (startNode != null && startNode === endNode) {
    return true;
  }
  const first = pathPoints[0];
  const last = pathPoints[pathPoints.length - 1];
  if (!first || !last) {
    return false;
  }
  return Math.hypot(first.x - last.x, first.y - last.y) <= GRAPH_SHAPE.nodeSnapMeters;
}

function metricsFromPath(
  path: Vec2[],
  target: readonly Vec2[],
  waySequence: string[],
  connected: boolean,
  loop: boolean,
): GraphShapeMetrics {
  const targetLength = polylineLength(target);
  const routeLength = polylineLength(path);
  const uniqueWays = unique(waySequence).length;
  const repeatedWays = countWayRevisits(waySequence);
  if (path.length < 2) {
    return emptyMetrics(targetLength, false);
  }
  const sampled = resamplePolyline(path, 48);
  const sampledTarget = resamplePolyline(target, 48);
  const perps = sampled.map((point) => projectOntoTarget(point, target).perpendicularDistance);
  const headings = sampled.slice(1).map((point, index) => {
    const previous = sampled[index];
    if (!previous) {
      return 0;
    }
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
    0.26 * gaps.coverage +
      0.2 * fwd +
      0.16 * heading +
      0.14 * progressSpan +
      0.08 * (1 - Math.min(1, meanPerp / 50)) +
      0.06 * (connected ? 1 : 0) -
      0.12 * (1 - fwd) -
      0.08 * Math.min(1, repeatedWays / 4) -
      0.06 * Math.min(1, Math.abs(distanceRatio - 1)),
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
  if (metrics.routeDistanceMeters <= 0) {
    return 'search_exhausted';
  }
  if (usedInterior && loop) {
    return 'interior_shortcut';
  }
  if (metrics.targetCoverage < 0.55) {
    return 'low_coverage';
  }
  if (metrics.progressSpan < 0.5) {
    return 'low_coverage';
  }
  if (metrics.headingAgreement < 0.35) {
    return 'low_follow';
  }
  if (metrics.backtracking > 0.45) {
    return 'too_much_backtrack';
  }
  if (metrics.distanceRatio > 2.2) {
    return 'too_long';
  }
  return null;
}

export function qualitativeFailureReason(failure: GraphShapeFailure | null): GraphShapeFailureReason | null {
  if (failure == null) {
    return null;
  }
  switch (failure) {
    case 'low_follow':
      return 'insufficient aligned streets';
    case 'no_start_node':
      return 'disconnected candidate paths';
    case 'low_coverage':
    case 'interior_shortcut':
      return 'poor target-progress coverage';
    case 'too_much_backtrack':
      return 'excessive backtracking';
    case 'too_long':
      return 'excessive route length';
    case 'no_graph':
    case 'search_exhausted':
    default:
      return 'no viable graph path';
  }
}

function sampleEdge(points: Vec2[], count: number): Vec2[] {
  if (points.length <= count) {
    return points.map((point) => ({ ...point }));
  }
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
    if (!edge) {
      continue;
    }
    const add = points.length === 0 ? edge.points : edge.points.slice(1);
    points.push(...add.map((point) => ({ ...point })));
  }
  return points;
}

function pathIsConnected(edgeIds: string[], directed: Map<string, Directed>): boolean {
  if (edgeIds.length === 0) {
    return false;
  }
  for (let index = 1; index < edgeIds.length; index += 1) {
    const previous = directed.get(edgeIds[index - 1] ?? '');
    const current = directed.get(edgeIds[index] ?? '');
    if (!previous || !current || previous.to !== current.from) {
      return false;
    }
  }
  return true;
}

function transitionsFromEdges(edgeIds: string[], directed: Map<string, Directed>): Vec2[] {
  const points: Vec2[] = [];
  let previousWay: string | null = null;
  for (const id of edgeIds) {
    const edge = directed.get(id);
    if (!edge) {
      continue;
    }
    if (previousWay != null && previousWay !== edge.wayId) {
      const joint = edge.points[0];
      if (joint) {
        points.push({ ...joint });
      }
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
      if (progress <= a || progress >= b) {
        mask |= 1 << index;
      }
    }
    return mask;
  }
  const steps = Math.max(2, Math.round((b - a) * bins));
  for (let index = 0; index <= steps; index += 1) {
    mark(a + ((b - a) * index) / steps);
  }
  return mask;
}

function progressGain(from: number, to: number, loop: boolean): number {
  let delta = to - from;
  if (loop) {
    if (delta < -0.5) {
      delta += 1;
    }
    if (delta > 0.5) {
      delta -= 1;
    }
  }
  return delta;
}

function forwardRatioLoop(progresses: readonly number[]): number | null {
  if (progresses.length < 2) {
    return null;
  }
  let forward = 0;
  let backward = 0;
  for (let index = 1; index < progresses.length; index += 1) {
    const gain = progressGain(progresses[index - 1] ?? 0, progresses[index] ?? 0, true);
    if (gain > 1e-6) {
      forward += gain;
    } else if (gain < -1e-6) {
      backward += -gain;
    }
  }
  const total = forward + backward;
  return total === 0 ? null : forward / total;
}

function pathProgressSpan(progresses: readonly number[], loop: boolean): number {
  if (progresses.length === 0) {
    return 0;
  }
  if (!loop) {
    return clamp01(Math.max(...progresses) - Math.min(...progresses));
  }
  const sorted = [...progresses].sort((a, b) => a - b);
  let maxGap = sorted[0]! + 1 - (sorted[sorted.length - 1] ?? 1);
  for (let index = 1; index < sorted.length; index += 1) {
    maxGap = Math.max(maxGap, (sorted[index] ?? 0) - (sorted[index - 1] ?? 0));
  }
  return clamp01(1 - maxGap);
}

function wrapProgress(progress: number): number {
  if (progress < 0) {
    return progress + 1;
  }
  if (progress > 1) {
    return progress - 1;
  }
  return progress;
}

function progressBin(progress: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(clamp01(progress) * bins)));
}

function undirectedKey(edge: { id: string; reverseId: string }): string {
  const clean = (value: string) => value.replace(/#start$/, '').replace(/[><]$/, '');
  return [clean(edge.id), clean(edge.reverseId)].sort().join('~');
}

function withKey(used: Set<string>, key: string): Set<string> {
  used.add(key);
  return used;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function countWayRevisits(sequence: string[]): number {
  const seen = new Set<string>();
  let previous: string | null = null;
  let revisits = 0;
  for (const way of sequence) {
    if (way === previous) {
      continue;
    }
    if (seen.has(way)) {
      revisits += 1;
    }
    seen.add(way);
    previous = way;
  }
  return revisits;
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

function meanPoint(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
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
