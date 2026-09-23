/**
 * DEVELOPMENT ONLY — production-CAPABLE, but NOT YET WIRED into
 * /generate-routes-experimental or any live traffic path.
 *
 * Checkpoint-v1: the first candidate-generation architecture built from
 * this session's checkpoint-anchored-routing feasibility experiment
 * (backend/src/diagnostics/checkpoint-route-experiment.ts), which found
 * that explicitly anchoring the route to evenly spaced target checkpoints
 * — then routing the pedestrian graph between them with a plain,
 * shape-cost-agnostic shortest path — materially beats the existing
 * production beam on the real multi-letter corpus (58/78 candidates
 * materially better shapeScore at C12, only 4/78 worse; see that
 * experiment's own final report for the full evidence).
 *
 * Architecture (exactly what the diagnostic validated, C12/K3/beam8 fixed):
 *
 *   word geometry
 *     -> 12 target checkpoints (buildTargetCheckpoints, unchanged from the diagnostic)
 *     -> 3 graph snap candidates per checkpoint (snapCheckpointToGraph, unchanged)
 *     -> checkpoint-choice beam, max 8 partial sequences (searchCheckpointRoute, unchanged)
 *     -> shortest graph routing between checkpoint anchors (findShortestConnectingPath, unchanged)
 *     -> assembled pedestrian route (polylineFromEdges, unchanged)
 *     -> EXISTING whole-route scoring (scorePolylines/shapeScoreBreakdown, unchanged)
 *     -> EXISTING product gate (meetsExperimentalProductThreshold, unchanged)
 *     -> candidate routes
 *
 * This module is a thin PRODUCTION-SHAPED wrapper around the
 * already-proven, already-self-tested diagnostic algorithm — it does not
 * reimplement checkpoint generation, snapping, the checkpoint-choice beam,
 * or graph routing (Step 1/2 of this task's spec: "reuse proven helpers
 * wherever possible", "do not infer from previous reports"). The only new
 * work here is: (a) exposing up to 8 completed candidate routes instead of
 * just the diagnostic's single "best" one, each shaped as a real
 * GeneratedRoute using the EXISTING scoring/gate functions untouched, and
 * (b) the multi-letter-only eligibility gate (Step 12).
 *
 * The existing production generator (graph-shape.ts's beam search, called
 * from graph-constrained-pipeline.ts's runExperimentalPipeline) is
 * completely untouched by this file and is not called from here.
 */
