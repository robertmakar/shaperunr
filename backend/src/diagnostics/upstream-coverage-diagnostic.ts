/**
 * DEVELOPMENT ONLY. Upstream physical-coverage diagnostics — observation
 * only, never called from the live route generation/scoring/gate path,
 * never touches graph search, street-fit ranking, or beam-search code.
 *
 * This module answers "how much of a letter's ink does the AVAILABLE
 * pedestrian graph even support, at various distance tolerances" using
 * ONLY already-captured, read-only data: FeasibilityRecord.graphLines
 * (the local graph geometry near a candidate's placement, produced by the
 * unmodified production pipeline) and FeasibilityRecord.target (the
 * unmodified projected target polyline). It never calls into
 * graph-shape.ts's search or street-fit-search.ts's ranking — it is a
 * pure geometric measurement over data those stages already produced.
 *
 * The distance thresholds compared below are read directly from the real,
 * unmodified, already-exported production constants (GRAPH_SHAPE,
 * STREET_FIT, coverageThresholdMeters) — never redefined or guessed.
 */
import { distanceToPolyline, polylineLength, resamplePolyline, type Vec2 } from '@/lib/geometry';

import { GRAPH_SHAPE } from '../generation/graph-shape';
import { STREET_FIT } from './street-fit';

/** The real, unmodified production distance thresholds active across the pipeline, gathered here only for side-by-side reporting — none are redefined. */
export const PRODUCTION_DISTANCE_THRESHOLDS = {
  /** graph-shape.ts: an edge is "aligned" (search-time) or "covering" (graphShapeScore's own targetCoverage) within this radius. */
  graphShapeFollowRadiusMeters: GRAPH_SHAPE.followRadiusMeters,
  /** graph-shape.ts: the widest corridor a starting edge may sit within. */
  graphShapeCorridorMeters: GRAPH_SHAPE.corridorMeters,
  /** street-fit-search.ts: the radius within which a street sample counts as "usable" for placement scoring (also used as scoreOrderedPath's coverageThreshold during placement ranking). */
  streetFitUsableRadiusMeters: STREET_FIT.usableRadiusMeters,
  /** street-fit-search.ts: the radius within which a street is even considered "nearby" at all. */
  streetFitNearbyRadiusMeters: STREET_FIT.nearbyRadiusMeters,
} as const;

/** Sample-count for target-letter traceability sampling — independent of, and deliberately denser than, any production sample count, since this is diagnostic-only geometric measurement. */
const TRACEABLE_SAMPLE_COUNT = 60;

export type TraceableCoverageResult = {
  thresholdMeters: number;
  sampleCount: number;
  supportedSampleCount: number;
  /** supportedSampleCount / sampleCount. */
  fraction: number;
  /** The longest run of CONSECUTIVE supported samples, as a fraction of sampleCount — distinguishes "streets scattered near the letter" from "a continuous street sequence follows the letter." */
  longestConnectedSpanFraction: number;
};

/**
 * For a given letter's own target ink (NOT the flattened word polyline —
 * pass a per-letter slice) and the candidate's already-captured nearby
 * graph geometry, computes what fraction of the letter's own length has
 * ANY graph line within `thresholdMeters`, plus the longest continuous
 * run of such support. Read-only: never mutates target or graphLines.
 */
