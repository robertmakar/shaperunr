/**
 * DEVELOPMENT ONLY. Checkpoint-anchored graph routing feasibility
 * experiment — never modifies graph-shape.ts, never called from the live
 * route generation path.
 *
 * Question: every prior hypothesis this session (smooth/angular geometry,
 * shared geometry budget, fine physical-coverage reward, coverage-aware
 * dedup, crossing-penalty relaxation, letter-aware beam state machine) has
 * tuned or extended the SAME architecture — a beam search continuously
 * chasing an idealized target polyline through a discrete pedestrian
 * graph. This experiment tests a structurally different architecture
 * instead:
 *
 *   target geometry -> evenly spaced target checkpoints
 *     -> snap each checkpoint to K=3 candidate pedestrian-graph nodes
 *     -> shortest-path route the graph between consecutive checkpoints
 *        (plain Dijkstra by edge length, NOT the shape-aware beam cost)
 *     -> assemble the concatenated route
 *     -> score the assembled route with the EXISTING, unmodified
 *        downstream scoring functions (scorePolylines, analyzeTargetIdentity,
 *        computeInkOnlyOccupancy)
 *
 * If checkpoint routing scores substantially better than the current beam
 * on the same real candidates, that is evidence the pedestrian graph CAN
 * realize the shape and the beam's own search/objective is the limiting
 * factor. If checkpoint routing does no better (or reveals poor snap
 * quality / frequent disconnection), that points to target-to-street
 * projection or graph topology as the more fundamental limitation.
 *
 * Confirmed directly from source for this task (Step 1):
 * 1. ShapeGraph = { nodes: Record<string, Vec2>, segments: GraphSegment[] }
 *    (graph-shape.ts) — nodes are keyed by snapNodeId() (8m snap-rounded
 *    coordinate string), segments carry from/to node ids and their own
 *    polyline. This is the SAME graph every other diagnostic this session
 *    reconstructs from FeasibilityRecord.graphLines via buildShapeGraph().
 * 2. Graph nodes near a target point: no existing helper does this
 *    (production only ever snaps a SINGLE start point via snapSearchOrigin,
 *    a Valhalla-backed operation, not a local graph-node lookup) — this
 *    experiment's snapCheckpointToGraph() is new, local, read-only
 *    (Object.entries(graph.nodes) distance scan), never touches Valhalla
 *    and never mutates the graph.
 * 3. Existing Valhalla routing (routing/valhalla.ts) is used ONLY for the
 *    start connector leg in production/pipeline code; the graph itself
 *    (once collected) is routed locally. This experiment follows the same
 *    pattern: no new Valhalla calls, pure local graph search.
 * 4. Existing connectivity search: findShortestConnectingPath
 *    (letter-transition-diagnostic.ts) is already a shape-cost-agnostic,
 *    multi-source Dijkstra-by-edge-length over the SAME Directed/outgoing
 *    structures explodeDirected()/indexOutgoing() (beam-search-trace.ts)
 *    build from a ShapeGraph — reused here VERBATIM as the "route between
 *    two explicit anchors" primitive (Step 6 explicitly forbids
 *    reimplementing the shape-aware beam objective for this).
 *
 * This file adds:
 * 1. buildTargetCheckpoints — N evenly spaced points along the target
 *    (via the existing resamplePolyline, exactly how target-identity.ts
 *    itself resamples), each tagged with its own progress and (if inside
 *    a letter's already-established projected range) letter identity.
 * 2. snapCheckpointToGraph — K=3 nearest graph nodes per checkpoint,
 *    read-only distance scan over the existing graph's own nodes.
 * 3. evaluateSegmentRoute — routes one checkpoint pair via the existing,
 *    unmodified findShortestConnectingPath, then measures the resulting
 *    sub-path against the target using existing helpers (projectOntoTarget,
 *    headingAgreement, headingRadians) — no new distance/heading formula.
 * 4. searchCheckpointRoute — a small beam (width 8, per Step 9) over which
 *    of the K snap candidates to commit to at each checkpoint, ranking
 *    partial sequences by (connected, then accumulated route distance).
 * 5. traceCheckpointRoute — the top-level entry point: builds checkpoints,
 *    snaps them, runs the beam, assembles the route via the existing
 *    polylineFromEdges (already dedupes shared junction points between
 *    consecutive edges), and returns it alongside full diagnostics. Scoring
 *    itself is left to the caller (run.ts), which reuses the EXISTING,
 *    unmodified scorePolylines/analyzeTargetIdentity/computeInkOnlyOccupancy
 *    — no new score is invented here (Step 8).
 */
