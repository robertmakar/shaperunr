/**
 * DEVELOPMENT ONLY. Directional traversal diagnostic for Z's diagonal —
 * measures whether a baseline route traverses a target stroke window in the
 * intended direction, in reverse, merely crosses/grazes it, or misses it.
 * Never wired into production; never routes, never scores, never gates.
 * graph-shape.ts is never touched.
 *
 * Reused conventions (NOT re-invented here):
 * - target progress / nearest target segment / local target heading:
 *   projectOntoTarget (street-fit.ts) — the same projection the real search's
 *   explodeDirected and metricsFromPath use.
 * - heading agreement + reverse flag: headingAgreement (street-fit.ts) —
 *   agreement is the acute-angle score the search uses (direction-blind);
 *   `reverse` is the same function's own "delta > 90°" flag. A signed
 *   agreement (+agreement when !reverse, -agreement when reverse) is the
 *   only derived quantity, and it is derived purely from those two outputs.
 * - on-ink radius: coverageThresholdMeters (target-identity.ts) — the same
 *   radius rawInk/ink-only occupancy uses. Near-miss tolerance:
 *   TARGET_IDENTITY.nearMissMultiplier (same file).
 * - corridor radius for the directional shadow: GRAPH_SHAPE.corridorMeters.
 * - stroke progress split: zStrokeProgressSplit (letter-street-support-
 *   diagnostic.ts).
 *
 * Direction in this file is expressed as TARGET PROGRESS direction: for Z's
 * diagonal, intended traversal (letter-frame right→left, top→bottom) is
 * exactly increasing target progress through [p1, p2]. Geometric heading
 * direction (the `reverse` flag) is reported alongside so the two notions
 * can be checked against each other rather than assumed equal.
 */
import { polylineLength, projectPointOnPolyline, headingRadians, type Vec2 } from '@/lib/geometry';

import { coverageThresholdMeters, TARGET_IDENTITY } from '../generation/target-identity';
import { GRAPH_SHAPE } from '../generation/graph-shape';
import { headingAgreement, projectOntoTarget } from './street-fit';
import type { Directed } from './beam-search-trace';

// ---------------------------------------------------------------------------
// Fixed thresholds — declared BEFORE any corpus run, never tuned afterwards.
// ---------------------------------------------------------------------------

export const DIRECTION_THRESHOLDS = {
  /** Route is densified so no analyzed piece is longer than this (meters). */
  pieceMeters: 6,
  /** Number of equal bins across a stroke window (task default). */
  bins: 8,
  /** Δt (fraction of the stroke window) smaller than this is treated as direction-neutral jitter. */
  jitterT: 0.01,
  /** Missing: in-window path length AND window coverage both below this fraction (a perpendicular crossing leaves ~2x radius of in-window path, so it stays above this). */
  missingFraction: 0.05,
  /** Correct / reverse: a single consecutive run must span at least this much of the window... */
  meaningfulRunT: 0.5,
  /** ...and the dominant direction must exceed the other by at least this factor. */
  dominanceFactor: 2,
  /** Direction sub-runs shorter than this (fraction of window) are corner/jitter blips: dropped, and same-direction neighbours within one visit are merged. At Z's acute corners a few metres of the ADJACENT stroke project onto the diagonal with a ~143° heading delta. */
  minRunT: 0.05,
  /** Partial traversal (below meaningfulRunT but not a mere crossing). */
  partialRunT: 0.25,
  /** Directional feasibility shadow: max graph-path / straight-line ratio. */
  maxDetourRatio: 1.6,
  /** Directional feasibility shadow: max length-weighted full (signed) heading delta, degrees. */
  maxMeanHeadingDeltaDeg: 60,
  /** Directional feasibility shadow: max fraction of path length flagged `reverse`. */
  maxReverseFraction: 0.2,
  /** Endpoint node sets for connectivity / shadow (same K as the prior forensic's primary K). */
  endpointK: 3,
} as const;

// ---------------------------------------------------------------------------
// Route pieces.
// ---------------------------------------------------------------------------