import type { Coordinate } from '@/lib/geo';
import { polylineLength, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';
import { offsetCoordinate } from '@/lib/shape-projection';

import {
  CHECKPOINT_SNAP_K,
  CHECKPOINT_BEAM_WIDTH,
  buildTargetCheckpoints,
  searchCheckpointRoute,
  snapCheckpointToGraph,
  type PartialCheckpointSequence,
} from '../diagnostics/checkpoint-route-experiment';
import { explodeDirected, indexOutgoing, polylineFromEdges } from '../diagnostics/beam-search-trace';
import { dedupeRoutes } from './graph-constrained-pipeline';
import { isClosedTarget, regionsForKind, type ShapeGraph, type ShapeKind } from './graph-shape';
import { analyzeTargetIdentity, coverageThresholdMeters } from './target-identity';
import { experimentalProductRejectionReasons } from './experimental-product';
import { scorePolylines, shapeScoreBreakdown } from '../scoring/shape-match';
import type { GeneratedRoute } from '../types';

/**
 * Fixed, validated configuration (Step 3). Not a tuning matrix — these are
 * the exact values the feasibility experiment proved out. Centralized here
 * so they can be revisited later, but this implementation does not expose
 * them as caller-configurable knobs.
 */
export const CHECKPOINT_V1 = {
  checkpointCount: 12,
  snapCandidates: CHECKPOINT_SNAP_K,
  checkpointBeamWidth: CHECKPOINT_BEAM_WIDTH,
  maxCandidateRoutes: 8,
} as const;

export type CheckpointV1Input = {
  word: string;
  /** Already-placed target polyline, local meters — same granularity as routeGraphConstrainedShape's own `target`. This module does not run its own placement search. */
  target: readonly Vec2[];
  /** Existing, already-collected pedestrian graph (read-only). */
  graph: ShapeGraph;
  kind?: ShapeKind;
  geometryVariant?: LetterShapeVariant;
  targetDistanceMeters: number;
  /** Geographic anchor used to convert this candidate's local-meter geometry into real coordinates for GeneratedRoute/product-gate identity checks (mirrors runExperimentalPipeline's own searchOrigin). */
  searchOrigin: Coordinate;
  /** Passed straight into each candidate's metadata, exactly like the existing pipeline's own placement fields — checkpoint-v1 does not run its own placement search, so these describe whichever placement supplied `target`/`graph`. */
  placement?: { rotationDegrees: number; scale: number; eastMeters: number; northMeters: number; distanceFromUserMeters: number };
};

export type CheckpointV1Candidate = {
  route: GeneratedRoute;
  fullyConnected: boolean;
  connectedSegmentCount: number;
  totalSegmentCount: number;
  passesProductGate: boolean;
  productGateRejectionReasons: string[];
};

export type CheckpointV1Result = {
  /** Step 12: false for single-letter words — the existing generator remains solely responsible for those. */
  eligible: boolean;
  checkpointsAttempted: number;
  /** Up to CHECKPOINT_V1.maxCandidateRoutes, deduplicated (existing dedupeRoutes) and ranked by the EXISTING shapeScore (Step 18 — never by generation-time heuristics like snap residual). */
  candidates: CheckpointV1Candidate[];
  generationRuntimeMs: number;
};

function emptyResult(eligible: boolean, checkpointsAttempted = 0): CheckpointV1Result {
  return { eligible, checkpointsAttempted, candidates: [], generationRuntimeMs: 0 };
}

export function generateCheckpointRoutes(input: CheckpointV1Input): CheckpointV1Result {
  const word = input.word.trim().toUpperCase();
  const multiLetter = word.replace(/[^A-Z]/g, '').length > 1;

  // Step 12: multi-letter scope only. Single-letter shapes (O, R, I, L, ...)
  // remain the existing generator's sole responsibility — the diagnostic
  // showed checkpoint anchoring is specifically worse for those.
  if (!multiLetter) {
    return emptyResult(false);
  }
  if (input.target.length < 2 || input.graph.segments.length === 0) {
    return emptyResult(true, 0);
  }

  const started = performance.now();
  const kind = input.kind ?? 'generic';
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const loop = kind === 'O' || isClosedTarget(target);
  const regions = kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, target);
  const coverageThreshold = coverageThresholdMeters(target);

  const checkpoints = buildTargetCheckpoints(target, CHECKPOINT_V1.checkpointCount);
  if (checkpoints.length === 0) {
    return { eligible: true, checkpointsAttempted: 0, candidates: [], generationRuntimeMs: performance.now() - started };
  }

  const directed = explodeDirected(input.graph, target, targetLength, kind, loop, regions, coverageThreshold);
  const outgoing = indexOutgoing(directed);
  const snaps = checkpoints.map((checkpoint) => snapCheckpointToGraph(checkpoint, input.graph, CHECKPOINT_V1.snapCandidates));
  const { finalBeam } = searchCheckpointRoute(snaps, directed, outgoing, target);

  // Step 9: every completed sequence in the final beam (not just the
  // single best) becomes a candidate — "completed" means it reached
  // checkpoint 11, whether or not it stayed connected the whole way
  // (a disconnected sequence is still recorded, just always scored/gated
  // honestly like any other route; it will not pass the product gate
  // unless its own connected sub-path happens to score well).
  const completed = finalBeam.filter((sequence) => sequence.nodes.length === checkpoints.length);

  const geometryVariant = input.geometryVariant ?? 'smooth';
  const placement = input.placement ?? { rotationDegrees: 0, scale: 1, eastMeters: 0, northMeters: 0, distanceFromUserMeters: 0 };

  const routes: GeneratedRoute[] = [];
  const bySequence = new Map<string, { sequence: PartialCheckpointSequence; route: GeneratedRoute }>();
  completed.forEach((sequence, sequenceIndex) => {
    const pathPoints = polylineFromEdges(sequence.edgeIds, directed);
    if (pathPoints.length < 2) return;
    const route = buildGeneratedRoute({
      word,
      pathPoints,
      target,
      kind,
      geometryVariant,
      targetDistanceMeters: input.targetDistanceMeters,
      searchOrigin: input.searchOrigin,
      placement,
      connected: sequence.connected,
      idSuffix: `${sequenceIndex}-${sequence.nodes.join('|')}`,
    });
    routes.push(route);
    bySequence.set(route.id, { sequence, route });
  });

  // Existing route-diversity dedup (Step 9), unmodified, same dedupeMeters threshold as production.
  const deduped = dedupeRoutes(routes).slice(0, CHECKPOINT_V1.maxCandidateRoutes);

  // Step 18: rank strictly by the EXISTING shapeScore, never by generation-time heuristics.
  deduped.sort((a, b) => b.shapeScore - a.shapeScore);

  const candidates: CheckpointV1Candidate[] = deduped.map((route) => {
    const found = bySequence.get(route.id);
    const sequence = found?.sequence;
    const connectedSegmentCount = sequence?.segments.filter((s) => s.connected).length ?? 0;
    const totalSegmentCount = sequence?.segments.length ?? 0;
    const rejectionReasons = experimentalProductRejectionReasons(route, { word, targetDistance: input.targetDistanceMeters });
    return {
      route,
      fullyConnected: sequence?.connected ?? false,
      connectedSegmentCount,
      totalSegmentCount,
      passesProductGate: rejectionReasons.length === 0,
      productGateRejectionReasons: rejectionReasons,
    };
  });

  return {
    eligible: true,
    checkpointsAttempted: checkpoints.length,
    candidates,
    generationRuntimeMs: performance.now() - started,
  };
}