import { distanceToPolyline, headingRadians, polylineLength, resamplePolyline, type Vec2 } from '@/lib/geometry';

import {
  explodeDirected,
  indexOutgoing,
  polylineFromEdges,
  type Directed,
} from './beam-search-trace';
import { findShortestConnectingPath, type ConnectivityPath } from './letter-transition-diagnostic';
import { headingAgreement, projectOntoTarget, type TargetRegion } from './street-fit';
import { isClosedTarget, regionsForKind, type ShapeGraph, type ShapeKind } from '../generation/graph-shape';
import { coverageThresholdMeters } from '../generation/target-identity';
import type { LetterBoundary } from './multi-letter-trace';

export const CHECKPOINT_VARIANTS = { C8: 8, C12: 12, C16: 16 } as const;
export type CheckpointVariantKey = keyof typeof CHECKPOINT_VARIANTS;

export const CHECKPOINT_SNAP_K = 3;
export const CHECKPOINT_BEAM_WIDTH = 8;
/** Small local tolerance for "moved backward in target progress" — diagnostic bookkeeping only, never fed into any score. */
const BACKWARD_PROGRESS_EPSILON = 0.01;

// ---------------------------------------------------------------------------
// Step 3 — target checkpoints
// ---------------------------------------------------------------------------

export type TargetCheckpoint = {
  index: number;
  targetProgress: number;
  targetCoordinate: Vec2;
  targetLetter: string | null;
};

export function buildTargetCheckpoints(target: readonly Vec2[], count: number, boundaries: readonly LetterBoundary[] = []): TargetCheckpoint[] {
  if (target.length < 2 || count < 2) return [];
  const points = resamplePolyline(target, count);
  return points.map((point, index) => {
    const progress = points.length <= 1 ? 0 : index / (points.length - 1);
    const letter = boundaries.find((b) => progress >= b.projectedStartProgress - 1e-6 && progress <= b.projectedEndProgress + 1e-6);
    return { index, targetProgress: progress, targetCoordinate: point, targetLetter: letter?.letter ?? null };
  });
}

// ---------------------------------------------------------------------------
// Step 4/5 — snap checkpoints to K nearest EXISTING graph nodes
// ---------------------------------------------------------------------------

export type NodeSnap = { nodeId: string; distanceMeters: number };

export type CheckpointSnap = {
  checkpointIndex: number;
  targetProgress: number;
  targetLetter: string | null;
  targetCoordinate: Vec2;
  nearestNode: string | null;
  nearestDistanceMeters: number;
  candidateNodeCount: number;
  candidates: NodeSnap[];
};

