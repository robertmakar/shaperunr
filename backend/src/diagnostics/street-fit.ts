import {
  headingRadians,
  polylineLength,
  projectPointOnPolyline,
  shortestAngleDelta,
  type Vec2,
} from '@/lib/geometry';

export const STREET_FIT = {
  nearbyRadiusMeters: 75,
  usableRadiusMeters: 50,
  headingAgreeDegrees: 60,
  binCount: 48,
  maxLetterGapFraction: 0.28,
} as const;

export type TargetRegion = {
  id: string;
  startProgress: number;
  endProgress: number;
};

export type EdgeSample = {
  wayId: string;
  point: Vec2;
  progress: number;
  perpendicularDistance: number;
  targetHeading: number;
  edgeHeading: number | null;
  headingAgreement: number | null;
  reverse: boolean | null;
};

export type AnalyzedWay = {
  wayId: string;
  samples: EdgeSample[];
  lengthMeters: number;
  meanPerpendicularDistance: number;
  meanHeadingAgreement: number | null;
  forwardRatio: number | null;
};

export type RegionFit = {
  id: string;
  startProgress: number;
  endProgress: number;
  targetLengthMeters: number;
  availableEdgeLengthMeters: number;
  bestPerpendicularDistance: number;
  meanHeadingAgreement: number | null;
  forwardCoverage: number;
  usableWayCount: number;
  coverage: number;
  maxGapMeters: number;
  plausibleContinuousPath: boolean;
  routedPathFeasible: boolean | null;
  routedMeanDistance: number | null;
  routedOrder: number | null;
};

export type StreetFitSummary = {
  targetLengthMeters: number;
  pedestrianGraphCoverage: number;
  meanBestDistance: number;
  maximumGapMeters: number;
  forwardProgressCoverage: number;
  connectedPathFeasibility: number;
  usableWayCount: number;
};

export function projectOntoTarget(point: Vec2, target: readonly Vec2[]) {
  const hit = projectPointOnPolyline(point, target);
  const start = target[hit.segmentIndex];
  const end = target[hit.segmentIndex + 1] ?? start;
  const targetHeading =
    start && end && (start.x !== end.x || start.y !== end.y) ? headingRadians(start, end) : 0;
  return {
    progress: hit.progress,
    perpendicularDistance: hit.distance,
    closest: hit.point,
    targetHeading,
    segmentIndex: hit.segmentIndex,
  };
}

export function headingAgreement(
  edgeHeading: number,
  targetHeading: number,
): { agreement: number; reverse: boolean; deltaDegrees: number } {
  const delta = Math.abs(shortestAngleDelta(edgeHeading, targetHeading));
  const reverse = delta > Math.PI / 2;
  const acute = reverse ? Math.PI - delta : delta;
  return {
    agreement: clamp01(1 - acute / (Math.PI / 2)),
    reverse,
    deltaDegrees: (acute * 180) / Math.PI,
  };
}

export function forwardRatio(progresses: readonly number[]): number | null {
  if (progresses.length < 2) {
    return null;
  }
  let forward = 0;
  let backward = 0;
  for (let index = 1; index < progresses.length; index += 1) {
    const delta = (progresses[index] ?? 0) - (progresses[index - 1] ?? 0);
    if (delta > 1e-6) {
      forward += delta;
    } else if (delta < -1e-6) {
      backward += -delta;
    }
  }
  const total = forward + backward;
  return total === 0 ? null : forward / total;
}

export function detectCoverageGaps(
  progresses: readonly number[],
  targetLengthMeters: number,
  binCount: number = STREET_FIT.binCount,
): { coverage: number; maxGapMeters: number; uncoveredBins: number[] } {
  if (binCount <= 0 || targetLengthMeters <= 0) {
    return { coverage: 0, maxGapMeters: targetLengthMeters, uncoveredBins: [] };
  }
  const covered = new Array(binCount).fill(false);
  for (const progress of progresses) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(progress * binCount)));
    covered[index] = true;
  }
  let uncovered = 0;
  let run = 0;
  let maxRun = 0;
  const uncoveredBins: number[] = [];
  for (let index = 0; index < binCount; index += 1) {
    if (covered[index]) {
      run = 0;
      continue;
    }
    uncovered += 1;
    run += 1;
    maxRun = Math.max(maxRun, run);
    uncoveredBins.push(index);
  }
  return {
    coverage: 1 - uncovered / binCount,
    maxGapMeters: (maxRun / binCount) * targetLengthMeters,
    uncoveredBins,
  };
}