export type RoutePiece = {
  index: number;
  a: Vec2;
  b: Vec2;
  length: number;
  /** Route arc-length position of the piece midpoint (meters). */
  routeMeters: number;
  /** Nearest global target progress of the piece midpoint / endpoints. */
  progress: number;
  progressA: number;
  progressB: number;
  perpendicularDistance: number;
  targetHeading: number;
  routeHeading: number;
  /** headingAgreement(...).agreement — direction-blind, same as the search's headingFit. */
  agreement: number;
  /** headingAgreement(...).reverse — geometric direction flag. */
  reverse: boolean;
  /** Acute delta (degrees) from headingAgreement. */
  acuteDeltaDeg: number;
  /** Full delta in [0,180] reconstructed from acute delta + reverse flag. */
  fullDeltaDeg: number;
  /** Signed displacement (meters) along the LOCAL target tangent: length·cos(fullΔ). Immune to nearest-projection jumps at acute corners. */
  alongMeters: number;
};

export function buildRoutePieces(route: readonly Vec2[], target: readonly Vec2[], pieceMeters: number = DIRECTION_THRESHOLDS.pieceMeters): RoutePiece[] {
  const pieces: RoutePiece[] = [];
  let traveled = 0;
  for (let i = 0; i + 1 < route.length; i += 1) {
    const start = route[i]!;
    const end = route[i + 1]!;
    const segLength = Math.hypot(end.x - start.x, end.y - start.y);
    if (segLength < 1e-6) continue;
    const parts = Math.max(1, Math.ceil(segLength / pieceMeters));
    for (let k = 0; k < parts; k += 1) {
      const a = { x: start.x + ((end.x - start.x) * k) / parts, y: start.y + ((end.y - start.y) * k) / parts };
      const b = { x: start.x + ((end.x - start.x) * (k + 1)) / parts, y: start.y + ((end.y - start.y) * (k + 1)) / parts };
      const length = segLength / parts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const hit = projectOntoTarget(mid, target);
      const routeHeading = headingRadians(a, b);
      const heading = headingAgreement(routeHeading, hit.targetHeading);
      pieces.push({
        index: pieces.length,
        a,
        b,
        length,
        routeMeters: traveled + length / 2,
        progress: hit.progress,
        progressA: projectPointOnPolyline(a, target).progress,
        progressB: projectPointOnPolyline(b, target).progress,
        perpendicularDistance: hit.perpendicularDistance,
        targetHeading: hit.targetHeading,
        routeHeading,
        agreement: heading.agreement,
        reverse: heading.reverse,
        acuteDeltaDeg: heading.deltaDegrees,
        fullDeltaDeg: heading.reverse ? 180 - heading.deltaDegrees : heading.deltaDegrees,
        alongMeters: length * Math.cos(((heading.reverse ? 180 - heading.deltaDegrees : heading.deltaDegrees) * Math.PI) / 180),
      });
      traveled += length;
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Stroke-window traversal analysis.
// ---------------------------------------------------------------------------

export type StrokeWindow = { label: string; start: number; end: number };

export type WindowBin = {
  bin: number;
  tStart: number;
  tEnd: number;
  progressStart: number;
  progressEnd: number;
  pieceCount: number;
  entries: number;
  routeMeters: number;
  meanTargetHeadingDeg: number | null;
  meanRouteHeadingDeg: number | null;
  meanFullDeltaDeg: number | null;
  signedAgreement: number | null;
  forwardT: number;
  reverseT: number;
};

export type DiagonalCategory = 'A_correct' | 'B_reverse' | 'C_crossing_grazing' | 'D_missing' | 'E_mixed_ambiguous';

export type StrokeTraversal = {
  label: string;
  window: { start: number; end: number };
  targetLengthMeters: number;
  radiusMeters: number;
  inWindowPieceCount: number;
  inWindowPathMeters: number;
  routeTargetRatio: number;
  /** Union of t-intervals spanned by in-window pieces (exact, not binned). */
  coverage: number;
  /** Length-weighted mean of the direction-blind agreement (search convention). */
  meanAgreement: number | null;
  /** Length-weighted mean of ±agreement (sign from `reverse`). Range [-1, 1]. */
  signedAgreement: number | null;
  /** Fraction of in-window path length whose `reverse` flag is false. */
  headingForwardFraction: number | null;
  meanFullDeltaDeg: number | null;
  /** Sum of positive / negative Δt (fractions of the window) across in-window pieces. */
  forwardT: number;
  reverseT: number;
  longestForwardRunT: number;
  longestReverseRunT: number;
  directionReversals: number;
  maxTReached: number | null;
  minTReached: number | null;
  firstEntryT: number | null;
  firstRunDirection: 'forward' | 'reverse' | 'neutral' | null;
  visits: number;
  bins: WindowBin[];
  category: DiagonalCategory;
  categoryReason: string;
};

function toT(progress: number, window: StrokeWindow): number {
  const span = window.end - window.start;
  return span <= 0 ? 0 : (progress - window.start) / span;
}

function inWindow(piece: RoutePiece, window: StrokeWindow, radius: number): boolean {
  return piece.perpendicularDistance <= radius && piece.progress >= window.start && piece.progress <= window.end;
}

function nearWindow(piece: RoutePiece, window: StrokeWindow, radius: number): boolean {
  const margin = (window.end - window.start) * 0.1;
  return piece.perpendicularDistance <= radius * TARGET_IDENTITY.nearMissMultiplier && piece.progress >= window.start - margin && piece.progress <= window.end + margin;
}

function circularMeanDeg(angles: readonly number[], weights: readonly number[]): number | null {
  if (angles.length === 0) return null;
  let sx = 0;
  let sy = 0;
  angles.forEach((a, i) => {
    sx += Math.cos(a) * (weights[i] ?? 1);
    sy += Math.sin(a) * (weights[i] ?? 1);
  });
  return (Math.atan2(sy, sx) * 180) / Math.PI;
}

function weightedMean(values: readonly number[], weights: readonly number[]): number | null {
  const total = weights.reduce((s, w) => s + w, 0);
  if (values.length === 0 || total <= 0) return null;
  return values.reduce((s, v, i) => s + v * (weights[i] ?? 0), 0) / total;
}

function unionLength(intervals: Array<[number, number]>): number {
  const clipped = intervals.map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(1, Math.max(a, b))] as [number, number]).filter(([a, b]) => b > a);
  clipped.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [a, b] of clipped) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else curEnd = Math.max(curEnd, b);
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export function classifyDirectionalTraversal(input: {
  inWindowPathMeters: number;
  targetLengthMeters: number;
  coverage: number;
  forwardT: number;
  reverseT: number;
  longestForwardRunT: number;
  longestReverseRunT: number;
}): { category: DiagonalCategory; reason: string } {
  const t = DIRECTION_THRESHOLDS;
  const pathFraction = input.targetLengthMeters > 0 ? input.inWindowPathMeters / input.targetLengthMeters : 0;
  if (pathFraction < t.missingFraction && input.coverage < t.missingFraction) {
    return { category: 'D_missing', reason: `pathFraction=${pathFraction.toFixed(2)} coverage=${input.coverage.toFixed(2)} both < ${t.missingFraction}` };
  }
  if (input.longestForwardRunT >= t.meaningfulRunT && input.forwardT >= t.dominanceFactor * input.reverseT) {
    return { category: 'A_correct', reason: `forwardRun=${input.longestForwardRunT.toFixed(2)} fwd=${input.forwardT.toFixed(2)} rev=${input.reverseT.toFixed(2)}` };
  }
  if (input.longestReverseRunT >= t.meaningfulRunT && input.reverseT >= t.dominanceFactor * input.forwardT) {
    return { category: 'B_reverse', reason: `reverseRun=${input.longestReverseRunT.toFixed(2)} fwd=${input.forwardT.toFixed(2)} rev=${input.reverseT.toFixed(2)}` };
  }
  if (input.longestForwardRunT >= t.partialRunT && input.longestReverseRunT >= t.partialRunT) {
    return { category: 'E_mixed_ambiguous', reason: `meaningful runs both ways (fwdRun=${input.longestForwardRunT.toFixed(2)} revRun=${input.longestReverseRunT.toFixed(2)})` };
  }
  if (Math.max(input.longestForwardRunT, input.longestReverseRunT) >= t.partialRunT) {
    return { category: 'E_mixed_ambiguous', reason: `partial one-way run only (fwdRun=${input.longestForwardRunT.toFixed(2)} revRun=${input.longestReverseRunT.toFixed(2)})` };
  }
  return { category: 'C_crossing_grazing', reason: `near window but longest run=${Math.max(input.longestForwardRunT, input.longestReverseRunT).toFixed(2)} < ${t.partialRunT}` };
}

export function analyzeStrokeTraversal(pieces: readonly RoutePiece[], target: readonly Vec2[], window: StrokeWindow, radiusMeters: number = coverageThresholdMeters(target)): StrokeTraversal {
  const T = DIRECTION_THRESHOLDS;
  const targetLength = polylineLength(target);
  const targetLengthMeters = (window.end - window.start) * targetLength;
  const inside = pieces.filter((p) => inWindow(p, window, radiusMeters));
  const weights = inside.map((p) => p.length);
  const inWindowPathMeters = weights.reduce((s, w) => s + w, 0);

  // Runs: consecutive in-window pieces (near-window pieces bridge without breaking, outside pieces break).
  let longestForward = 0;
  let longestReverse = 0;
  let reversals = 0;
  let visits = 0;
  let forwardT = 0;
  let reverseT = 0;
  let firstEntryT: number | null = null;
  let firstRunDirection: StrokeTraversal['firstRunDirection'] = null;
  let firstRunNet = 0;
  let firstRunOpen = false;

  // Δt per piece = along-tangent displacement / window target length. NOT
  // derived from differencing global projections: at Z's acute (~37°)
  // corners the nearest-target projection flips between strokes, and a 6m
  // piece could otherwise "advance" half the diagonal.
  const dtOf = (p: RoutePiece) => (targetLengthMeters > 0 ? p.alongMeters / targetLengthMeters : 0);
  const rawRuns: Array<{ visit: number; dir: 1 | -1; span: number }> = [];
  let inVisit = false;

  for (const piece of pieces) {
    const isIn = inWindow(piece, window, radiusMeters);
    const isNear = !isIn && nearWindow(piece, window, radiusMeters);
    if (!isIn && !isNear) {
      if (inVisit && firstRunOpen) firstRunOpen = false;
      inVisit = false;
      continue;
    }
    if (!isIn) continue; // near-miss: bridge, contributes nothing
    if (!inVisit) {
      visits += 1;
      inVisit = true;
      if (firstEntryT === null) {
        firstEntryT = toT(piece.progress, window);
        firstRunOpen = true;
      }
    }
    const dt = dtOf(piece);
    if (dt > 0) forwardT += dt;
    else reverseT += -dt;
    if (firstRunOpen) firstRunNet += dt;
    // Near-perpendicular pieces (|cos Δ| < 0.2) are direction-neutral.
    if (Math.abs(dt) * targetLengthMeters < piece.length * 0.2) continue;
    const dir: 1 | -1 = dt > 0 ? 1 : -1;
    const last = rawRuns[rawRuns.length - 1];
    if (last && last.visit === visits && last.dir === dir) last.span += Math.abs(dt);
    else rawRuns.push({ visit: visits, dir, span: Math.abs(dt) });
  }
  // Drop blips, then merge same-direction neighbours within a visit.
  const runs: Array<{ visit: number; dir: 1 | -1; span: number }> = [];
  for (const run of rawRuns.filter((r) => r.span >= T.minRunT)) {
    const last = runs[runs.length - 1];
    if (last && last.visit === run.visit && last.dir === run.dir) last.span += run.span;
    else runs.push({ ...run });
  }
  for (const run of runs) {
    if (run.dir === 1) longestForward = Math.max(longestForward, run.span);
    else longestReverse = Math.max(longestReverse, run.span);
  }
  for (let i = 1; i < runs.length; i += 1) if (runs[i]!.visit === runs[i - 1]!.visit && runs[i]!.dir !== runs[i - 1]!.dir) reversals += 1;
  if (firstEntryT !== null) firstRunDirection = firstRunNet > T.jitterT ? 'forward' : firstRunNet < -T.jitterT ? 'reverse' : 'neutral';

  const coverage = unionLength(inside.map((p) => { const t = toT(p.progress, window); const h = Math.abs(dtOf(p)) / 2; return [t - h, t + h]; }));
  const ts = inside.map((p) => toT(p.progress, window));

  const bins: WindowBin[] = [];
  for (let b = 0; b < T.bins; b += 1) {
    const tStart = b / T.bins;
    const tEnd = (b + 1) / T.bins;
    const binPieces = inside.filter((p) => {
      const t = toT(p.progress, window);
      return t >= tStart && (b === T.bins - 1 ? t <= tEnd : t < tEnd);
    });
    let entries = 0;
    let prevIndex = -2;
    for (const p of binPieces) {
      if (p.index !== prevIndex + 1) entries += 1;
      prevIndex = p.index;
    }
    const w = binPieces.map((p) => p.length);
    let fwd = 0;
    let rev = 0;
    for (const p of binPieces) {
      const dt = dtOf(p);
      if (dt > 0) fwd += dt;
      else rev += -dt;
    }
    bins.push({
      bin: b,
      tStart,
      tEnd,
      progressStart: window.start + tStart * (window.end - window.start),
      progressEnd: window.start + tEnd * (window.end - window.start),
      pieceCount: binPieces.length,
      entries,
      routeMeters: w.reduce((s, v) => s + v, 0),
      meanTargetHeadingDeg: circularMeanDeg(binPieces.map((p) => p.targetHeading), w),
      meanRouteHeadingDeg: circularMeanDeg(binPieces.map((p) => p.routeHeading), w),
      meanFullDeltaDeg: weightedMean(binPieces.map((p) => p.fullDeltaDeg), w),
      signedAgreement: weightedMean(binPieces.map((p) => (p.reverse ? -p.agreement : p.agreement)), w),
      forwardT: fwd,
      reverseT: rev,
    });
  }

  const { category, reason } = classifyDirectionalTraversal({ inWindowPathMeters, targetLengthMeters, coverage, forwardT, reverseT, longestForwardRunT: longestForward, longestReverseRunT: longestReverse });

  return {
    label: window.label,
    window: { start: window.start, end: window.end },
    targetLengthMeters,
    radiusMeters,
    inWindowPieceCount: inside.length,
    inWindowPathMeters,
    routeTargetRatio: targetLengthMeters > 0 ? inWindowPathMeters / targetLengthMeters : 0,
    coverage,
    meanAgreement: weightedMean(inside.map((p) => p.agreement), weights),
    signedAgreement: weightedMean(inside.map((p) => (p.reverse ? -p.agreement : p.agreement)), weights),
    headingForwardFraction: inWindowPathMeters > 0 ? inside.filter((p) => !p.reverse).reduce((s, p) => s + p.length, 0) / inWindowPathMeters : null,
    meanFullDeltaDeg: weightedMean(inside.map((p) => p.fullDeltaDeg), weights),
    forwardT,
    reverseT,
    longestForwardRunT: longestForward,
    longestReverseRunT: longestReverse,
    directionReversals: reversals,
    maxTReached: ts.length ? Math.max(...ts) : null,
    minTReached: ts.length ? Math.min(...ts) : null,
    firstEntryT,
    firstRunDirection,
    visits,
    bins,
    category,
    categoryReason: reason,
  };
}

// ---------------------------------------------------------------------------
// Transition analysis at a stroke corner (progress `corner`).
// ---------------------------------------------------------------------------

export type TransitionAnalysis = {
  cornerProgress: number;
  cornerPoint: Vec2;
  nearestRouteDistanceMeters: number;
  reachedCorner: boolean;
  /** Signed agreement of route pieces within `radius` of the corner that project onto the INCOMING stroke / OUTGOING stroke. */
  incomingSignedAgreement: number | null;
  outgoingSignedAgreement: number | null;
  incomingMeters: number;
  outgoingMeters: number;
  /** Target progress (global) of the route at the closest approach, and ±lookMeters along the route. */
  progressAtClosest: number | null;
  progressBefore: number | null;
  progressAfter: number | null;
  /** True when the route, after its closest approach, continues into the outgoing stroke (projected progress > corner within the radius). */
  continuesIntoOutgoing: boolean;
};

export function pointAtProgress(target: readonly Vec2[], progress: number): Vec2 {
  const total = polylineLength(target);
  const goal = Math.min(1, Math.max(0, progress)) * total;
  let traveled = 0;
  for (let i = 0; i + 1 < target.length; i += 1) {
    const a = target[i]!;
    const b = target[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (traveled + len >= goal && len > 0) {
      const f = (goal - traveled) / len;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    traveled += len;
  }
  return { ...target[target.length - 1]! };
}

export function analyzeTransition(pieces: readonly RoutePiece[], target: readonly Vec2[], incoming: StrokeWindow, outgoing: StrokeWindow, radiusMeters: number = GRAPH_SHAPE.followRadiusMeters, lookMeters = 60): TransitionAnalysis {
  const corner = incoming.end;
  const cornerPoint = pointAtProgress(target, corner);
  let best = Number.POSITIVE_INFINITY;
  let bestPiece: RoutePiece | null = null;
  for (const p of pieces) {
    const mid = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
    const d = Math.hypot(mid.x - cornerPoint.x, mid.y - cornerPoint.y);
    if (d < best) {
      best = d;
      bestPiece = p;
    }
  }
  const near = pieces.filter((p) => Math.hypot((p.a.x + p.b.x) / 2 - cornerPoint.x, (p.a.y + p.b.y) / 2 - cornerPoint.y) <= radiusMeters);
  const inc = near.filter((p) => p.progress >= incoming.start && p.progress < corner);
  const out = near.filter((p) => p.progress >= corner && p.progress <= outgoing.end);
  const signed = (list: RoutePiece[]) => weightedMean(list.map((p) => (p.reverse ? -p.agreement : p.agreement)), list.map((p) => p.length));
  const pieceAt = (meters: number) => {
    let chosen: RoutePiece | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const p of pieces) {
      const delta = Math.abs(p.routeMeters - meters);
      if (delta < bestDelta) {
        bestDelta = delta;
        chosen = p;
      }
    }
    return chosen && bestDelta <= lookMeters / 2 ? chosen : null;
  };
  const after = bestPiece ? pieces.filter((p) => p.index > bestPiece!.index) : [];
  const continuesIntoOutgoing = after.some((p) => inWindow(p, outgoing, coverageThresholdMeters(target)) && p.progress > corner + (outgoing.end - outgoing.start) * 0.15);
  return {
    cornerProgress: corner,
    cornerPoint,
    nearestRouteDistanceMeters: best,
    reachedCorner: best <= radiusMeters,
    incomingSignedAgreement: signed(inc),
    outgoingSignedAgreement: signed(out),
    incomingMeters: inc.reduce((s, p) => s + p.length, 0),
    outgoingMeters: out.reduce((s, p) => s + p.length, 0),
    progressAtClosest: bestPiece?.progress ?? null,
    progressBefore: bestPiece ? pieceAt(bestPiece.routeMeters - lookMeters)?.progress ?? null : null,
    progressAfter: bestPiece ? pieceAt(bestPiece.routeMeters + lookMeters)?.progress ?? null : null,
    continuesIntoOutgoing,
  };
}

// ---------------------------------------------------------------------------
// Graph-edge directional feasibility (Steps 13-14).
// ---------------------------------------------------------------------------

export type GraphEdgeDirectionSummary = {
  undirectedEdgesNearWindow: number;
  nearEdgeMeters: number;
  /** Every undirected segment near the window has BOTH directed copies in the search's graph (no one-way restriction). */
  allBidirectional: boolean;
  /** Length-weighted acute delta between near edges and the local target heading. */
  meanAcuteDeltaDeg: number | null;
  /** Fraction of near-edge length within 30° / 45° (acute) of the target heading. */
  alignedFraction30: number;
  alignedFraction45: number;
  /** Of the directed copies whose search `forwardness` is positive (i.e. walks the window in increasing target progress), fraction whose geometric heading is also non-reverse. */
  forwardCopyHeadingConsistency: number | null;
};

export function summarizeGraphEdgesNearWindow(directed: Map<string, Directed>, target: readonly Vec2[], window: StrokeWindow, radiusMeters: number = coverageThresholdMeters(target)): GraphEdgeDirectionSummary {
  const seen = new Set<string>();
  const deltas: number[] = [];
  const weights: number[] = [];
  let allBidirectional = true;
  let fwdCopies = 0;
  let fwdConsistent = 0;
  for (const edge of directed.values()) {
    if (edge.id.includes('#start')) continue;
    const base = edge.id.replace(/[><]$/, '');
    const mid = edge.points[Math.floor(edge.points.length / 2)] ?? edge.points[0]!;
    const hit = projectOntoTarget(mid, target);
    if (hit.perpendicularDistance > radiusMeters || hit.progress < window.start || hit.progress > window.end) continue;
    const a = edge.points[0]!;
    const b = edge.points[edge.points.length - 1]!;
    const h = headingAgreement(headingRadians(a, b), hit.targetHeading);
    if (edge.forwardness > 0) {
      fwdCopies += 1;
      if (!h.reverse) fwdConsistent += 1;
    }
    if (seen.has(base)) continue;
    seen.add(base);
    if (!directed.has(edge.reverseId)) allBidirectional = false;
    deltas.push(h.deltaDegrees);
    weights.push(edge.length);
  }
  const total = weights.reduce((s, w) => s + w, 0);
  const within = (deg: number) => (total > 0 ? deltas.reduce((s, d, i) => s + (d <= deg ? weights[i]! : 0), 0) / total : 0);
  return {
    undirectedEdgesNearWindow: seen.size,
    nearEdgeMeters: total,
    allBidirectional,
    meanAcuteDeltaDeg: weightedMean(deltas, weights),
    alignedFraction30: within(30),
    alignedFraction45: within(45),
    forwardCopyHeadingConsistency: fwdCopies > 0 ? fwdConsistent / fwdCopies : null,
  };
}

export type DirectionalFeasibility = {
  pathFound: boolean;
  directionallySupported: boolean;
  directionalDetourRatio: number | null;
  meanHeadingDeltaDeg: number | null;
  reverseFraction: number | null;
  signedAgreement: number | null;
  pathMeters: number | null;
  straightMeters: number;
  /** Distance from the path's first / last point to the window's true start / end point. */
  startGapMeters: number | null;
  endGapMeters: number | null;
  reason: string;
};

function nearestNodeIds(nodes: Record<string, Vec2>, point: Vec2, k: number): string[] {
  const entries = Object.entries(nodes).map(([id, p]) => ({ id, d: Math.hypot(p.x - point.x, p.y - point.y) }));
  entries.sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));
  return entries.slice(0, k).map((e) => e.id);
}

