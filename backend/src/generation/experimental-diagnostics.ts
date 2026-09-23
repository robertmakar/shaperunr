/**
 * DEVELOPMENT ONLY. Explains experimental no_viable_shape without changing
 * generation, scoring, or product thresholds.
 */
import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import type { LetterShapeVariant } from '@/lib/letter-shapes';
import { distanceMeters } from '@/lib/shape-projection';

import { appendExperimentalHistoryRecord } from '../diagnostics/experimental-history';
import { summarizeNumbers, type NumberDistribution } from '../diagnostics/stats';
import type { GeneratedRoute } from '../types';
import {
  EXPERIMENTAL_PRODUCT,
  experimentalProductRejectionReasons,
  meetsExperimentalProductThreshold,
  type ExperimentalGenerateRoutesResponse,
  type ProductRuleName,
  type ProductThresholdContext,
} from './experimental-product';
import {
  EXPERIMENTAL_PIPELINE,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
  type GraphSearchMetricStats,
  type RouteLengthSample,
  type SharedCandidatePoolDiagnostics,
  type StreetFitFunnelDiagnostics,
} from './graph-constrained-pipeline';
import { NEIGHBORHOOD_COLLECT } from './graph-shape-router';
import {
  getPlacementRadiusForTargetDistance,
  getSearchRadiusForTargetDistance,
} from './search-radius';
import { identitySearchOrigin, SEARCH_ORIGIN_SNAP, type SearchOriginSnap } from './snap-search-origin';
import { STREET_FIT_SEARCH } from './street-fit-search';
import { analyzeGeneratedRouteIdentity } from './target-identity';

/**
 * Explicit, hand-set label for the current route-generation algorithm —
 * deliberately not derived from git or any other dynamic source, so it only
 * changes when someone decides the algorithm has changed enough to deserve
 * a new name (e.g. "prefilter-v1", "adaptive-search-v1"). Every persisted
 * history record carries this value, so records from different algorithm
 * versions can be told apart later.
 */
export const EXPERIMENTAL_ALGORITHM_VERSION = 'baseline-2026-09';

export const ZAMALEK_CONTROL = { latitude: 30.0619, longitude: 31.2195 };
export const DOWNTOWN_CONTROL = { latitude: 30.0444, longitude: 31.2357 };

export type { ProductRuleName } from './experimental-product';

export type ExperimentalRequestLog = {
  word: string;
  latitude: number;
  longitude: number;
  targetDistance: number;
};

export type StageCounts = {
  placementsEvaluated: number;
  streetFitRanked: number;
  graphFeasibilityPool: number;
  streetFitPassThreshold: number;
  graphFeasible: number;
  graphRejected: number;
  routedBeforeProduct: number;
  productCoveragePass: number;
  productOrderPass: number;
  productShapeScorePass: number;
  productBacktrackPass: number;
  productGapPass: number;
  productConnectedPass: number;
  productAccepted: number;
};

export type CandidateSnapshot = {
  id: string;
  feasible: boolean;
  failureReason: string | null;
  streetFitScore?: number;
  graphCoverage: number;
  headingAgreementDegrees: number;
  forwardProgress?: number;
  backtrack: number;
  largestGap: number;
  connected: boolean;
  shapeScore?: number;
  shapeMatchCoverage?: number;
  order?: number;
  rotation: number;
  scale: number;
  eastMeters: number;
  northMeters: number;
  distanceFromUserMeters: number;
  shapeRouteMeters: number;
  productRejections: ProductRuleName[];
  /** Identity metrics (target-identity.ts) — null when not computed (e.g. a feasibility snapshot, which never reaches product gating). */
  targetSpan: number | null;
  lengthRatio: number | null;
  traversesMostOfWord: boolean | null;
  lettersVisitedInOrder: boolean | null;
};

export type ExperimentalViabilityDiagnostics = {
  received: ExperimentalRequestLog;
  search: {
    placementRadiusMeters: number;
    neighborhoodRadiusMeters: number;
    locateRadiusMeters: number;
    distanceFromZamalekMeters: number;
    distanceFromDowntownMeters: number;
    usedDowntownFallback: boolean;
    homeDefaultDistanceMeters: 2000;
    controlledLDistanceMeters: 2500;
    controlledODistanceMeters: 1500;
    originSnap: SearchOriginSnap;
  };
  stages: StageCounts;
  graphFailureReasons: Record<string, number>;
  bestGraphCandidate: CandidateSnapshot | null;
  bestRoutedBeforeProduct: CandidateSnapshot | null;
  rejectedBy: string;
  notes: string[];
};