export function detectCoverageSpans(
  spans: ReadonlyArray<{ start: number; end: number }>,
  targetLengthMeters: number,
  binCount: number = STREET_FIT.binCount,
): { coverage: number; maxGapMeters: number; uncoveredBins: number[] } {
  const progresses: number[] = [];
  for (const span of spans) {
    const start = Math.min(span.start, span.end);
    const end = Math.max(span.start, span.end);
    const steps = Math.max(2, Math.ceil((end - start) * binCount) + 1);
    for (let index = 0; index < steps; index += 1) {
      progresses.push(start + ((end - start) * index) / (steps - 1));
    }
  }
  return detectCoverageGaps(progresses, targetLengthMeters, binCount);
}

export function analyzeWaySamples(wayId: string, points: readonly Vec2[], target: readonly Vec2[]): AnalyzedWay {
  const ordered = orderAlongPrincipalAxis(points);
  const samples: EdgeSample[] = ordered.map((point, index) => {
    const projection = projectOntoTarget(point, target);
    const previous = ordered[index - 1];
    const next = ordered[index + 1];
    const edgeHeading = previous
      ? headingRadians(previous, point)
      : next
        ? headingRadians(point, next)
        : null;
    const heading = edgeHeading == null ? null : headingAgreement(edgeHeading, projection.targetHeading);
    return {
      wayId,
      point,
      progress: projection.progress,
      perpendicularDistance: projection.perpendicularDistance,
      targetHeading: projection.targetHeading,
      edgeHeading,
      headingAgreement: heading?.agreement ?? null,
      reverse: heading?.reverse ?? null,
    };
  });

  const progresses = samples.map((sample) => sample.progress);
  const agreements = samples
    .map((sample) => sample.headingAgreement)
    .filter((value): value is number => value != null);

  return {
    wayId,
    samples,
    lengthMeters: polylineLength(ordered),
    meanPerpendicularDistance: mean(samples.map((sample) => sample.perpendicularDistance)),
    meanHeadingAgreement: agreements.length === 0 ? null : mean(agreements),
    forwardRatio: forwardRatio(progresses),
  };
}

export function usableSamples(
  samples: readonly EdgeSample[],
  usableRadius = STREET_FIT.usableRadiusMeters,
): EdgeSample[] {
  const minAgreement = 1 - STREET_FIT.headingAgreeDegrees / 90;
  return samples.filter((sample) => {
    if (sample.perpendicularDistance > usableRadius) {
      return false;
    }
    // Reverse-digitized OSM ways still count: pedestrians can walk either way.
    // Heading agreement already uses the acute angle to the local ROBZ tangent.
    if (sample.headingAgreement == null || sample.headingAgreement < minAgreement) {
      return false;
    }
    return true;
  });
}

export type StreetFitVerdict = 'constructor_gap' | 'graph_disconnected' | 'graph_gap';

export function streetFitVerdict(
  summary: StreetFitSummary,
  regions: readonly RegionFit[] = [],
): {
  verdict: StreetFitVerdict;
  reason: string;
} {
  const coverage = summary.pedestrianGraphCoverage;
  const feasible = summary.connectedPathFeasibility;
  const distance = summary.meanBestDistance;
  const close = Number.isFinite(distance) && distance <= STREET_FIT.usableRadiusMeters;
  const orders = regions
    .map((region) => region.routedOrder)
    .filter((value): value is number => value != null);
  const meanOrder = orders.length === 0 ? null : orders.reduce((sum, value) => sum + value, 0) / orders.length;

  if (coverage >= 0.45 && feasible >= 0.75 && close && meanOrder != null && meanOrder >= 0.8) {
    return {
      verdict: 'constructor_gap',
      reason:
        'Nearby pedestrian streets cover the drawing and a Valhalla walk follows the letters closely, so the constructor is likely missing streets that exist.',
    };
  }
  if (coverage >= 0.3 && close) {
    return {
      verdict: 'graph_disconnected',
      reason:
        'Cairo has plenty of pedestrian streets in this ROBZ corridor, but those streets form a dense mesh rather than letter-shaped paths. A walk can stay near the ink without being recognizable as ROBZ.',
    };
  }
  return {
    verdict: 'graph_gap',
    reason:
      "Cairo's pedestrian street graph does not have enough aligned coverage to approximate this ROBZ geometry.",
  };
}

