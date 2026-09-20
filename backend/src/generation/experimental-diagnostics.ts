/**
 * DEVELOPMENT ONLY. Explains experimental no_viable_shape without changing
 * generation, scoring, or product thresholds.
 */
import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { distanceMeters } from '@/lib/shape-projection';

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
} from './graph-constrained-pipeline';
import { NEIGHBORHOOD_COLLECT } from './graph-shape-router';
import {
  getPlacementRadiusForTargetDistance,
  getSearchRadiusForTargetDistance,
} from './search-radius';
import { identitySearchOrigin, SEARCH_ORIGIN_SNAP, type SearchOriginSnap } from './snap-search-origin';
import { STREET_FIT_SEARCH } from './street-fit-search';

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
  };
}

function snapshotRouted(route: GeneratedRoute, context: ProductThresholdContext = {}): CandidateSnapshot {
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