const ZAMALEK_TOLERANCE_METERS = 120;
const DOWNTOWN_TOLERANCE_METERS = 120;

let lastDiagnostics: ExperimentalViabilityDiagnostics | null = null;
let lastText = '';

export function productRejectionReasons(
  route: GeneratedRoute,
  context: ProductThresholdContext = {},
): ProductRuleName[] {
  return experimentalProductRejectionReasons(route, context);
}

export function buildExperimentalViabilityDiagnostics(
  request: ExperimentalRequestLog,
  report: ExperimentalPipelineReport,
): ExperimentalViabilityDiagnostics {
  const feasibility = report.diagnostics.feasibility;
  const routed = report.routes;
  const graphFeasible = feasibility.filter((item) => item.feasible);
  const bestGraph = [...feasibility].sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      b.discoveryScore - a.discoveryScore ||
      b.coverage - a.coverage,
  )[0];
  const bestRouted = [...routed].sort((a, b) => b.shapeScore - a.shapeScore)[0];
  const productContext = { word: request.word, targetDistance: request.targetDistance };
  const productAccepted = routed.filter((route) => meetsExperimentalProductThreshold(route, productContext));

  const stages: StageCounts = {
    placementsEvaluated: report.diagnostics.placementsEvaluated,
    streetFitRanked: report.diagnostics.placementsEvaluated,
    graphFeasibilityPool: feasibility.length,
    streetFitPassThreshold: feasibility.filter((item) => item.streetFitScore >= STREET_FIT_SEARCH.passThreshold).length,
    graphFeasible: graphFeasible.length,
    graphRejected: feasibility.filter((item) => !item.feasible).length,
    routedBeforeProduct: routed.length,
    productCoveragePass: routed.filter((route) => route.coverage >= EXPERIMENTAL_PRODUCT.minCoverage).length,
    productOrderPass: routed.filter((route) => route.scoreBreakdown.order >= EXPERIMENTAL_PRODUCT.minOrder).length,
    productShapeScorePass: routed.filter((route) => route.shapeScore >= EXPERIMENTAL_PRODUCT.minShapeScore).length,
    productBacktrackPass: routed.filter((route) => route.metadata.backtrackRatio <= EXPERIMENTAL_PRODUCT.maxBacktrack)
      .length,
    productGapPass: routed.filter((route) => (route.metadata.largestGap ?? 1) <= EXPERIMENTAL_PRODUCT.maxLargestGap)
      .length,
    productConnectedPass: routed.filter(
      (route) => route.metadata.connected ?? (route.shapeCoordinates?.length ?? 0) >= 2,
    ).length,
    productAccepted: productAccepted.length,
  };

  const graphFailureReasons: Record<string, number> = {};
  for (const item of feasibility) {
    if (item.feasible) {
      continue;
    }
    const reason = item.failureReason ?? 'unknown';
    graphFailureReasons[reason] = (graphFailureReasons[reason] ?? 0) + 1;
  }

  const bestGraphCandidate = bestGraph ? snapshotFeasibility(bestGraph) : null;
  const bestRoutedBeforeProduct = bestRouted ? snapshotRouted(bestRouted, productContext) : null;
  const rejectedBy = describeRejection(stages, bestGraphCandidate, bestRoutedBeforeProduct);
  const distanceFromZamalekMeters = distanceMeters(request, ZAMALEK_CONTROL);
  const distanceFromDowntownMeters = distanceMeters(request, DOWNTOWN_CONTROL);
  const originSnap =
    report.diagnostics.searchOriginSnap ??
    identitySearchOrigin({ latitude: request.latitude, longitude: request.longitude });
  const notes = buildNotes(request, distanceFromZamalekMeters, distanceFromDowntownMeters, stages);
  notes.push(
    `Search origin street-lock: raw ${originSnap.originalLatitude}, ${originSnap.originalLongitude} → ${originSnap.snappedLatitude}, ${originSnap.snappedLongitude}  snapped=${originSnap.snapped}  snapDistance=${originSnap.snapDistanceMeters.toFixed(1)} m  radius=${SEARCH_ORIGIN_SNAP.radiusMeters} m.`,
  );
  if (originSnap.snapped) {
    notes.push('Neighborhood collection and placements use the snapped origin. The connector still starts from the raw GPS.');
  }

  return {
    received: request,
    search: {
      placementRadiusMeters: getPlacementRadiusForTargetDistance(request.targetDistance),
      neighborhoodRadiusMeters: getSearchRadiusForTargetDistance(request.targetDistance),
      locateRadiusMeters: NEIGHBORHOOD_COLLECT.locateRadiusMeters,
      distanceFromZamalekMeters,
      distanceFromDowntownMeters,
      usedDowntownFallback: distanceFromDowntownMeters < DOWNTOWN_TOLERANCE_METERS,
      homeDefaultDistanceMeters: 2000,
      controlledLDistanceMeters: 2500,
      controlledODistanceMeters: 1500,
      originSnap,
    },
    stages,
    graphFailureReasons,
    bestGraphCandidate,
    bestRoutedBeforeProduct,
    rejectedBy,
    notes,
  };
}