export function aggregateRegion(
  region: TargetRegion,
  ways: readonly AnalyzedWay[],
  targetLengthMeters: number,
): RegionFit {
  const span = Math.max(region.endProgress - region.startProgress, 1e-6);
  const regionLength = span * targetLengthMeters;
  const inRegion = (sample: EdgeSample) =>
    sample.progress >= region.startProgress && sample.progress <= region.endProgress;

  const regionWays = ways
    .map((way) => ({
      ...way,
      samples: way.samples.filter(inRegion),
    }))
    .filter((way) => way.samples.length > 0);

  const usable = usableSamples(regionWays.flatMap((way) => way.samples));
  const usableWays = new Set(usable.map((sample) => sample.wayId));
  const availableLength = regionWays.reduce((sum, way) => sum + polylineLength(way.samples.map((sample) => sample.point)), 0);
  const bestDistance = usable.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...usable.map((sample) => sample.perpendicularDistance));
  const headingValues = usable
    .map((sample) => sample.headingAgreement)
    .filter((value): value is number => value != null);
  const normalizedProgress = usable.map((sample) => (sample.progress - region.startProgress) / span);
  const gaps = detectCoverageGaps(normalizedProgress, regionLength, 16);
  const forwardValues = regionWays
    .map((way) => way.forwardRatio)
    .filter((value): value is number => value != null);

  const plausibleContinuousPath =
    gaps.coverage >= 0.45 &&
    gaps.maxGapMeters <= regionLength * STREET_FIT.maxLetterGapFraction + 40 &&
    usableWays.size >= 1 &&
    Number.isFinite(bestDistance) &&
    bestDistance <= STREET_FIT.usableRadiusMeters;

  return {
    id: region.id,
    startProgress: region.startProgress,
    endProgress: region.endProgress,
    targetLengthMeters: regionLength,
    availableEdgeLengthMeters: availableLength,
    bestPerpendicularDistance: bestDistance,
    meanHeadingAgreement: headingValues.length === 0 ? null : mean(headingValues),
    forwardCoverage: forwardValues.length === 0 ? 0 : mean(forwardValues),
    usableWayCount: usableWays.size,
    coverage: gaps.coverage,
    maxGapMeters: gaps.maxGapMeters,
    plausibleContinuousPath,
    routedPathFeasible: null,
    routedMeanDistance: null,
    routedOrder: null,
  };
}

export function summarizeStreetFit(
  regions: readonly RegionFit[],
  ways: readonly AnalyzedWay[],
  targetLengthMeters: number,
): StreetFitSummary {
  const allUsable = usableSamples(ways.flatMap((way) => way.samples));
  const gaps = detectCoverageGaps(
    allUsable.map((sample) => sample.progress),
    targetLengthMeters,
  );
  const bestDistances = regions
    .map((region) => region.bestPerpendicularDistance)
    .filter((value) => Number.isFinite(value));
  const feasible = regions.filter((region) => region.plausibleContinuousPath).length;

  return {
    targetLengthMeters,
    pedestrianGraphCoverage: gaps.coverage,
    meanBestDistance: bestDistances.length === 0 ? Number.POSITIVE_INFINITY : mean(bestDistances),
    maximumGapMeters: gaps.maxGapMeters,
    forwardProgressCoverage: mean(regions.map((region) => region.forwardCoverage)),
    connectedPathFeasibility: regions.length === 0 ? 0 : feasible / regions.length,
    usableWayCount: new Set(allUsable.map((sample) => sample.wayId)).size,
  };
}

export function regionsFromLetterLengths(letters: Array<{ id: string; length: number }>): TargetRegion[] {
  const total = letters.reduce((sum, letter) => sum + letter.length, 0);
  if (total <= 0) {
    return [];
  }
  let cursor = 0;
  return letters.map((letter) => {
    const startProgress = cursor / total;
    cursor += letter.length;
    return {
      id: letter.id,
      startProgress,
      endProgress: cursor / total,
    };
  });
}

function orderAlongPrincipalAxis(points: readonly Vec2[]): Vec2[] {
  if (points.length < 2) {
    return points.map((point) => ({ ...point }));
  }
  const origin = points[0] as Vec2;
  const axis = points.reduce(
    (best, point) => {
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      return Math.hypot(dx, dy) > Math.hypot(best.x, best.y) ? { x: dx, y: dy } : best;
    },
    { x: 0, y: 0 },
  );
  const axisLength = Math.hypot(axis.x, axis.y) || 1;
  return [...points]
    .sort((a, b) => {
      const aProj = ((a.x - origin.x) * axis.x + (a.y - origin.y) * axis.y) / axisLength;
      const bProj = ((b.x - origin.x) * axis.x + (b.y - origin.y) * axis.y) / axisLength;
      return aProj - bProj;
    })
    .map((point) => ({ ...point }));
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
