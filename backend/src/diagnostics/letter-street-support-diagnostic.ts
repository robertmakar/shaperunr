/**
 * DEVELOPMENT ONLY. Letter-vs-street-network structural support diagnostic
 * — measures, without running any search, whether the pedestrian graph
 * physically/orientationally supports a given letter's target strokes.
 * Never wired into production. graph-shape.ts is never touched; this
 * reuses ALREADY-EXPORTED, already-validated primitives from two earlier
 * diagnostic files in this session (beam-search-trace.ts's
 * explodeDirected/indexOutgoing, letter-transition-diagnostic.ts's
 * findShortestConnectingPath) rather than building a third copy of the
 * directed-graph machinery.
 *
 * Step 10's answer, confirmed directly from src/lib/letter-shapes.ts: Z
 * has exactly ONE geometry representation — LETTER_SHAPES.Z is a single
 * 4-point straight-line stroke, [0.1,1]→[0.9,1]→[0.1,0]→[0.9,0] (top,
 * diagonal, bottom). Z does NOT appear in LETTER_SHAPES_ANGULAR (that
 * table only exists for letters whose SMOOTH form uses a curve — O, Q, C,
 * G, J, U, S); Z is already fully straight/angular in its only
 * definition, so `angular` mode falls back to the same points. This is a
 * verified fact, not an assumption.
 */
import { distanceToPolyline, headingRadians, resamplePolyline, type Vec2 } from '@/lib/geometry';
import { getLetterShapeVariant, type LetterShapeVariant } from '@/lib/letter-shapes';
import { headingAgreement } from './street-fit';
import { explodeDirected, indexOutgoing, type Directed } from './beam-search-trace';
import { findShortestConnectingPath } from './letter-transition-diagnostic';
import type { ShapeGraph, ShapeKind } from '../generation/graph-shape';
import type { LetterBoundary } from './multi-letter-trace';

// ---------------------------------------------------------------------------
// Step 1-2 — Z's three structural strokes, in the PLACED (real) target frame.
// ---------------------------------------------------------------------------

export type ZStrokes = { top: Vec2[]; diagonal: Vec2[]; bottom: Vec2[] };

/** Confirms and exposes Z's exact abstract (0..1) geometry — one straight 4-point stroke, no separate angular variant. */
export function abstractZStrokePoints(variant: LetterShapeVariant = 'smooth'): Vec2[] {
  const shape = getLetterShapeVariant('Z', variant);
  return shape ? shape.strokes[0]!.map((p) => ({ ...p })) : [];
}

/** Slices the PLACED (real, corridor-frame) target polyline to one letter's progress window — identical pattern to letter-stroke-proximity-diagnostic.ts's sliceLetterStrokePolyline, reused conceptually (duplicated here to keep this module's dependency footprint self-contained for a focused forensic task). */
function sliceByProgress(target: readonly Vec2[], startProgress: number, endProgress: number, resampleCount = 96): Vec2[] {
  const samples = resamplePolyline(target, resampleCount);
  const sliced = samples.filter((_, index) => {
    const progress = samples.length === 1 ? 0 : index / (samples.length - 1);
    return progress >= startProgress - 0.005 && progress <= endProgress + 0.005;
  });
  return sliced.length >= 2 ? sliced : samples.slice(0, 2);
}

/** The four progress boundaries (p0..p3) of Z's proportional arc-length stroke split — extracted as its own export so callers needing the raw progress values (not just the sliced points) don't re-derive this split independently. See decomposeZStrokes, which is now defined in terms of this. */
export function zStrokeProgressSplit(boundary: LetterBoundary): { p0: number; p1: number; p2: number; p3: number } {
  const abstractPoints = abstractZStrokePoints();
  const segLen = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);
  const topLen = segLen(abstractPoints[0]!, abstractPoints[1]!);
  const diagLen = segLen(abstractPoints[1]!, abstractPoints[2]!);
  const botLen = segLen(abstractPoints[2]!, abstractPoints[3]!);
  const total = topLen + diagLen + botLen;
  const span = boundary.projectedEndProgress - boundary.projectedStartProgress;
  const p0 = boundary.projectedStartProgress;
  const p1 = p0 + (topLen / total) * span;
  const p2 = p1 + (diagLen / total) * span;
  const p3 = boundary.projectedEndProgress;
  void botLen;
  return { p0, p1, p2, p3 };
}

/**
 * Decomposes the PLACED Z into its three structural strokes by proportional
 * arc-length split of the abstract 4-point stroke (top: pt0->pt1, diagonal:
 * pt1->pt2, bottom: pt2->pt3), mapped onto the letter's own progress window
 * within the real, placed target polyline.
 */
export function decomposeZStrokes(target: readonly Vec2[], boundary: LetterBoundary): ZStrokes {
  const { p0, p1, p2, p3 } = zStrokeProgressSplit(boundary);
  return {
    top: sliceByProgress(target, p0, p1),
    diagonal: sliceByProgress(target, p1, p2),
    bottom: sliceByProgress(target, p2, p3),
  };
}

// ---------------------------------------------------------------------------
// Step 3 — proximity (street support) distributions.
// ---------------------------------------------------------------------------

export type DistanceDistribution = { n: number; min: number; mean: number; p90: number; fractionWithin: { at10: number; at20: number; at30: number; at50: number } };

function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