export function formatExperimentalViabilityDiagnostics(diagnostics: ExperimentalViabilityDiagnostics): string {
  const d = diagnostics;
  const s = d.stages;
  const lines = [
    'DEVELOPMENT / experimental viability diagnostics',
    '(logging only — generation and thresholds unchanged)',
    '',
    `received word=${d.received.word} latitude=${d.received.latitude} longitude=${d.received.longitude} targetDistance=${d.received.targetDistance} m`,
    `search origin ${d.search.originSnap.snappedLatitude}, ${d.search.originSnap.snappedLongitude} snapped=${d.search.originSnap.snapped} snapDistance=${d.search.originSnap.snapDistanceMeters.toFixed(1)} m radius=${SEARCH_ORIGIN_SNAP.radiusMeters} m`,
    `search placementRadius=${d.search.placementRadiusMeters} m  neighborhood=${d.search.neighborhoodRadiusMeters} m  locate=${d.search.locateRadiusMeters} m`,
    `distance from Zamalek control ${Math.round(d.search.distanceFromZamalekMeters)} m  downtown control ${Math.round(d.search.distanceFromDowntownMeters)} m  downtownFallback=${d.search.usedDowntownFallback}`,
    '',
    `placements evaluated ${s.placementsEvaluated}  graph pool ${s.graphFeasibilityPool}  street-fit>=${STREET_FIT_SEARCH.passThreshold} in pool ${s.streetFitPassThreshold}`,
    `graph-feasible ${s.graphFeasible}  graph-rejected ${s.graphRejected}  routed before product ${s.routedBeforeProduct}  product accepted ${s.productAccepted}`,
    `product passes: coverage ${s.productCoveragePass}  order ${s.productOrderPass}  shapeScore ${s.productShapeScorePass}  backtrack ${s.productBacktrackPass}  gap ${s.productGapPass}  connected ${s.productConnectedPass}`,
    `graph failure reasons: ${formatCounts(d.graphFailureReasons)}`,
    '',
    `rejectedBy: ${d.rejectedBy}`,
    '',
    formatSnapshot('best graph candidate', d.bestGraphCandidate),
    formatSnapshot('best routed BEFORE product threshold', d.bestRoutedBeforeProduct),
    '',
    'notes:',
    ...d.notes.map((note) => `- ${note}`),
  ];
  return lines.join('\n');
}

export function rememberExperimentalDiagnostics(diagnostics: ExperimentalViabilityDiagnostics): void {
  lastDiagnostics = diagnostics;
  lastText = formatExperimentalViabilityDiagnostics(diagnostics);
  console.log(`\n${lastText}\n`);
}

export function getLastExperimentalDiagnostics(): {
  json: ExperimentalViabilityDiagnostics | null;
  text: string;
} {
  return { json: lastDiagnostics, text: lastText };
}

export function attachExperimentalDiagnostics(
  body: ExperimentalGenerateRoutesResponse,
  diagnostics: ExperimentalViabilityDiagnostics,
): ExperimentalGenerateRoutesResponse & { diagnostics: ExperimentalViabilityDiagnostics } {
  return { ...body, diagnostics };
}