function buildGeneratedRoute(input: {
  word: string;
  pathPoints: Vec2[];
  target: readonly Vec2[];
  kind: ShapeKind;
  geometryVariant: LetterShapeVariant;
  targetDistanceMeters: number;
  searchOrigin: Coordinate;
  placement: { rotationDegrees: number; scale: number; eastMeters: number; northMeters: number; distanceFromUserMeters: number };
  connected: boolean;
  idSuffix: string;
}): GeneratedRoute {
  const { pathPoints, target, searchOrigin, placement } = input;
  const shapeGeo = pathPoints.map((point) => offsetCoordinate(searchOrigin, point.x, point.y));
  const targetGeo = target.map((point) => offsetCoordinate(searchOrigin, point.x, point.y));
  const scored = scorePolylines(pathPoints, target);
  const breakdown = shapeScoreBreakdown(scored);
  // Existing, unmodified identity metric — reused (not reinvented) for the
  // GeneratedRoute.metadata.largestGap field the product gate reads
  // directly (route.metadata.largestGap ?? 1).
  const identity = analyzeTargetIdentity({ route: pathPoints, target, word: input.word, geometryVariant: input.geometryVariant });
  const routeDistanceMeters = polylineLength(pathPoints);
  const id = `checkpoint-v1-${input.idSuffix}`;

  return {
    id,
    source: 'valhalla',
    developmentOnly: true,
    coordinates: shapeGeo,
    targetCoordinates: targetGeo,
    shapeCoordinates: shapeGeo,
    connectorCoordinates: [],
    distanceMeters: routeDistanceMeters,
    shapeScore: scored.score,
    coverage: scored.coverage,
    scoreBreakdown: breakdown,
    metadata: {
      rotationDegrees: placement.rotationDegrees,
      scale: placement.scale,
      placement: placement.eastMeters === 0 && placement.northMeters === 0 ? 'start-anchored' : 'offset',
      offsetAcrossMeters: Math.round(Math.hypot(placement.eastMeters, placement.northMeters)),
      method: 'graph_constrained',
      connectedFromStart: input.connected,
      connected: input.connected,
      eastMeters: placement.eastMeters,
      northMeters: placement.northMeters,
      distanceFromUserMeters: Math.round(placement.distanceFromUserMeters),
      startSnapDistanceMeters: 0,
      lengthError: Math.abs(routeDistanceMeters - input.targetDistanceMeters),
      distanceError: Math.abs(routeDistanceMeters - input.targetDistanceMeters),
      detourRatio: Math.max(0, routeDistanceMeters / Math.max(input.targetDistanceMeters, 1) - 1),
      backtrackRatio: scored.details.backtrackRatio,
      score: scored,
      connectorDistanceMeters: 0,
      failureReason: input.connected ? null : 'checkpoint_sequence_disconnected',
      shapeRouteDistanceMeters: routeDistanceMeters,
      totalDistanceMeters: routeDistanceMeters,
      largestGap: identity.largestTargetGap,
      geometryVariant: input.geometryVariant,
    },
  };
}

