/**
 * DEVELOPMENT ONLY. A–Z route-discovery coverage audit.
 *
 * Reuses the production experimental pipeline, settings, graph search, and
 * product thresholds. Connector routing is disabled because it does not
 * affect shape feasibility or product acceptance.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';
import type { Vec2 } from '@/lib/geometry';
import { getLetterShape } from '@/lib/letter-shapes';
import { dimensionsForTargetLength, distanceMeters, offsetCoordinate } from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

import { scorePolylines, shapeScoreBreakdown } from '../scoring/shape-match';
import {
  EXPERIMENTAL_PRODUCT,
  meetsExperimentalProductThreshold,
} from '../generation/experimental-product';
import { analyzeTargetIdentity } from '../generation/target-identity';
import {
  EXPERIMENTAL_PIPELINE,
  runExperimentalPipeline,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { collectNeighborhoodShapeGraph } from '../generation/graph-shape-router';
import {
  getPlacementRingsForTargetDistance,
  getSearchRadiusForTargetDistance,
} from '../generation/search-radius';
import {
  searchOriginFromSnap,
  snapSearchOrigin,
  type SearchOriginSnap,
} from '../generation/snap-search-origin';
import {
  buildStreetFitPlacements,
} from '../generation/street-fit-search';

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
export const LETTER_COVERAGE_DISTANCES = [2000, 4000] as const;
export const LETTER_COVERAGE_LOCATIONS = [
  {
    id: 'downtown-cairo',
    name: 'Downtown Cairo',
    coordinate: { latitude: 30.0444, longitude: 31.2357 },
  },
  {
    id: 'zamalek',
    name: 'Zamalek',
    coordinate: { latitude: 30.0619, longitude: 31.2195 },
  },
  {
    id: 'alexandria',
    name: 'Alexandria',
    coordinate: {
      latitude: 31.227549356302422,
      longitude: 29.94947010481379,
    },
  },
] as const;

export type LetterCoverageStatus =
  | 'PASS'
  | 'GRAPH_FEASIBLE'
  | 'NEAR_MISS'
  | 'NO_STREET_FIT'
  | 'NO_CANDIDATE'
  | 'ROUTE_FAILED';

export type LetterGeometryMetrics = {
  letter: string;
  aspectRatio: number;
  pathLength: number;
  strokeCount: number;
  segmentCount: number;
  sharpTurnCount: number;
  intersectionCount: number;
  closed: boolean;
  minimumFeatureSize: number;
  targetScale: Record<
    string,
    {
      metersPerShapeUnit: number;
      widthMeters: number;
      heightMeters: number;
      candidateScaleRange: readonly number[];
    }
  >;
};

export type LetterCoverageCase = {
  letter: string;
  locationId: string;
  locationName: string;
  rawLocation: Coordinate;
  searchOrigin: Coordinate;
  targetDistanceMeters: number;
  elapsedMs: number;
  placementsEvaluated: number;
  graphEdges: number;
  streetFitPassesInPool: number;
  graphFailureReasons: Record<string, number>;
  graphFeasibleCandidates: number;
  productValidCandidates: number;
  routedCandidates: number;
  productAcceptedRoutes: number;
  best: {
    placementId: string;
    streetFitRank: number;
    streetFitScore: number;
    feasibilityScore: number;
    shapeScore: number | null;
    coverage: number;
    order: number | null;
    backtrack: number;
    largestGap: number;
    finalRouteLengthMeters: number | null;
    productRejections: string[];
  } | null;
  status: LetterCoverageStatus;
  rejectionStage: string;
  rejectionReason: string;
};

export type LocationStabilityResult = {
  locationId: string;
  locationName: string;
  targetDistanceMeters: number;
  sampleA: Coordinate;
  sampleB: Coordinate;
  snapA: SearchOriginSnap;
  snapB: SearchOriginSnap;
  snappedOriginSeparationMeters: number;
  sameWay: boolean;
  statusA: LetterCoverageStatus;
  statusB: LetterCoverageStatus;
};

export type LetterCoverageReport = {
  developmentOnly: true;
  label: string;
  generatedAt: string;
  pipelineSettings: typeof EXPERIMENTAL_PIPELINE;
  productThresholds: typeof EXPERIMENTAL_PRODUCT;
  geometries: LetterGeometryMetrics[];
  cases: LetterCoverageCase[];
  stability: LocationStabilityResult[];
  elapsedMs: number;
  summary: {
    combinations: number;
    pass: number;
    graphFeasible: number;
    productValid: number;
    statusCounts: Record<LetterCoverageStatus, number>;
    passingLetters: string[];
    graphFeasibleLetters: string[];
  };
  textReport: string;
};

type ScoredFeasible = {
  record: FeasibilityRecord;
  streetFitRank: number;
  shapeScore: number | null;
  coverage: number;
  order: number | null;
  productRejections: string[];
  productValid: boolean;
};

let lastReport: LetterCoverageReport | null = null;

export async function runLetterCoverageAudit(
  options: {
    label?: string;
    letters?: readonly string[];
    locations?: readonly {
      id: string;
      name: string;
      coordinate: Coordinate;
    }[];
    distances?: readonly number[];
    quietPipeline?: boolean;
    includeStability?: boolean;
    onCase?: (item: LetterCoverageCase) => void;
  } = {},
): Promise<LetterCoverageReport> {
  const started = Date.now();
  const label = options.label ?? 'coverage';
  const letters = options.letters ?? LETTERS;
  const locations = options.locations ?? LETTER_COVERAGE_LOCATIONS;
  const distances = options.distances ?? LETTER_COVERAGE_DISTANCES;
  const quietPipeline = options.quietPipeline ?? true;
  const cases: LetterCoverageCase[] = [];
  const stability: LocationStabilityResult[] = [];

  for (const location of locations) {
    const snap = await snapSearchOrigin(location.coordinate);
    const searchOrigin = searchOriginFromSnap(snap);

    for (const targetDistanceMeters of distances) {
      const collection = await collectNeighborhoodShapeGraph(searchOrigin, {
        radiusMeters: getSearchRadiusForTargetDistance(targetDistanceMeters),
      });
      const placements = buildStreetFitPlacements({
        translationRingsMeters: getPlacementRingsForTargetDistance(
          targetDistanceMeters,
        ),
      });

      for (const letter of letters) {
        const report = await runPipelineQuietly(
          {
            word: letter,
            start: location.coordinate,
            targetDistanceMeters,
          },
          {
            collection,
            placements,
            searchOriginSnap: snap,
            connectStart: false,
          },
          quietPipeline,
        );
        const coverageCase = buildLetterCoverageCase({
          letter,
          locationId: location.id,
          locationName: location.name,
          rawLocation: location.coordinate,
          targetDistanceMeters,
          report,
        });
        cases.push(coverageCase);
        options.onCase?.(coverageCase);
      }
    }

    if (options.includeStability ?? true) {
      stability.push(
        await evaluateLocationStability(location, quietPipeline),
      );
    }
  }

  const geometries = LETTERS.map(analyzeLetterGeometry);
  const statusCounts = emptyStatusCounts();
  for (const item of cases) {
    statusCounts[item.status] += 1;
  }
  const passingLetters = unique(
    cases.filter((item) => item.status === 'PASS').map((item) => item.letter),
  );
  const graphFeasibleLetters = unique(
    cases
      .filter((item) => item.graphFeasibleCandidates > 0)
      .map((item) => item.letter),
  );
  const summary = {
    combinations: cases.length,
    pass: cases.filter((item) => item.status === 'PASS').length,
    graphFeasible: cases.filter(
      (item) => item.graphFeasibleCandidates > 0,
    ).length,
    productValid: cases.filter(
      (item) => item.productValidCandidates > 0,
    ).length,
    statusCounts,
    passingLetters,
    graphFeasibleLetters,
  };
  const elapsedMs = Date.now() - started;
  const reportWithoutText = {
    developmentOnly: true as const,
    label,
    generatedAt: new Date().toISOString(),
    pipelineSettings: EXPERIMENTAL_PIPELINE,
    productThresholds: EXPERIMENTAL_PRODUCT,
    geometries,
    cases,
    stability,
    elapsedMs,
    summary,
  };
  const report = {
    ...reportWithoutText,
    textReport: formatLetterCoverageReport(reportWithoutText),
  };
  rememberLetterCoverageReport(report);
  return report;
}

export function rememberLetterCoverageReport(report: LetterCoverageReport): void {
  lastReport = report;
}

export function getLastLetterCoverageReport(): LetterCoverageReport | null {
  if (lastReport) {
    return lastReport;
  }
  return loadLatestLetterCoverageFile();
}

export function buildLetterCoverageCase(input: {
  letter: string;
  locationId: string;
  locationName: string;
  rawLocation: Coordinate;
  targetDistanceMeters: number;
  report: ExperimentalPipelineReport;
}): LetterCoverageCase {
  const report = input.report;
  const rankById = new Map(
    report.diagnostics.feasibility.map((item, index) => [
      item.placementId,
      index,
    ]),
  );
  const scored = report.diagnostics.feasibility
    .filter((item) => item.feasible)
    .map((item) =>
      scoreFeasible(
        item,
        rankById.get(item.placementId) ?? -1,
        input.letter,
        input.targetDistanceMeters,
      ),
    );
  const productValidCandidates = scored.filter(
    (item) => item.productValid,
  ).length;
  const productAcceptedRoutes = report.routes.filter((route) =>
    meetsExperimentalProductThreshold(route, {
      word: input.letter,
      targetDistance: input.targetDistanceMeters,
    }),
  ).length;
  const graphFailureReasons: Record<string, number> = {};
  for (const item of report.diagnostics.feasibility) {
    if (item.feasible) {
      continue;
    }
    const reason = item.failureReason ?? 'unknown';
    graphFailureReasons[reason] = (graphFailureReasons[reason] ?? 0) + 1;
  }
  const bestScored = [...scored].sort(compareScored)[0] ?? null;
  const bestGraph =
    [...report.diagnostics.feasibility].sort(
      (a, b) =>
        Number(b.feasible) - Number(a.feasible) ||
        b.discoveryScore - a.discoveryScore ||
        b.coverage - a.coverage,
    )[0] ?? null;
  const bestRecord = bestScored?.record ?? bestGraph;
  const bestRoute = bestRecord
    ? report.routes.find((route) => route.id === bestRecord.placementId) ??
      report.routes[0]
    : report.routes[0];
  const stage = classifyCoverageStage({
    placementsEvaluated: report.diagnostics.placementsEvaluated,
    graphEdges: report.diagnostics.graphEdgesExamined,
    streetFitPasses: report.diagnostics.feasibility.filter(
      (item) => item.streetFitScore >= 0.3,
    ).length,
    graphFeasible: scored.length,
    productValidCandidates,
    routedCandidates: report.routes.length,
    productAcceptedRoutes,
    bestProductRejections: bestScored?.productRejections ?? [],
    graphFailureReason: bestGraph?.failureReason ?? null,
  });

  return {
    letter: input.letter,
    locationId: input.locationId,
    locationName: input.locationName,
    rawLocation: input.rawLocation,
    searchOrigin: searchOriginFromSnap(report.diagnostics.searchOriginSnap),
    targetDistanceMeters: input.targetDistanceMeters,
    elapsedMs: report.elapsedMs,
    placementsEvaluated: report.diagnostics.placementsEvaluated,
    graphEdges: report.diagnostics.graphEdgesExamined,
    streetFitPassesInPool: report.diagnostics.feasibility.filter(
      (item) => item.streetFitScore >= 0.3,
    ).length,
    graphFailureReasons,
    graphFeasibleCandidates: scored.length,
    productValidCandidates,
    routedCandidates: report.routes.length,
    productAcceptedRoutes,
    best: bestRecord
      ? {
          placementId: bestRecord.placementId,
          streetFitRank: rankById.get(bestRecord.placementId) ?? -1,
          streetFitScore: bestRecord.streetFitScore,
          feasibilityScore: bestRecord.discoveryScore,
          shapeScore: bestScored?.shapeScore ?? null,
          coverage: bestScored?.coverage ?? bestRecord.coverage,
          order: bestScored?.order ?? null,
          backtrack: bestRecord.backtracking,
          largestGap: bestRecord.largestGap,
          finalRouteLengthMeters:
            bestRoute?.metadata.totalDistanceMeters ??
            bestRoute?.distanceMeters ??
            null,
          productRejections: bestScored?.productRejections ?? [],
        }
      : null,
    status: stage.status,
    rejectionStage: stage.stage,
    rejectionReason: stage.reason,
  };
}

export function classifyCoverageStage(input: {
  placementsEvaluated: number;
  graphEdges: number;
  streetFitPasses: number;
  graphFeasible: number;
  productValidCandidates: number;
  routedCandidates: number;
  productAcceptedRoutes: number;
  bestProductRejections: string[];
  graphFailureReason: string | null;
}): {
  status: LetterCoverageStatus;
  stage: string;
  reason: string;
} {
  if (input.productAcceptedRoutes > 0) {
    return {
      status: 'PASS',
      stage: 'accepted',
      reason: 'At least one routed candidate passes every product rule.',
    };
  }
  if (input.placementsEvaluated === 0 || input.graphEdges === 0) {
    return {
      status: 'NO_CANDIDATE',
      stage: 'candidate_generation',
      reason:
        input.graphEdges === 0
          ? 'Neighborhood collection returned no pedestrian graph edges.'
          : 'Candidate placement generation returned no placements.',
    };
  }
  if (input.streetFitPasses === 0) {
    return {
      status: 'NO_STREET_FIT',
      stage: 'street_fit',
      reason: 'No placement in the feasibility pool reached the street-fit pass score.',
    };
  }
  if (input.graphFeasible === 0) {
    return {
      status: 'ROUTE_FAILED',
      stage: 'graph_search',
      reason:
        input.graphFailureReason ??
        'No connected graph path satisfied current graph feasibility.',
    };
  }
  if (input.productValidCandidates > 0 && input.routedCandidates === 0) {
    return {
      status: 'ROUTE_FAILED',
      stage: 'route_selection',
      reason: 'A product-valid graph candidate existed but was not emitted by the current route-selection stage.',
    };
  }
  if (input.routedCandidates === 0) {
    return {
      status: 'GRAPH_FEASIBLE',
      stage: 'pipeline_quality',
      reason: 'Graph-feasible candidates existed but all failed the pipeline quality gate.',
    };
  }
  return {
    status: 'NEAR_MISS',
    stage: 'product_threshold',
    reason: `Best routed candidate rejected by: ${
      input.bestProductRejections.join(', ') || 'combined product rules'
    }.`,
  };
}

export function analyzeLetterGeometry(letter: string): LetterGeometryMetrics {
  const shape = buildWordShape(letter);
  const definition = getLetterShape(letter);
  const strokes = definition?.strokes ?? [];
  const segmentCount = strokes.reduce(
    (sum, stroke) => sum + Math.max(0, stroke.length - 1),
    0,
  );
  const minimumFeatureSize = strokes.reduce((minimum, stroke) => {
    for (let index = 1; index < stroke.length; index += 1) {
      const a = stroke[index - 1];
      const b = stroke[index];
      if (!a || !b) {
        continue;
      }
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > 1e-6) {
        minimum = Math.min(minimum, length);
      }
    }
    return minimum;
  }, Number.POSITIVE_INFINITY);
  const targetScale: LetterGeometryMetrics['targetScale'] = {};
  for (const distance of LETTER_COVERAGE_DISTANCES) {
    const dimensions = dimensionsForTargetLength(shape, distance);
    targetScale[String(distance)] = {
      metersPerShapeUnit: shape.length > 0 ? distance / shape.length : 0,
      widthMeters: dimensions.widthMeters,
      heightMeters: dimensions.heightMeters,
      candidateScaleRange: [0.6, 0.8, 1, 1.2, 1.4],
    };
  }
  return {
    letter,
    aspectRatio: shape.aspectRatio,
    pathLength: shape.length,
    strokeCount: strokes.length,
    segmentCount,
    sharpTurnCount: countSharpTurns(strokes),
    intersectionCount: countIntersections(strokes),
    closed: strokes.some(isClosedStroke),
    minimumFeatureSize: Number.isFinite(minimumFeatureSize)
      ? minimumFeatureSize
      : 0,
    targetScale,
  };
}

export function formatLetterCoverageReport(
  report: Omit<LetterCoverageReport, 'textReport'>,
): string {
  const lines = [
    `DEVELOPMENT / A-Z letter coverage (${report.label})`,
    'Production experimental settings and product thresholds unchanged.',
    `generated ${report.generatedAt}`,
    `combinations ${report.summary.combinations}  pass ${report.summary.pass}  graph-feasible ${report.summary.graphFeasible}  product-valid ${report.summary.productValid}`,
    `runtime ${report.elapsedMs} ms`,
    `status counts ${Object.entries(report.summary.statusCounts)
      .map(([status, count]) => `${status}=${count}`)
      .join(' ')}`,
    `passing letters ${report.summary.passingLetters.join(' ') || 'none'}`,
    `graph-feasible letters ${report.summary.graphFeasibleLetters.join(' ') || 'none'}`,
    '',
    'GEOMETRY',
    'letter aspect path strokes segments sharpTurns intersections closed minFeature scale2k(width×height) scale4k(width×height)',
  ];
  for (const item of report.geometries) {
    lines.push(
      `${item.letter} ${fmt(item.aspectRatio)} ${fmt(item.pathLength)} ${item.strokeCount} ${item.segmentCount} ${item.sharpTurnCount} ${item.intersectionCount} ${item.closed} ${fmt(item.minimumFeatureSize)} ${fmt(item.targetScale['2000']?.widthMeters)}x${fmt(item.targetScale['2000']?.heightMeters)} ${fmt(item.targetScale['4000']?.widthMeters)}x${fmt(item.targetScale['4000']?.heightMeters)}`,
    );
  }
  const locationOrder = uniqueKeepOrder(
    report.cases.map((item) => `${item.locationId}\t${item.locationName}`),
  );
  const distances = uniqueKeepOrder(
    report.cases.map((item) => String(item.targetDistanceMeters)),
  );
  const letters = uniqueKeepOrder(report.cases.map((item) => item.letter));
  for (const locationKey of locationOrder) {
    const [locationId, locationName] = locationKey.split('\t');
    lines.push('', `MATRIX / ${locationName}`, `letter ${distances.map((distance) => `${Number(distance) / 1000}km`).join(' ')}`);
    for (const letter of letters) {
      const statuses = distances.map(
        (distance) =>
          report.cases.find(
            (item) =>
              item.locationId === locationId &&
              item.letter === letter &&
              String(item.targetDistanceMeters) === distance,
          )?.status ?? 'n/a',
      );
      lines.push(`${letter} ${statuses.join(' ')}`);
    }
  }
  lines.push('', 'DETAILS');
  for (const item of report.cases) {
    const best = item.best;
    lines.push(
      `${item.letter} | ${item.locationName} | ${item.targetDistanceMeters}m | ${item.status}`,
    );
    lines.push(
      `  placements=${item.placementsEvaluated} streetFitPass=${item.streetFitPassesInPool} graphFeasible=${item.graphFeasibleCandidates} productValid=${item.productValidCandidates} routed=${item.routedCandidates} accepted=${item.productAcceptedRoutes} graphEdges=${item.graphEdges} runtime=${item.elapsedMs}ms`,
    );
    if (Object.keys(item.graphFailureReasons ?? {}).length > 0) {
      lines.push(
        `  graphFailures ${Object.entries(item.graphFailureReasons)
          .map(([reason, count]) => `${reason}=${count}`)
          .join(', ')}`,
      );
    }
    lines.push(
      best
        ? `  best=${best.placementId} rank=${best.streetFitRank} streetFit=${fmt(best.streetFitScore)} feasibility=${fmt(best.feasibilityScore)} shape=${fmt(best.shapeScore)} coverage=${fmt(best.coverage)} order=${fmt(best.order)} backtrack=${fmt(best.backtrack)} gap=${fmt(best.largestGap)} finalLength=${best.finalRouteLengthMeters == null ? 'n/a' : Math.round(best.finalRouteLengthMeters)} rejections=${best.productRejections.join(',') || 'none'}`
        : '  best=none',
    );
    lines.push(
      `  rejectionStage=${item.rejectionStage} reason=${item.rejectionReason}`,
    );
  }
  lines.push('', 'LOCATION STABILITY');
  for (const item of report.stability) {
    lines.push(
      `${item.locationName} ${item.targetDistanceMeters}m snapSeparation=${fmt(item.snappedOriginSeparationMeters)}m sameWay=${item.sameWay} L-status=${item.statusA}/${item.statusB}`,
    );
    lines.push(
      `  A raw=${coordinate(item.sampleA)} snap=${coordinate(searchOriginFromSnap(item.snapA))} distance=${fmt(item.snapA.snapDistanceMeters)}m`,
    );
    lines.push(
      `  B raw=${coordinate(item.sampleB)} snap=${coordinate(searchOriginFromSnap(item.snapB))} distance=${fmt(item.snapB.snapDistanceMeters)}m`,
    );
  }
  return lines.join('\n');
}

async function evaluateLocationStability(
  location: { id: string; name: string; coordinate: Coordinate },
  quietPipeline: boolean,
): Promise<LocationStabilityResult> {
  const sampleA = location.coordinate;
  const sampleB = offsetCoordinate(location.coordinate, 18, 24);
  const snapA = await snapSearchOrigin(sampleA);
  const snapB = await snapSearchOrigin(sampleB);
  const caseA = await runStabilityCase(
    location,
    sampleA,
    snapA,
    quietPipeline,
  );
  const caseB = await runStabilityCase(
    location,
    sampleB,
    snapB,
    quietPipeline,
  );
  return {
    locationId: location.id,
    locationName: location.name,
    targetDistanceMeters: 2000,
    sampleA,
    sampleB,
    snapA,
    snapB,
    snappedOriginSeparationMeters: distanceMeters(
      searchOriginFromSnap(snapA),
      searchOriginFromSnap(snapB),
    ),
    sameWay: snapA.wayId != null && snapA.wayId === snapB.wayId,
    statusA: caseA.status,
    statusB: caseB.status,
  };
}

async function runStabilityCase(
  location: { id: string; name: string; coordinate: Coordinate },
  rawLocation: Coordinate,
  snap: SearchOriginSnap,
  quietPipeline: boolean,
): Promise<LetterCoverageCase> {
  const searchOrigin = searchOriginFromSnap(snap);
  const targetDistanceMeters = 2000;
  const collection = await collectNeighborhoodShapeGraph(searchOrigin, {
    radiusMeters: getSearchRadiusForTargetDistance(targetDistanceMeters),
  });
  const report = await runPipelineQuietly(
    { word: 'L', start: rawLocation, targetDistanceMeters },
    {
      collection,
      searchOriginSnap: snap,
      connectStart: false,
    },
    quietPipeline,
  );
  return buildLetterCoverageCase({
    letter: 'L',
    locationId: location.id,
    locationName: location.name,
    rawLocation,
    targetDistanceMeters,
    report,
  });
}

async function runPipelineQuietly(
  input: Parameters<typeof runExperimentalPipeline>[0],
  options: Parameters<typeof runExperimentalPipeline>[1],
  quiet: boolean,
): Promise<ExperimentalPipelineReport> {
  if (!quiet) {
    return runExperimentalPipeline(input, options);
  }
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await runExperimentalPipeline(input, options);
  } finally {
    console.log = originalLog;
  }
}

function scoreFeasible(
  record: FeasibilityRecord,
  streetFitRank: number,
  word: string,
  targetDistanceMeters: number,
): ScoredFeasible {
  const scored =
    record.pathPoints.length >= 2
      ? scorePolylines(record.pathPoints, record.target)
      : null;
  const breakdown = scored ? shapeScoreBreakdown(scored) : null;
  const rejections: string[] = [];
  if (!record.connected) rejections.push('connected');
  if ((scored?.score ?? 0) < EXPERIMENTAL_PRODUCT.minShapeScore) rejections.push('shapeScore');
  if ((scored?.coverage ?? 0) < EXPERIMENTAL_PRODUCT.minCoverage) rejections.push('coverage');
  if ((breakdown?.order ?? 0) < EXPERIMENTAL_PRODUCT.minOrder) rejections.push('order');
  if (record.backtracking > EXPERIMENTAL_PRODUCT.maxBacktrack) rejections.push('backtrack');
  if (record.largestGap > EXPERIMENTAL_PRODUCT.maxLargestGap) rejections.push('largestGap');
  if (record.pathPoints.length >= 2 && record.target.length >= 2) {
    const identity = analyzeTargetIdentity({
      route: record.pathPoints,
      target: record.target,
      word,
      requestedDistanceMeters: targetDistanceMeters,
    });
    if (identity.targetSpan < EXPERIMENTAL_PRODUCT.minTargetSpan) rejections.push('targetSpan');
    const lengthRatio = identity.lengthRatioRequested ?? identity.lengthRatioProjected;
    if (lengthRatio < EXPERIMENTAL_PRODUCT.minLengthRatio) rejections.push('lengthRatio');
    if (word.length > 1 && !identity.traversesMostOfWord) rejections.push('wordTraversal');
  }
  return {
    record,
    streetFitRank,
    shapeScore: scored?.score ?? null,
    coverage: scored?.coverage ?? record.coverage,
    order: breakdown?.order ?? null,
    productRejections: rejections,
    productValid: scored != null && rejections.length === 0,
  };
}

function compareScored(a: ScoredFeasible, b: ScoredFeasible): number {
  return (
    Number(b.productValid) - Number(a.productValid) ||
    (b.shapeScore ?? -1) - (a.shapeScore ?? -1) ||
    b.record.discoveryScore - a.record.discoveryScore
  );
}

function countSharpTurns(strokes: readonly (readonly Vec2[])[]): number {
  let turns = 0;
  for (const stroke of strokes) {
    for (let index = 1; index < stroke.length - 1; index += 1) {
      const a = stroke[index - 1];
      const b = stroke[index];
      const c = stroke[index + 1];
      if (!a || !b || !c) continue;
      const first = Math.atan2(b.y - a.y, b.x - a.x);
      const second = Math.atan2(c.y - b.y, c.x - b.x);
      const delta = Math.abs(
        Math.atan2(Math.sin(second - first), Math.cos(second - first)),
      );
      if (delta >= Math.PI / 4) turns += 1;
    }
  }
  return turns;
}

function countIntersections(strokes: readonly (readonly Vec2[])[]): number {
  const segments = strokes.flatMap((stroke, strokeIndex) =>
    stroke.slice(1).flatMap((end, index) => {
      const start = stroke[index];
      return start
        ? [{ start, end, strokeIndex, segmentIndex: index }]
        : [];
    }),
  );
  let intersections = 0;
  for (let aIndex = 0; aIndex < segments.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < segments.length; bIndex += 1) {
      const a = segments[aIndex];
      const b = segments[bIndex];
      if (!a || !b) continue;
      if (
        a.strokeIndex === b.strokeIndex &&
        Math.abs(a.segmentIndex - b.segmentIndex) <= 1
      ) {
        continue;
      }
      if (segmentsIntersect(a.start, a.end, b.start, b.end)) {
        intersections += 1;
      }
    }
  }
  return intersections;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (p: Vec2, q: Vec2, r: Vec2) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < -1e-9 && cdA * cdB < -1e-9;
}

function isClosedStroke(stroke: readonly Vec2[]): boolean {
  const first = stroke[0];
  const last = stroke[stroke.length - 1];
  return Boolean(
    first &&
      last &&
      stroke.length >= 3 &&
      Math.hypot(first.x - last.x, first.y - last.y) < 1e-6,
  );
}

function emptyStatusCounts(): Record<LetterCoverageStatus, number> {
  return {
    PASS: 0,
    GRAPH_FEASIBLE: 0,
    NEAR_MISS: 0,
    NO_STREET_FIT: 0,
    NO_CANDIDATE: 0,
    ROUTE_FAILED: 0,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueKeepOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function loadLatestLetterCoverageFile(): LetterCoverageReport | null {
  const directory = dirname(fileURLToPath(import.meta.url));
  const preferred = ['letter-coverage-after.json', 'letter-coverage-before.json', 'letter-coverage-coverage.json'];
  for (const filename of preferred) {
    const path = resolve(directory, filename);
    if (!existsSync(path)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as LetterCoverageReport;
      if (parsed?.textReport && Array.isArray(parsed.cases)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function coordinate(value: Coordinate): string {
  return `${value.latitude.toFixed(6)},${value.longitude.toFixed(6)}`;
}

function fmt(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? 'n/a'
    : value.toFixed(3);
}