/** One routed candidate's product-gate metrics and outcome — used only by the history record, never by gating itself. */
export type ProductGateCandidateSnapshot = {
  placementId: string;
  shapeScore: number;
  coverage: number;
  order: number;
  backtrack: number;
  largestGap: number | null;
  targetSpan: number | null;
  lengthRatio: number | null;
  traversesMostOfWord: boolean | null;
  lettersVisitedInOrder: boolean | null;
  accepted: boolean;
  rejectionReasons: ProductRuleName[];
  geometryVariant?: LetterShapeVariant;
};

/** A routed candidate's length breakdown, as persisted in history (mirrors RouteLengthSample from the pipeline). */
export type RouteLengthHistorySample = {
  placementId: string;
  targetDistanceMeters: number;
  shapeRouteMeters: number;
  connectorDistanceMeters: number;
  totalDistanceMeters: number;
  shapeRouteRatio: number;
  totalRatio: number;
  quality: string;
  usedStraightFallback: boolean;
};

/**
 * One append-only history record for one /generate-routes-experimental
 * request. Deliberately holds only aggregates and small per-candidate
 * metric summaries (never full geometry/coordinate arrays), so the ndjson
 * history file stays small across many requests.
 */
export type ExperimentalHistoryRecord = {
  timestamp: string;
  algorithmVersion: string;
  request: {
    word: string;
    targetDistanceMeters: number;
    latitude: number;
    longitude: number;
  };
  searchOrigin: {
    snappedLatitude: number | null;
    snappedLongitude: number | null;
    snapped: boolean;
    snapDistanceMeters: number;
    fallbackReason: string | null;
  };
  neighborhood: {
    searchRadiusMeters: number;
    placementRadiusMeters: number;
    graphEdgeCount: number;
    graphNodeCount: number | null;
  };
  placement: {
    placementsEvaluated: number;
    feasibilityTop: number;
    graphFeasibilityPoolSize: number;
  };
  outcomeCounts: {
    graphFeasible: number;
    graphRejected: number;
    routedBeforeProduct: number;
    finalAccepted: number;
  };
  graphFailureReasons: Record<string, number>;
  gateCounts: StageCounts;
  bestGraphCandidate: CandidateSnapshot | null;
  bestRoutedBeforeProduct: CandidateSnapshot | null;
  routeLength: {
    /** Ratio distributions across every candidate that reached the routing stage, weak or not. */
    routedRatios: {
      shapeRouteRatio: NumberDistribution;
      totalRatio: NumberDistribution;
    };
    /** Individual (lightweight, no geometry) length metrics for every routed candidate — small (≤ routeTop). */
    samples: RouteLengthHistorySample[];
    bestRoutedBeforeProduct: RouteLengthHistorySample | null;
    finalAccepted: RouteLengthHistorySample[];
  };
  streetFitFunnel: StreetFitFunnelDiagnostics | null;
  graphSearchStats: { feasible: GraphSearchMetricStats; rejected: GraphSearchMetricStats } | null;
  /** Present only for a shared-budget multi-variant request — see runSharedBudgetGeometryPipeline. */
  sharedCandidatePool: SharedCandidatePoolDiagnostics | null;
  productGate: {
    candidates: ProductGateCandidateSnapshot[];
  };
  /**
   * Per-letter-geometry breakdown (see runExperimentalPipelineMultiVariant)
   * — one entry per variant actually requested. On an ordinary single-variant
   * request this has exactly one key ('smooth' unless the caller asked for
   * something else) whose numbers match the top-level fields above.
   */
  geometryVariants: Record<string, PerVariantHistorySummary>;
};

/** One letter-geometry variant's own candidate-quality/length distributions and outcome counts, for comparing e.g. smooth vs angular. */
export type PerVariantHistorySummary = {
  graphFeasibleCount: number;
  routedCount: number;
  acceptedCount: number;
  shapeScore: NumberDistribution;
  coverage: NumberDistribution;
  order: NumberDistribution;
  backtrack: NumberDistribution;
  largestGap: NumberDistribution;
  targetSpan: NumberDistribution;
  shapeDistanceMeters: NumberDistribution;
  routeDistanceMeters: NumberDistribution;
  shapeTargetRatio: NumberDistribution;
  routeTargetRatio: NumberDistribution;
  wordTraversalPassRate: { passed: number; total: number } | null;
  lettersVisitedInOrderPassRate: { passed: number; total: number } | null;
};

