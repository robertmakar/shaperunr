/**
 * DEVELOPMENT ONLY. Graph-constrained shape router.
 *
 * Searches connected pedestrian street segments for a walk that follows
 * a target letter. Does not snap independent points or call Valhalla /route.
 */
import {
  boundingBox2,
  headingRadians,
  polylineLength,
  resamplePolyline,
  type Vec2,
} from '@/lib/geometry';
import { scorePolylines } from '@/lib/shape-match';

import {
  detectCoverageGaps,
  forwardRatio,
  headingAgreement,
  projectOntoTarget,
} from '../diagnostics/street-fit';

export const GRAPH_SHAPE_EXPERIMENT = true;

export const GRAPH_SHAPE = {
  corridorMeters: 70,
  nodeSnapMeters: 8,
  followRadiusMeters: 45,
  minFollowMeters: 18,
  progressBins: 28,
  beamPerBin: 48,
  maxExpansions: 12_000,
  maxRouteFactor: 2.4,
  startProgress: 0.12,
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
  | 'too_much_backtrack';

export type GraphShapeMetrics = {
  routeDistanceMeters: number;
  targetDistanceMeters: number;
  perpendicularError: number;
  headingAgreement: number;
  targetCoverage: number;
  forwardProgress: number;
  backtracking: number;
  uniqueWays: number;
  graphPathLength: number;
  shapeScore: number;
};

export type GraphShapeResult = {
  kind: ShapeKind;
  pathPoints: Vec2[];
  edgeIds: string[];
  wayIds: string[];
  metrics: GraphShapeMetrics;
  failure: GraphShapeFailure | null;
  startNode: string | null;
  endNode: string | null;
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

export function routeGraphConstrainedShape(input: {
  target: readonly Vec2[];
  graph: ShapeGraph;
  kind?: ShapeKind;
}): GraphShapeResult {
  const kind = input.kind ?? 'generic';
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const emptyMetrics = metricsFromPath([], target, []);

  if (target.length < 2 || targetLength <= 0) {
    return resultOf(kind, [], [], [], emptyMetrics, 'no_graph', null, null);
  }
  if (input.graph.segments.length === 0) {
    return resultOf(kind, [], [], [], emptyMetrics, 'no_graph', null, null);
  }

  const directed = explodeDirected(input.graph, target, targetLength, kind);
  const outgoing = indexOutgoing(directed);
  const loop = kind === 'O';
  const origin = target[0] ?? { x: 0, y: 0 };
  const starts = startStates(directed, input.graph.nodes, origin, targetLength, loop, kind);
  if (starts.length === 0) {
    return resultOf(kind, [], [], [], emptyMetrics, 'no_start_node', null, null);
  }

  const best = beamSearch(starts, directed, outgoing, target, targetLength, kind, loop);
  if (!best) {
    return resultOf(kind, [], [], [], emptyMetrics, 'search_exhausted', null, null);
  }

  const pathPoints = polylineFromEdges(best.edgeIds, directed);
  const wayIds = unique(best.edgeIds.map((id) => directed.get(id)?.wayId).filter((id): id is string => Boolean(id)));
  const computed = metricsFromPath(pathPoints, target, wayIds);
  const failure = classifyFailure(computed, kind, best.usedInterior);
  return resultOf(
    kind,
    pathPoints,
    best.edgeIds,
    wayIds,
    computed,
    failure,
    directed.get(best.edgeIds[0] ?? '')?.from ?? null,
    directed.get(best.edgeIds[best.edgeIds.length - 1] ?? '')?.to ?? null,
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
  usedUndirected: string;
  usedInterior: boolean;
};

function explodeDirected(graph: ShapeGraph, target: readonly Vec2[], targetLength: number, kind: ShapeKind): Map<string, Directed> {
  const centroid = meanPoint(target);
  const ringRadius = mean(target.map((point) => Math.hypot(point.x - centroid.x, point.y - centroid.y)));
  const directed = new Map<string, Directed>();

  for (const segment of graph.segments) {
    const forwardId = `${segment.id}>`;
    const reverseId = `${segment.id}<`;
    const reversePoints = [...segment.points].reverse();
    directed.set(forwardId, analyzeDirected(segment, forwardId, reverseId, segment.points, target, targetLength, kind, centroid, ringRadius));
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
        centroid,
        ringRadius,
      ),
    );
  }
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
  centroid: Vec2,
  ringRadius: number,
): Directed {
  const length = polylineLength(points);
  const samples = sampleEdge(points, 6);
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
  const reverseShare = headings.filter((item) => item?.reverse).length / Math.max(headings.length, 1);
  const progresses = projections.map((item) => item.progress);
  const meanPerp = mean(projections.map((item) => item.perpendicularDistance));
  const startProgress = projections[0]?.progress ?? 0;
  const endProgress = projections[projections.length - 1]?.progress ?? startProgress;
  const followMeters = length * headingFit * (meanPerp <= GRAPH_SHAPE.followRadiusMeters ? 1 : 0.15);
  const mid = samples[Math.floor(samples.length / 2)] ?? points[0]!;
  const distCenter = Math.hypot(mid.x - centroid.x, mid.y - centroid.y);
  const interior =
    kind === 'O' && ringRadius > 0 && distCenter < ringRadius * 0.62 && meanPerp > 22;
  const crossing = followMeters < GRAPH_SHAPE.minFollowMeters && headingFit < 0.45;

  return {
    ...segment,
    id,
    reverseId,
    points,
    length,
    meanPerp,
    headingFit,
    forward: forwardRatio(progresses) ?? (endProgress >= startProgress ? 1 : 0),
    startProgress,
    endProgress,
    minProgress: Math.min(...progresses),
    maxProgress: Math.max(...progresses),
    followMeters,
    crossing,
    interior,
  };
}

function startStates(
  directed: Map<string, Directed>,
  nodes: Record<string, Vec2>,
  origin: Vec2,
  targetLength: number,
  loop: boolean,
  kind: ShapeKind,
): SearchState[] {
  const candidates = [...directed.values()].filter((edge) => {
    const from = nodes[edge.from];
    if (!from || Math.hypot(from.x - origin.x, from.y - origin.y) > 32) {
      return false;
    }
    if (edge.startProgress > GRAPH_SHAPE.startProgress && !(loop && edge.startProgress > 0.9)) {
      return false;
    }
    if (edge.crossing && edge.followMeters < 8) {
      return false;
    }
    return edge.meanPerp <= GRAPH_SHAPE.corridorMeters;
  });
  const ranked = candidates.sort(
    (a, b) =>
      edgeCost(a, 0, targetLength, loop, new Set(), kind) - edgeCost(b, 0, targetLength, loop, new Set(), kind),
  );
  return ranked.slice(0, 16).map((edge) => ({
    node: edge.to,
    progress: edge.endProgress,
    cost: edgeCost(edge, 0, targetLength, loop, new Set(), kind),
    length: edge.length,
    covered: coverMask(0, edge.startProgress, edge.endProgress, loop),
    edgeIds: [edge.id],
    usedUndirected: undirectedKey(edge),
    usedInterior: edge.interior,
  }));
}

function beamSearch(
  starts: SearchState[],
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  target: readonly Vec2[],
  targetLength: number,
  kind: ShapeKind,
  loop: boolean,
): SearchState | null {
  const bins = GRAPH_SHAPE.progressBins;
  const bestAt = new Map<string, number>();
  let beam = starts;
  let bestGoal: SearchState | null = null;
  let expansions = 0;

  while (beam.length > 0 && expansions < GRAPH_SHAPE.maxExpansions) {
    const next: SearchState[] = [];
    for (const state of beam) {
      if (isGoal(state, bins, kind) && (!bestGoal || state.cost < bestGoal.cost)) {
        bestGoal = state;
      }
      const edges = outgoing.get(state.node) ?? [];
      for (const edge of edges) {
        expansions += 1;
        if (state.edgeIds.includes(edge.id) || state.edgeIds.includes(edge.reverseId)) {
          continue;
        }
        if (state.length + edge.length > targetLength * GRAPH_SHAPE.maxRouteFactor) {
          continue;
        }
        const used = new Set(state.usedUndirected.split('|').filter(Boolean));
        const stepCost = edgeCost(edge, state.progress, targetLength, loop, used, kind);
        const progress = loop ? wrapProgress(edge.endProgress) : clamp01(edge.endProgress);
        const child: SearchState = {
          node: edge.to,
          progress,
          cost: state.cost + stepCost,
          length: state.length + edge.length,
          covered: state.covered | coverMask(state.covered, edge.startProgress, edge.endProgress, loop),
          edgeIds: [...state.edgeIds, edge.id],
          usedUndirected: [...used, undirectedKey(edge)].join('|'),
          usedInterior: state.usedInterior || edge.interior,
        };
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

  if (bestGoal) {
    return bestGoal;
  }
  beam.sort((a, b) => bitCount(b.covered) - bitCount(a.covered) || a.cost - b.cost);
  return beam[0] ?? null;
}

function edgeCost(
  edge: Directed,
  currentProgress: number,
  targetLength: number,
  loop: boolean,
  used: Set<string>,
  kind: ShapeKind,
): number {
  const gain = progressGain(currentProgress, edge.endProgress, loop);
  const skip = loop
    ? 0
    : Math.max(0, edge.minProgress - currentProgress - 0.1);
  const expected = Math.max(gain, 0.002) * targetLength;
  const detour = Math.max(0, edge.length - expected * 1.85);
  const back = Math.max(0, -gain);
  const crossing = edge.crossing ? 18 + edge.length * 0.35 : 0;
  const interior = edge.interior ? 80 + edge.length * 1.2 : 0;
  const repeat = used.has(undirectedKey(edge)) ? 120 + edge.length : 0;
  const followBonus = -Math.min(edge.followMeters, 80) * 0.12;
  const perp = edge.meanPerp * (0.35 + edge.length / Math.max(targetLength, 1));
  const heading = (1 - edge.headingFit) * (8 + edge.length * 0.08);
  const regionSkip = regionSkipPenalty(kind, currentProgress, edge.endProgress);
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
    regionSkip +
    followBonus
  );
}

function regionSkipPenalty(kind: ShapeKind, from: number, to: number): number {
  if (kind !== 'Z' && kind !== 'L') {
    return 0;
  }
  const parts = kind === 'Z' ? 3 : 2;
  const a = Math.min(parts - 1, Math.floor(from * parts));
  const b = Math.min(parts - 1, Math.floor(to * parts));
  if (b < a) {
    return 40;
  }
  if (b > a + 1) {
    return 24;
  }
  return 0;
}

function isGoal(state: SearchState, bins: number, kind: ShapeKind): boolean {
  const coverage = bitCount(state.covered) / bins;
  if (coverage < GRAPH_SHAPE.goalCoverage) {
    return false;
  }
  if (state.progress < GRAPH_SHAPE.goalProgress && kind !== 'O') {
    return false;
  }
  if (kind === 'O' && coverage < 0.7) {
    return false;
  }
  return true;
}

function metricsFromPath(path: Vec2[], target: readonly Vec2[], wayIds: string[]): GraphShapeMetrics {
  const targetLength = polylineLength(target);
  const routeLength = polylineLength(path);
  if (path.length < 2) {
    return {
      routeDistanceMeters: 0,
      targetDistanceMeters: targetLength,
      perpendicularError: Number.POSITIVE_INFINITY,
      headingAgreement: 0,
      targetCoverage: 0,
      forwardProgress: 0,
      backtracking: 1,
      uniqueWays: 0,
      graphPathLength: 0,
      shapeScore: 0,
    };
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
  const gaps = detectCoverageGaps(
    sampledTarget.map((point) => {
      const distance = Math.min(...sampled.map((routePoint) => Math.hypot(routePoint.x - point.x, routePoint.y - point.y)));
      return distance <= GRAPH_SHAPE.followRadiusMeters ? projectOntoTarget(point, target).progress : -1;
    }).filter((progress) => progress >= 0),
    targetLength,
  );
  const scored = scorePolylines(path, target);
  const fwd = forwardRatio(progresses) ?? 0;
  return {
    routeDistanceMeters: routeLength,
    targetDistanceMeters: targetLength,
    perpendicularError: mean(perps),
    headingAgreement: mean(headings),
    targetCoverage: gaps.coverage,
    forwardProgress: fwd,
    backtracking: 1 - fwd,
    uniqueWays: wayIds.length,
    graphPathLength: Math.max(0, path.length - 1),
    shapeScore: scored.score,
  };
}

function classifyFailure(metrics: GraphShapeMetrics, kind: ShapeKind, usedInterior: boolean): GraphShapeFailure | null {
  if (metrics.routeDistanceMeters <= 0) {
    return 'search_exhausted';
  }
  if (usedInterior && kind === 'O') {
    return 'interior_shortcut';
  }
  if (metrics.targetCoverage < 0.45) {
    return 'low_coverage';
  }
  if (metrics.headingAgreement < 0.35) {
    return 'low_follow';
  }
  if (metrics.backtracking > 0.45) {
    return 'too_much_backtrack';
  }
  return null;
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
  return [edge.id.replace(/[><]$/, ''), edge.reverseId.replace(/[><]$/, '')].sort().join('~');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
  startNode: string | null,
  endNode: string | null,
): GraphShapeResult {
  return { kind, pathPoints, edgeIds, wayIds, metrics, failure, startNode, endNode };
}