export function snapCheckpointToGraph(checkpoint: TargetCheckpoint, graph: ShapeGraph, k: number = CHECKPOINT_SNAP_K): CheckpointSnap {
  const entries: NodeSnap[] = Object.entries(graph.nodes).map(([nodeId, point]) => ({
    nodeId,
    distanceMeters: Math.hypot(point.x - checkpoint.targetCoordinate.x, point.y - checkpoint.targetCoordinate.y),
  }));
  entries.sort((a, b) => a.distanceMeters - b.distanceMeters || a.nodeId.localeCompare(b.nodeId));
  const candidates = entries.slice(0, k);
  return {
    checkpointIndex: checkpoint.index,
    targetProgress: checkpoint.targetProgress,
    targetLetter: checkpoint.targetLetter,
    targetCoordinate: checkpoint.targetCoordinate,
    nearestNode: candidates[0]?.nodeId ?? null,
    nearestDistanceMeters: candidates[0]?.distanceMeters ?? Number.POSITIVE_INFINITY,
    candidateNodeCount: candidates.length,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Step 6 — route between two explicit checkpoint anchors (shape-cost-agnostic)
// ---------------------------------------------------------------------------

export type SegmentRouteResult = {
  fromCheckpointIndex: number;
  toCheckpointIndex: number;
  fromNode: string;
  toNode: string;
  connected: boolean;
  edgeIds: string[];
  routeDistanceMeters: number;
  straightTargetDistanceMeters: number;
  distanceRatio: number;
  maxPerpendicularDistanceMeters: number;
  meanPerpendicularDistanceMeters: number;
  headingAgreement: number;
  movesBackward: boolean;
};

export function evaluateSegmentRoute(
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  target: readonly Vec2[],
  fromCheckpointIndex: number,
  toCheckpointIndex: number,
  fromNode: string,
  toNode: string,
  fromCoordinate: Vec2,
  toCoordinate: Vec2,
): SegmentRouteResult {
  const straightTargetDistanceMeters = Math.hypot(toCoordinate.x - fromCoordinate.x, toCoordinate.y - fromCoordinate.y);
  const path: ConnectivityPath | null =
    fromNode === toNode ? { edgeIds: [], totalLengthMeters: 0 } : findShortestConnectingPath(directed, outgoing, new Set([fromNode]), new Set([toNode]));

  if (!path) {
    return {
      fromCheckpointIndex,
      toCheckpointIndex,
      fromNode,
      toNode,
      connected: false,
      edgeIds: [],
      routeDistanceMeters: straightTargetDistanceMeters,
      straightTargetDistanceMeters,
      distanceRatio: straightTargetDistanceMeters > 0 ? Number.POSITIVE_INFINITY : 1,
      maxPerpendicularDistanceMeters: Number.POSITIVE_INFINITY,
      meanPerpendicularDistanceMeters: Number.POSITIVE_INFINITY,
      headingAgreement: 0,
      movesBackward: false,
    };
  }

  const segmentPoints = polylineFromEdges(path.edgeIds, directed);
  const perpendiculars = segmentPoints.map((point) => projectOntoTarget(point, target).perpendicularDistance);
  const meanPerp = perpendiculars.length ? perpendiculars.reduce((s, v) => s + v, 0) / perpendiculars.length : 0;
  const maxPerp = perpendiculars.length ? Math.max(...perpendiculars) : 0;

  const routeStart = segmentPoints[0] ?? fromCoordinate;
  const routeEnd = segmentPoints[segmentPoints.length - 1] ?? toCoordinate;
  const routeHeading = headingRadians(routeStart, routeEnd);
  const straightHeading = headingRadians(fromCoordinate, toCoordinate);
  const heading = headingAgreement(routeHeading, straightHeading).agreement;

  const progressSequence = segmentPoints.map((point) => projectOntoTarget(point, target).progress);
  let movesBackward = false;
  for (let index = 1; index < progressSequence.length; index += 1) {
    if ((progressSequence[index] ?? 0) < (progressSequence[index - 1] ?? 0) - BACKWARD_PROGRESS_EPSILON) {
      movesBackward = true;
      break;
    }
  }

  return {
    fromCheckpointIndex,
    toCheckpointIndex,
    fromNode,
    toNode,
    connected: true,
    edgeIds: path.edgeIds,
    routeDistanceMeters: path.totalLengthMeters,
    straightTargetDistanceMeters,
    distanceRatio: straightTargetDistanceMeters > 0 ? path.totalLengthMeters / straightTargetDistanceMeters : 1,
    maxPerpendicularDistanceMeters: maxPerp,
    meanPerpendicularDistanceMeters: meanPerp,
    headingAgreement: heading,
    movesBackward,
  };
}

// ---------------------------------------------------------------------------
// Step 9 — small beam over which K candidate to commit to per checkpoint
// ---------------------------------------------------------------------------

export type PartialCheckpointSequence = {
  nodes: string[];
  edgeIds: string[];
  totalRouteDistanceMeters: number;
  /**
   * Sum, over every checkpoint visited so far, of the straight-line
   * distance between the chosen candidate node and that checkpoint's own
   * target coordinate. This — NOT raw accumulated route distance — is the
   * beam's PRIMARY ranking criterion (route distance is only a tie-break).
   *
   * Why: ranking purely by summed route distance rewards a degenerate
   * "never move" sequence (repeatedly re-selecting whichever node was
   * already reached, since re-selecting the SAME node for the next
   * checkpoint costs 0 route distance) even when that node is nowhere
   * near later checkpoints — a real bug caught by this file's own
   * synthetic self-tests (a 2-node graph let the beam "satisfy" every
   * checkpoint by literally staying at the start node, since the start
   * node was technically still among later checkpoints' K=3 candidate
   * sets, just ranked lower). Minimizing summed snap residual instead
   * directly measures whether the chosen nodes are actually close to
   * the checkpoints they are meant to represent, which is the real
   * question this experiment asks.
   */
  totalSnapResidualMeters: number;
  connected: boolean;
  segments: SegmentRouteResult[];
};

function comparePartials(a: PartialCheckpointSequence, b: PartialCheckpointSequence): number {
  if (a.connected !== b.connected) return a.connected ? -1 : 1;
  if (a.totalSnapResidualMeters !== b.totalSnapResidualMeters) return a.totalSnapResidualMeters - b.totalSnapResidualMeters;
  return a.totalRouteDistanceMeters - b.totalRouteDistanceMeters;
}

export function searchCheckpointRoute(
  checkpointSnaps: readonly CheckpointSnap[],
  directed: Map<string, Directed>,
  outgoing: Map<string, Directed[]>,
  target: readonly Vec2[],
): { best: PartialCheckpointSequence | null; finalBeam: PartialCheckpointSequence[] } {
  if (checkpointSnaps.length === 0) return { best: null, finalBeam: [] };
  const first = checkpointSnaps[0]!;
  let beam: PartialCheckpointSequence[] = first.candidates.map((c) => ({
    nodes: [c.nodeId],
    edgeIds: [],
    totalRouteDistanceMeters: 0,
    totalSnapResidualMeters: c.distanceMeters,
    connected: true,
    segments: [],
  }));

  for (let index = 1; index < checkpointSnaps.length; index += 1) {
    const previousCheckpoint = checkpointSnaps[index - 1]!;
    const nextCheckpoint = checkpointSnaps[index]!;
    const extended: PartialCheckpointSequence[] = [];
    for (const partial of beam) {
      const prevNode = partial.nodes[partial.nodes.length - 1]!;
      for (const candidate of nextCheckpoint.candidates) {
        const segment = evaluateSegmentRoute(
          directed,
          outgoing,
          target,
          previousCheckpoint.checkpointIndex,
          nextCheckpoint.checkpointIndex,
          prevNode,
          candidate.nodeId,
          previousCheckpoint.targetCoordinate,
          nextCheckpoint.targetCoordinate,
        );
        extended.push({
          nodes: [...partial.nodes, candidate.nodeId],
          edgeIds: [...partial.edgeIds, ...segment.edgeIds],
          totalRouteDistanceMeters: partial.totalRouteDistanceMeters + segment.routeDistanceMeters,
          totalSnapResidualMeters: partial.totalSnapResidualMeters + candidate.distanceMeters,
          connected: partial.connected && segment.connected,
          segments: [...partial.segments, segment],
        });
      }
    }
    extended.sort(comparePartials);
    beam = extended.slice(0, CHECKPOINT_BEAM_WIDTH);
  }

  const best = beam.find((p) => p.connected) ?? beam[0] ?? null;
  return { best, finalBeam: beam };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export type CheckpointRouteTrace = {
  checkpointCount: number;
  checkpoints: TargetCheckpoint[];
  snaps: CheckpointSnap[];
  best: PartialCheckpointSequence | null;
  pathPoints: Vec2[];
  fullyConnected: boolean;
  connectedSegmentCount: number;
  totalSegmentCount: number;
};

export function traceCheckpointRoute(
  input: { word: string; target: readonly Vec2[]; graph: ShapeGraph; kind?: ShapeKind; multiLetter?: boolean; boundaries?: readonly LetterBoundary[] },
  checkpointCount: number,
): CheckpointRouteTrace {
  const kind = input.kind ?? 'generic';
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const loop = kind === 'O' || isClosedTarget(target);
  const regions: TargetRegion[] = input.multiLetter && kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, target);
  const coverageThreshold = coverageThresholdMeters(target);

  const checkpoints = buildTargetCheckpoints(target, checkpointCount, input.boundaries ?? []);
  if (checkpoints.length === 0 || input.graph.segments.length === 0) {
    return { checkpointCount, checkpoints, snaps: [], best: null, pathPoints: [], fullyConnected: false, connectedSegmentCount: 0, totalSegmentCount: 0 };
  }

  const directed = explodeDirected(input.graph, target, targetLength, kind, loop, regions, coverageThreshold);
  const outgoing = indexOutgoing(directed);
  const snaps = checkpoints.map((checkpoint) => snapCheckpointToGraph(checkpoint, input.graph, CHECKPOINT_SNAP_K));
  const { best } = searchCheckpointRoute(snaps, directed, outgoing, target);

  const pathPoints = best ? polylineFromEdges(best.edgeIds, directed) : [];
  const connectedSegmentCount = best ? best.segments.filter((s) => s.connected).length : 0;
  const totalSegmentCount = best ? best.segments.length : Math.max(0, checkpoints.length - 1);
  const fullyConnected = best ? best.connected : false;

  return { checkpointCount, checkpoints, snaps, best, pathPoints, fullyConnected, connectedSegmentCount, totalSegmentCount };
}