/**
 * Builds the full history record for one request from the pipeline report
 * and the already-computed viability diagnostics — pure/read-only, does not
 * persist anything itself (see `persistExperimentalHistory`).
 */
export function buildExperimentalHistoryRecord(
  request: ExperimentalRequestLog,
  report: ExperimentalPipelineReport,
  diagnostics: ExperimentalViabilityDiagnostics,
): ExperimentalHistoryRecord {
  const productContext = { word: request.word, targetDistance: request.targetDistance };
  const samples: RouteLengthHistorySample[] = (report.diagnostics.routeLengthSamples ?? []).map((sample) => ({
    placementId: sample.placementId,
    targetDistanceMeters: sample.targetDistanceMeters,
    shapeRouteMeters: sample.shapeRouteMeters,
    connectorDistanceMeters: sample.connectorDistanceMeters,
    totalDistanceMeters: sample.totalDistanceMeters,
    shapeRouteRatio: sample.shapeRouteRatio,
    totalRatio: sample.totalRatio,
    quality: sample.quality,
    usedStraightFallback: sample.usedStraightFallback,
  }));
  const sampleById = new Map(samples.map((sample) => [sample.placementId, sample]));
  const bestRoutedBeforeProduct = diagnostics.bestRoutedBeforeProduct
    ? sampleById.get(diagnostics.bestRoutedBeforeProduct.id) ?? null
    : null;
  const finalAccepted = report.routes.map((route) => sampleById.get(route.id)).filter(
    (sample): sample is RouteLengthHistorySample => sample != null,
  );

  return {
    timestamp: new Date().toISOString(),
    algorithmVersion: EXPERIMENTAL_ALGORITHM_VERSION,
    request: {
      word: request.word,
      targetDistanceMeters: request.targetDistance,
      latitude: request.latitude,
      longitude: request.longitude,
    },
    searchOrigin: {
      snappedLatitude: diagnostics.search.originSnap.snapped ? diagnostics.search.originSnap.snappedLatitude : null,
      snappedLongitude: diagnostics.search.originSnap.snapped ? diagnostics.search.originSnap.snappedLongitude : null,
      snapped: diagnostics.search.originSnap.snapped,
      snapDistanceMeters: diagnostics.search.originSnap.snapDistanceMeters,
      fallbackReason: diagnostics.search.originSnap.fallbackReason ?? null,
    },
    neighborhood: {
      searchRadiusMeters: diagnostics.search.neighborhoodRadiusMeters,
      placementRadiusMeters: diagnostics.search.placementRadiusMeters,
      graphEdgeCount: report.diagnostics.graphEdgesExamined,
      graphNodeCount: report.diagnostics.graphNodeCount ?? null,
    },
    placement: {
      placementsEvaluated: report.diagnostics.placementsEvaluated,
      feasibilityTop: EXPERIMENTAL_PIPELINE.feasibilityTop,
      graphFeasibilityPoolSize: report.diagnostics.feasibility.length,
    },
    outcomeCounts: {
      graphFeasible: diagnostics.stages.graphFeasible,
      graphRejected: diagnostics.stages.graphRejected,
      routedBeforeProduct: diagnostics.stages.routedBeforeProduct,
      finalAccepted: diagnostics.stages.productAccepted,
    },
    graphFailureReasons: diagnostics.graphFailureReasons,
    gateCounts: diagnostics.stages,
    bestGraphCandidate: diagnostics.bestGraphCandidate,
    bestRoutedBeforeProduct: diagnostics.bestRoutedBeforeProduct,
    routeLength: {
      routedRatios: {
        shapeRouteRatio: summarizeNumbers(samples.map((sample) => sample.shapeRouteRatio)),
        totalRatio: summarizeNumbers(samples.map((sample) => sample.totalRatio)),
      },
      samples,
      bestRoutedBeforeProduct,
      finalAccepted,
    },
    streetFitFunnel: report.diagnostics.streetFitFunnel ?? null,
    graphSearchStats: report.diagnostics.graphSearchStats ?? null,
    sharedCandidatePool: report.diagnostics.sharedCandidatePool ?? null,
    productGate: {
      candidates: buildProductGateCandidates(report.routes, productContext),
    },
    geometryVariants: buildGeometryVariantSummaries(report, productContext),
  };
}