export function computeTraceableCoverage(target: readonly Vec2[], graphLines: readonly Vec2[][], thresholdMeters: number): TraceableCoverageResult {
  if (target.length < 2) {
    return { thresholdMeters, sampleCount: 0, supportedSampleCount: 0, fraction: 0, longestConnectedSpanFraction: 0 };
  }
  const samples = resamplePolyline(target, TRACEABLE_SAMPLE_COUNT);
  const supported = samples.map((point) => graphLines.some((line) => line.length >= 2 && distanceToPolyline(point, line) <= thresholdMeters));

  let longestRun = 0;
  let currentRun = 0;
  let supportedCount = 0;
  for (const isSupported of supported) {
    if (isSupported) {
      supportedCount += 1;
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }

  return {
    thresholdMeters,
    sampleCount: samples.length,
    supportedSampleCount: supportedCount,
    fraction: samples.length === 0 ? 0 : supportedCount / samples.length,
    longestConnectedSpanFraction: samples.length === 0 ? 0 : longestRun / samples.length,
  };
}

/** Standard thresholds to sweep for every letter: the tight downstream coverage threshold (varies per letter, passed separately), plus the three looser upstream production thresholds, plus a couple of round diagnostic reference points requested by the task (20/30/45/70m). */
export const TRACEABLE_SWEEP_METERS = [20, 30, 45, 70] as const;

export type LetterTraceableProfile = {
  letter: string;
  /** target-identity.ts's real coverageThresholdMeters() for this letter's own target slice — the TIGHT, downstream, per-letter coverage gate. Never redefined here, only read via the caller passing it in (computed by the real function). */
  downstreamCoverageThresholdMeters: number;
  traceableAtDownstreamThreshold: TraceableCoverageResult;
  traceableSweep: TraceableCoverageResult[]; // one per TRACEABLE_SWEEP_METERS entry
  traceableAtGraphShapeFollowRadius: TraceableCoverageResult;
  traceableAtStreetFitUsableRadius: TraceableCoverageResult;
  traceableAtStreetFitNearbyRadius: TraceableCoverageResult;
};

export function buildLetterTraceableProfile(letter: string, letterTarget: readonly Vec2[], graphLines: readonly Vec2[][], downstreamCoverageThresholdMeters: number): LetterTraceableProfile {
  return {
    letter,
    downstreamCoverageThresholdMeters,
    traceableAtDownstreamThreshold: computeTraceableCoverage(letterTarget, graphLines, downstreamCoverageThresholdMeters),
    traceableSweep: TRACEABLE_SWEEP_METERS.map((meters) => computeTraceableCoverage(letterTarget, graphLines, meters)),
    traceableAtGraphShapeFollowRadius: computeTraceableCoverage(letterTarget, graphLines, PRODUCTION_DISTANCE_THRESHOLDS.graphShapeFollowRadiusMeters),
    traceableAtStreetFitUsableRadius: computeTraceableCoverage(letterTarget, graphLines, PRODUCTION_DISTANCE_THRESHOLDS.streetFitUsableRadiusMeters),
    traceableAtStreetFitNearbyRadius: computeTraceableCoverage(letterTarget, graphLines, PRODUCTION_DISTANCE_THRESHOLDS.streetFitNearbyRadiusMeters),
  };
}

export type UpstreamFailureClass =
  | 'passing'
  | 'graph_unavailable'
  | 'graph_available_but_disconnected'
  | 'graph_traceable_but_route_underuses_it'
  | 'unclear';

/**
 * Classification built ONLY from externally observable, read-only evidence
 * (no beam-search internals — instrumenting the search itself was ruled
 * out this pass; see the report's Section G for why categories 3 and 4
 * from the task's taxonomy — "beam discards a viable branch" vs "search
 * objective prefers proximity over traceability" — are reported as a
 * single combined bucket here rather than distinguished, since telling
 * them apart requires internal beam-state visibility this module does not
 * have access to without modifying graph-shape.ts).
 */
export function classifyUpstreamFailure(profile: LetterTraceableProfile, rawInkCoverage: number, meaningfullyVisited: boolean): UpstreamFailureClass {
  if (meaningfullyVisited) {
    return 'passing';
  }
  const looseSupport = profile.traceableAtStreetFitNearbyRadius.fraction;
  const tightSupport = profile.traceableAtDownstreamThreshold.fraction;
  const tightConnectedSpan = profile.traceableAtDownstreamThreshold.longestConnectedSpanFraction;

  if (looseSupport < 0.4) {
    return 'graph_unavailable';
  }
  if (tightSupport >= 0.4 && tightConnectedSpan < 0.4) {
    return 'graph_available_but_disconnected';
  }
  if (tightSupport >= 0.5 && tightConnectedSpan >= 0.5 && rawInkCoverage < 0.5) {
    return 'graph_traceable_but_route_underuses_it';
  }
  return 'unclear';
}