export function measureStreetSupport(stroke: readonly Vec2[], corridorLines: readonly Vec2[][], sampleCount = 24): DistanceDistribution {
  if (stroke.length < 2 || corridorLines.length === 0) {
    return { n: 0, min: Number.POSITIVE_INFINITY, mean: Number.POSITIVE_INFINITY, p90: Number.POSITIVE_INFINITY, fractionWithin: { at10: 0, at20: 0, at30: 0, at50: 0 } };
  }
  const samples = resamplePolyline(stroke, sampleCount);
  const distances = samples.map((point) => Math.min(...corridorLines.map((line) => distanceToPolyline(point, line))));
  const within = (threshold: number) => distances.filter((d) => d <= threshold).length / distances.length;
  return {
    n: distances.length,
    min: Math.min(...distances),
    mean: distances.reduce((s, d) => s + d, 0) / distances.length,
    p90: percentileOf(distances, 90),
    fractionWithin: { at10: within(10), at20: within(20), at30: within(30), at50: within(50) },
  };
}

// ---------------------------------------------------------------------------
// Step 5 — orientation compatibility.
// ---------------------------------------------------------------------------

export type OrientationDistribution = { n: number; mean: number; p25: number; median: number; p75: number; fractionWithin: { deg15: number; deg30: number; deg45: number; deg60: number } };

/** For every corridor segment with at least one point within `radiusMeters` of the stroke, computes the heading-difference (degrees) between that segment's own direction and the stroke's own overall direction (start->end — Z's strokes are already straight lines, so a single direction is exact; for curved comparison letters this is an approximation, documented at the call site). */
export function measureOrientationSupport(stroke: readonly Vec2[], corridorLines: readonly Vec2[][], radiusMeters: number): OrientationDistribution {
  if (stroke.length < 2) return { n: 0, mean: 0, p25: 0, median: 0, p75: 0, fractionWithin: { deg15: 0, deg30: 0, deg45: 0, deg60: 0 } };
  const strokeHeading = headingRadians(stroke[0]!, stroke[stroke.length - 1]!);
  const deltas: number[] = [];
  for (const line of corridorLines) {
    for (let i = 0; i + 1 < line.length; i += 1) {
      const a = line[i]!;
      const b = line[i + 1]!;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const nearest = Math.min(...stroke.map((p) => Math.hypot(p.x - mid.x, p.y - mid.y)));
      if (nearest > radiusMeters) continue;
      const edgeHeading = headingRadians(a, b);
      const agreement = headingAgreement(edgeHeading, strokeHeading);
      deltas.push(agreement.deltaDegrees);
    }
  }
  if (deltas.length === 0) return { n: 0, mean: 0, p25: 0, median: 0, p75: 0, fractionWithin: { deg15: 0, deg30: 0, deg45: 0, deg60: 0 } };
  const within = (threshold: number) => deltas.filter((d) => d <= threshold).length / deltas.length;
  return {
    n: deltas.length,
    mean: deltas.reduce((s, d) => s + d, 0) / deltas.length,
    p25: percentileOf(deltas, 25),
    median: percentileOf(deltas, 50),
    p75: percentileOf(deltas, 75),
    fractionWithin: { deg15: within(15), deg30: within(30), deg45: within(45), deg60: within(60) },
  };
}

// ---------------------------------------------------------------------------
// Step 6-8 — component connectivity + shortest-path detour, reusing the
// real, already-validated findShortestConnectingPath (multi-source Dijkstra
// by edge length, shape-cost-agnostic) unmodified.
// ---------------------------------------------------------------------------

export type ConnectivityResult = { connected: boolean; routeDistanceMeters: number | null; straightDistanceMeters: number; graphStraightRatio: number | null };

function nearestNodes(graph: ShapeGraph, point: Vec2, k: number): string[] {
  const entries = Object.entries(graph.nodes).map(([id, p]) => ({ id, distance: Math.hypot(p.x - point.x, p.y - point.y) }));
  entries.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  return entries.slice(0, k).map((e) => e.id);
}

export function buildDirected(graph: ShapeGraph, target: readonly Vec2[], kind: ShapeKind, loop: boolean, regions: readonly { id: string; startProgress: number; endProgress: number }[] = [{ id: 'shape', startProgress: 0, endProgress: 1 }]): { directed: Map<string, Directed>; outgoing: Map<string, Directed[]> } {
  const targetLength = target.length >= 2 ? resamplePolyline(target, target.length).reduce((sum, p, i, arr) => (i === 0 ? 0 : sum + Math.hypot(p.x - arr[i - 1]!.x, p.y - arr[i - 1]!.y)), 0) : 0;
  const directed = explodeDirected(graph, target, targetLength, kind, loop, regions, 0);
  const outgoing = indexOutgoing(directed);
  return { directed, outgoing };
}

export function testConnectivity(directed: Map<string, Directed>, outgoing: Map<string, Directed[]>, graph: ShapeGraph, fromPoint: Vec2, toPoint: Vec2, k: number): ConnectivityResult {
  const fromNodes = new Set(nearestNodes(graph, fromPoint, k));
  const toNodes = new Set(nearestNodes(graph, toPoint, k));
  const straightDistanceMeters = Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y);
  const path = findShortestConnectingPath(directed, outgoing, fromNodes, toNodes);
  if (!path) return { connected: false, routeDistanceMeters: null, straightDistanceMeters, graphStraightRatio: null };
  return { connected: true, routeDistanceMeters: path.totalLengthMeters, straightDistanceMeters, graphStraightRatio: straightDistanceMeters > 1e-6 ? path.totalLengthMeters / straightDistanceMeters : 1 };
}