/**
 * One summary per letter-geometry variant present in this report, derived
 * by grouping the report's own `geometryVariant`-tagged data
 * (diagnostics.feasibility, diagnostics.routingAttempts,
 * diagnostics.routeLengthSamples, routes) by that tag — works uniformly
 * whether the report came from a single-variant request (every record
 * tagged with the one requested variant) or the shared-budget multi-variant
 * pipeline (records tagged per-candidate, since a single shared top-96 pool
 * can mix variants — see runSharedBudgetGeometryPipeline). "Accepted" is
 * evaluated against the same product threshold used for the real response,
 * applied to the merged (post-dedupe) route list, so it answers "of the
 * routes actually offered to the user, how many came from this variant"
 * rather than a variant-isolated count that could double-count a route
 * another variant also found.
 */
function buildGeometryVariantSummaries(
  report: ExperimentalPipelineReport,
  context: ProductThresholdContext,
): Record<string, PerVariantHistorySummary> {
  const variants = new Set<string>();
  for (const item of report.diagnostics.feasibility ?? []) {
    if (item.geometryVariant) variants.add(item.geometryVariant);
  }
  for (const route of report.routes) {
    if (route.metadata.geometryVariant) variants.add(route.metadata.geometryVariant);
  }
  if (variants.size === 0) {
    // No per-record tags at all (older/foreign report shape) — fall back to the one report-level variant.
    variants.add(report.diagnostics.geometryVariant);
  }

  const acceptedIds = new Set(
    report.routes.filter((route) => meetsExperimentalProductThreshold(route, context)).map((route) => route.id),
  );
  const allCandidates = buildProductGateCandidates(report.routes, context);
  const summaries: Record<string, PerVariantHistorySummary> = {};
  for (const variant of variants) {
    const candidates = allCandidates.filter((candidate) => candidate.geometryVariant === variant);
    const lengthSamples = (report.diagnostics.routeLengthSamples ?? []).filter((sample) => sample.geometryVariant === variant);
    const graphFeasibleCount = (report.diagnostics.feasibility ?? []).filter(
      (item) => item.geometryVariant === variant && item.feasible,
    ).length;
    const routedCount = lengthSamples.length;
    const acceptedCount = report.routes.filter(
      (route) => route.metadata.geometryVariant === variant && acceptedIds.has(route.id),
    ).length;
    const wordy = candidates.filter((candidate) => candidate.traversesMostOfWord != null);
    const ordered = candidates.filter((candidate) => candidate.lettersVisitedInOrder != null);
    summaries[variant] = {
      graphFeasibleCount,
      routedCount,
      acceptedCount,
      shapeScore: summarizeNumbers(candidates.map((candidate) => candidate.shapeScore)),
      coverage: summarizeNumbers(candidates.map((candidate) => candidate.coverage)),
      order: summarizeNumbers(candidates.map((candidate) => candidate.order)),
      backtrack: summarizeNumbers(candidates.map((candidate) => candidate.backtrack)),
      largestGap: summarizeNumbers(candidates.map((candidate) => candidate.largestGap).filter(isFiniteNumber)),
      targetSpan: summarizeNumbers(candidates.map((candidate) => candidate.targetSpan).filter(isFiniteNumber)),
      shapeDistanceMeters: summarizeNumbers(lengthSamples.map((sample) => sample.shapeRouteMeters)),
      routeDistanceMeters: summarizeNumbers(lengthSamples.map((sample) => sample.totalDistanceMeters)),
      shapeTargetRatio: summarizeNumbers(lengthSamples.map((sample) => sample.shapeRouteRatio)),
      routeTargetRatio: summarizeNumbers(lengthSamples.map((sample) => sample.totalRatio)),
      wordTraversalPassRate:
        wordy.length > 0
          ? { passed: wordy.filter((candidate) => candidate.traversesMostOfWord === true).length, total: wordy.length }
          : null,
      lettersVisitedInOrderPassRate:
        ordered.length > 0
          ? {
              passed: ordered.filter((candidate) => candidate.lettersVisitedInOrder === true).length,
              total: ordered.length,
            }
          : null,
    };
  }
  return summaries;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function buildProductGateCandidates(
  routes: GeneratedRoute[],
  context: ProductThresholdContext,
): ProductGateCandidateSnapshot[] {
  return routes.map((route) => {
    const shape = route.shapeCoordinates ?? route.coordinates;
    const identity =
      shape.length >= 2 && route.targetCoordinates.length >= 2
        ? analyzeGeneratedRouteIdentity(route, { word: context.word ?? '', targetDistance: context.targetDistance ?? 0 })
        : null;
    const rejections = experimentalProductRejectionReasons(route, context);
    return {
      placementId: route.id,
      shapeScore: route.shapeScore,
      coverage: route.coverage,
      order: route.scoreBreakdown.order,
      backtrack: route.metadata.backtrackRatio,
      largestGap: route.metadata.largestGap ?? null,
      targetSpan: identity?.targetSpan ?? null,
      lengthRatio: identity ? (identity.lengthRatioRequested ?? identity.lengthRatioProjected) : null,
      traversesMostOfWord: identity?.traversesMostOfWord ?? null,
      lettersVisitedInOrder: identity?.lettersVisitedInOrder ?? null,
      accepted: rejections.length === 0,
      rejectionReasons: rejections,
      geometryVariant: route.metadata.geometryVariant,
    };
  });
}

/**
 * Builds this request's history record and appends it to the ndjson
 * history file. Best-effort like the file-append itself — see
 * experimental-history.ts — a failure here must never affect the response
 * already sent to the app.
 */
export function persistExperimentalHistory(
  request: ExperimentalRequestLog,
  report: ExperimentalPipelineReport,
  diagnostics: ExperimentalViabilityDiagnostics,
): void {
  try {
    appendExperimentalHistoryRecord(buildExperimentalHistoryRecord(request, report, diagnostics));
  } catch (error) {
    console.log('[experimental-history] build failed', error instanceof Error ? error.message : error);
  }
}

function snapshotFeasibility(item: FeasibilityRecord): CandidateSnapshot {
  return {
    id: item.placementId,
    feasible: item.feasible,
    failureReason: item.failureReason,
    streetFitScore: item.streetFitScore,
    graphCoverage: item.coverage,
    headingAgreementDegrees: item.headingAgreementDegrees,
    forwardProgress: item.forwardProgress,
    backtrack: item.backtracking,
    largestGap: item.largestGap,
    connected: item.connected,
    rotation: item.rotationDegrees,
    scale: item.scale,
    eastMeters: item.eastMeters,
    northMeters: item.northMeters,
    distanceFromUserMeters: Math.round(Math.hypot(item.eastMeters, item.northMeters)),
    shapeRouteMeters: item.shapeRouteMeters,
    productRejections: [],
    targetSpan: null,
    lengthRatio: null,
    traversesMostOfWord: null,
    lettersVisitedInOrder: null,
  };
}

function snapshotRouted(route: GeneratedRoute, context: ProductThresholdContext = {}): CandidateSnapshot {
  const shape = route.shapeCoordinates ?? route.coordinates;
  const identity =
    shape.length >= 2 && route.targetCoordinates.length >= 2
      ? analyzeGeneratedRouteIdentity(route, { word: context.word ?? '', targetDistance: context.targetDistance ?? 0 })
      : null;
  return {
    id: route.id,
    feasible: true,
    failureReason: route.metadata.failureReason ?? null,
    graphCoverage: route.coverage,
    headingAgreementDegrees: route.metadata.headingAgreementDegrees ?? 0,
    backtrack: route.metadata.backtrackRatio,
    largestGap: route.metadata.largestGap ?? 0,
    connected: route.metadata.connected ?? (route.shapeCoordinates?.length ?? 0) >= 2,
    shapeScore: route.shapeScore,
    shapeMatchCoverage: route.coverage,
    order: route.scoreBreakdown.order,
    rotation: route.metadata.rotationDegrees,
    scale: route.metadata.scale,
    eastMeters: route.metadata.eastMeters ?? 0,
    northMeters: route.metadata.northMeters ?? 0,
    distanceFromUserMeters: route.metadata.distanceFromUserMeters ?? route.metadata.offsetAcrossMeters,
    shapeRouteMeters: route.metadata.shapeRouteDistanceMeters ?? 0,
    productRejections: productRejectionReasons(route, context),
    targetSpan: identity?.targetSpan ?? null,
    lengthRatio: identity ? (identity.lengthRatioRequested ?? identity.lengthRatioProjected) : null,
    traversesMostOfWord: identity?.traversesMostOfWord ?? null,
    lettersVisitedInOrder: identity?.lettersVisitedInOrder ?? null,
  };
}

function describeRejection(
  stages: StageCounts,
  bestGraph: CandidateSnapshot | null,
  bestRouted: CandidateSnapshot | null,
): string {
  if (stages.productAccepted > 0) {
    return 'none (product accepted at least one route)';
  }
  if (stages.graphFeasible === 0) {
    return `graph_feasibility: ${bestGraph?.failureReason ?? 'no graph-feasible placement in top pool'}`;
  }
  if (stages.routedBeforeProduct === 0) {
    return `pipeline_quality: graph-feasible placements were classified weak (shapeScore < ${EXPERIMENTAL_PIPELINE.acceptableShapeScore}) before routing/product`;
  }
  if (bestRouted && bestRouted.productRejections.length > 0) {
    return `product_threshold: ${bestRouted.productRejections.join(',')}`;
  }
  return 'product_threshold: no routed candidate met EXPERIMENTAL_PRODUCT';
}

function buildNotes(
  request: ExperimentalRequestLog,
  distanceFromZamalekMeters: number,
  distanceFromDowntownMeters: number,
  stages: StageCounts,
): string[] {
  const notes: string[] = [
    `Home sends distance in km × 1000. Default experimental chip is 2 km → 2000 m. Controlled L was 2500 m, controlled O was 1500 m.`,
    `Placements translate within ${getPlacementRadiusForTargetDistance(request.targetDistance)} m. Neighborhood graph is collected within ${getSearchRadiusForTargetDistance(request.targetDistance)} m.`,
    `FIND MY ROUTE requests foreground GPS automatically. Downtown fallback ${DEVELOPMENT_FALLBACK_LOCATION.latitude}, ${DEVELOPMENT_FALLBACK_LOCATION.longitude} is only used if coordinates are missing.`,
  ];
  if (distanceFromDowntownMeters < DOWNTOWN_TOLERANCE_METERS) {
    notes.push(
      'Request is at/near downtown Cairo fallback. Controlled L/O successes were in Zamalek, not here. Downtown 4 km ROBZ previously had 0 graph-feasible placements.',
    );
  }
  if (distanceFromZamalekMeters > 1500) {
    notes.push(
      `Request is ${Math.round(distanceFromZamalekMeters)} m from the Zamalek control point. The proven L/O streets are outside this search unless the user is actually there.`,
    );
  }
  if (request.word === 'L' && request.targetDistance === 4000) {
    notes.push(
      'L at 4000 m uses a scaled neighborhood and placement range. Proven successes were 2000–2500 m; 4 km success is not guaranteed if the streets cannot form an L.',
    );
  }
  if (request.word === 'O') {
    notes.push(
      'Controlled O in Zamalek at 1500 m was graph-feasible but failed the product threshold (rectangular loop: score 0.604, coverage 0.45, order 0.346). Product rejection of O is expected even in Zamalek.',
    );
  }
  if (stages.graphFeasible === 0) {
    notes.push('Search area / street network is the likely limiter: nothing in the graph-feasibility pool could follow the letter.');
  }
  return notes;
}

function formatSnapshot(title: string, snapshot: CandidateSnapshot | null): string {
  if (!snapshot) {
    return `${title}: none`;
  }
  return [
    `${title}: ${snapshot.id}`,
    `  feasible=${snapshot.feasible} failure=${snapshot.failureReason ?? 'none'} productRejections=${snapshot.productRejections.join(',') || 'none'}`,
    `  shapeScore=${fmt(snapshot.shapeScore)} coverage=${fmt(snapshot.shapeMatchCoverage ?? snapshot.graphCoverage)} order=${fmt(snapshot.order)} backtrack=${fmt(snapshot.backtrack)} gap=${fmt(snapshot.largestGap)} connected=${snapshot.connected}`,
    `  graphCoverage=${fmt(snapshot.graphCoverage)} heading=${fmt(snapshot.headingAgreementDegrees)}° rot=${snapshot.rotation} scale=${snapshot.scale}`,
    `  offset east=${snapshot.eastMeters} n=${snapshot.northMeters} distanceFromUser=${snapshot.distanceFromUserMeters} m shapeRoute=${Math.round(snapshot.shapeRouteMeters)} m`,
  ].join('\n');
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

function fmt(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(3);
}