/**
 * Diagnostic-only bounded Dijkstra (by edge length) from the K nodes nearest
 * the window's START to the K nodes nearest its END, restricted to directed
 * edges whose every sample lies within GRAPH_SHAPE.corridorMeters of the
 * window's own target slice. The path's headings are then scored against
 * the local target heading with the shared headingAgreement convention.
 * Nothing here feeds back into any search.
 */
export function directionalFeasibilityShadow(directed: Map<string, Directed>, nodes: Record<string, Vec2>, target: readonly Vec2[], window: StrokeWindow, corridorMeters: number = GRAPH_SHAPE.corridorMeters, k: number = DIRECTION_THRESHOLDS.endpointK): DirectionalFeasibility {
  const T = DIRECTION_THRESHOLDS;
  const startPoint = pointAtProgress(target, window.start);
  const endPoint = pointAtProgress(target, window.end);
  const straightMeters = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
  const slice: Vec2[] = [];
  for (let i = 0; i <= 24; i += 1) slice.push(pointAtProgress(target, window.start + ((window.end - window.start) * i) / 24));
  const distToSlice = (p: Vec2) => projectPointOnPolyline(p, slice).distance;

  const allowed = new Map<string, Directed[]>();
  for (const edge of directed.values()) {
    if (edge.id.includes('#start')) continue;
    if (!edge.points.every((p) => distToSlice(p) <= corridorMeters)) continue;
    const list = allowed.get(edge.from) ?? [];
    list.push(edge);
    allowed.set(edge.from, list);
  }
  const fromNodes = new Set(nearestNodeIds(nodes, startPoint, k));
  const toNodes = new Set(nearestNodeIds(nodes, endPoint, k));

  const dist = new Map<string, number>();
  const prev = new Map<string, Directed>();
  const visited = new Set<string>();
  const queue: Array<{ node: string; d: number }> = [];
  for (const n of fromNodes) {
    dist.set(n, 0);
    queue.push({ node: n, d: 0 });
  }
  let reached: string | null = null;
  while (queue.length > 0) {
    queue.sort((a, b) => a.d - b.d);
    const cur = queue.shift()!;
    if (visited.has(cur.node)) continue;
    visited.add(cur.node);
    if (toNodes.has(cur.node) && !fromNodes.has(cur.node)) {
      reached = cur.node;
      break;
    }
    for (const edge of allowed.get(cur.node) ?? []) {
      const nd = cur.d + edge.length;
      if (nd < (dist.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, edge);
        queue.push({ node: edge.to, d: nd });
      }
    }
  }
  if (!reached) {
    return { pathFound: false, directionallySupported: false, directionalDetourRatio: null, meanHeadingDeltaDeg: null, reverseFraction: null, signedAgreement: null, pathMeters: null, straightMeters, startGapMeters: null, endGapMeters: null, reason: 'no corridor-bounded path between window endpoints' };
  }
  const edges: Directed[] = [];
  let cursor = reached;
  while (prev.has(cursor)) {
    const e = prev.get(cursor)!;
    edges.push(e);
    cursor = e.from;
  }
  edges.reverse();
  const points: Vec2[] = [];
  for (const e of edges) points.push(...(points.length ? e.points.slice(1) : e.points));
  // Scored against the window's OWN slice, not the whole target: near a
  // corner the whole-target projection snaps to the adjacent stroke and
  // would score a correct diagonal edge against the top/bottom heading.
  const pieces = buildRoutePieces(points, slice);
  const w = pieces.map((p) => p.length);
  const total = w.reduce((s, v) => s + v, 0);
  const meanDelta = weightedMean(pieces.map((p) => p.fullDeltaDeg), w);
  const reverseFraction = total > 0 ? pieces.filter((p) => p.reverse).reduce((s, p) => s + p.length, 0) / total : 0;
  const signed = weightedMean(pieces.map((p) => (p.reverse ? -p.agreement : p.agreement)), w);
  const pathMeters = dist.get(reached)!;
  const detour = straightMeters > 1e-6 ? pathMeters / straightMeters : 1;
  // The path must actually span the window: its ends must lie within the
  // existing near-miss tolerance (nearMissMultiplier x on-ink radius) of the
  // window's true endpoints. Without this, K-nearest snapping can pick nodes
  // well inside the window and "support" only a fraction of the stroke.
  const endpointTolerance = coverageThresholdMeters(target) * TARGET_IDENTITY.nearMissMultiplier;
  const startGapMeters = points.length ? Math.hypot(points[0]!.x - startPoint.x, points[0]!.y - startPoint.y) : Number.POSITIVE_INFINITY;
  const endGapMeters = points.length ? Math.hypot(points[points.length - 1]!.x - endPoint.x, points[points.length - 1]!.y - endPoint.y) : Number.POSITIVE_INFINITY;
  const spans = startGapMeters <= endpointTolerance && endGapMeters <= endpointTolerance;
  const ok = spans && detour <= T.maxDetourRatio && (meanDelta ?? 180) <= T.maxMeanHeadingDeltaDeg && reverseFraction <= T.maxReverseFraction;
  return {
    pathFound: true,
    directionallySupported: ok,
    directionalDetourRatio: detour,
    meanHeadingDeltaDeg: meanDelta,
    reverseFraction,
    signedAgreement: signed,
    pathMeters,
    straightMeters,
    startGapMeters,
    endGapMeters,
    reason: ok ? 'supported' : `${spans ? '' : `endpointGap start=${startGapMeters.toFixed(0)}m end=${endGapMeters.toFixed(0)}m (tol ${endpointTolerance.toFixed(0)}m) `}detour=${detour.toFixed(2)} meanDelta=${(meanDelta ?? NaN).toFixed(0)} reverseFrac=${reverseFraction.toFixed(2)}`,
  };
}

// ---------------------------------------------------------------------------
// Where does target progress stop?
// ---------------------------------------------------------------------------

export type ProgressStop = {
  maxOnTargetProgress: number | null;
  finalPieceProgress: number | null;
  finalPiecePerpendicular: number | null;
};

export function progressStop(pieces: readonly RoutePiece[], target: readonly Vec2[]): ProgressStop {
  const radius = coverageThresholdMeters(target);
  const on = pieces.filter((p) => p.perpendicularDistance <= radius);
  const last = pieces[pieces.length - 1] ?? null;
  return {
    maxOnTargetProgress: on.length ? Math.max(...on.map((p) => p.progressB)) : null,
    finalPieceProgress: last?.progressB ?? null,
    finalPiecePerpendicular: last?.perpendicularDistance ?? null,
  };
}
