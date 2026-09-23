/**
 * DEVELOPMENT ONLY. History-record assembly tests (buildExperimentalHistoryRecord).
 * Does not change generation, scoring, or product thresholds.
 */
import type { GeneratedRoute } from '../types';
import {
  buildExperimentalHistoryRecord,
  buildExperimentalViabilityDiagnostics,
  EXPERIMENTAL_ALGORITHM_VERSION,
} from './experimental-diagnostics';
import type {
  ExperimentalPipelineReport,
  FeasibilityRecord,
  GraphSearchMetricStats,
  RouteLengthSample,
  StreetFitFunnelDiagnostics,
} from './graph-constrained-pipeline';

type SelfTest = { name: string; passed: boolean; detail: string };

function routed(partial: {
  id: string;
  shapeScore: number;
  coverage: number;
  order: number;
  shapeRouteMeters?: number;
  totalDistanceMeters?: number;
}): GeneratedRoute {
  return {
    id: partial.id,
    source: 'valhalla',
    developmentOnly: true,
    coordinates: [
      { latitude: 30.06, longitude: 31.22 },
      { latitude: 30.061, longitude: 31.22 },
    ],
    targetCoordinates: [
      { latitude: 30.06, longitude: 31.22 },
      { latitude: 30.061, longitude: 31.22 },
    ],
    shapeCoordinates: [
      { latitude: 30.06, longitude: 31.22 },
      { latitude: 30.061, longitude: 31.22 },
    ],
    connectorCoordinates: [],
    distanceMeters: partial.totalDistanceMeters ?? 2000,
    shapeScore: partial.shapeScore,
    coverage: partial.coverage,
    scoreBreakdown: {
      proximity: 0.5,
      coverage: partial.coverage,
      order: partial.order,
      lengthFit: 0.5,
      detour: 0.5,
      backtrack: 0.5,
      finalScore: partial.shapeScore,
    },
    metadata: {
      rotationDegrees: 0,
      scale: 1,
      placement: 'offset',
      offsetAcrossMeters: 800,
      method: 'graph_constrained',
      connectedFromStart: true,
      connected: true,
      startSnapDistanceMeters: 0,
      lengthError: 0,
      distanceError: 0,
      detourRatio: 0,
      backtrackRatio: 0.05,
      score: { score: partial.shapeScore } as GeneratedRoute['metadata']['score'],
      largestGap: 0.05,
      eastMeters: 0,
      northMeters: 800,
      distanceFromUserMeters: 800,
      headingAgreementDegrees: 15,
      shapeRouteDistanceMeters: partial.shapeRouteMeters ?? 1800,
      totalDistanceMeters: partial.totalDistanceMeters ?? 2000,
      connectorDistanceMeters: 200,
    },
  };
}

function feasibility(partial: Partial<FeasibilityRecord> & { placementId: string; feasible: boolean }): FeasibilityRecord {
  return {
    rotationDegrees: 0,
    scale: 1,
    eastMeters: 0,
    northMeters: 800,
    streetFitScore: 0.5,
    discoveryScore: 0.4,
    coverage: 0.2,
    headingAgreementDegrees: 40,
    forwardProgress: 0.4,
    backtracking: 0.1,
    largestGap: 0.5,
    meanPerpendicularError: 40,
    connected: partial.feasible,
    failureReason: partial.feasible ? null : 'poor target-progress coverage',
    shapeRouteMeters: 1800,
    target: [],
    pathPoints: partial.feasible ? [{ x: 0, y: 0 }, { x: 10, y: 0 }] : [],
    graphLines: [],
    result: {} as FeasibilityRecord['result'],
    ...partial,
  };
}

const streetFitFunnel: StreetFitFunnelDiagnostics = {
  totalPlacements: 1360,
  feasibilityTop: 96,
  allScores: { count: 1360, min: 0, max: 0.9, mean: 0.3, median: 0.28, p25: 0.15, p75: 0.42 },
  top96Scores: { count: 96, min: 0.55, max: 0.9, mean: 0.68, median: 0.66, p25: 0.6, p75: 0.75 },
  graphFeasibleCount: 1,
  graphRejectedCount: 0,
  feasibleStreetFitRank: { count: 1, min: 3, max: 3, mean: 3, median: 3, p25: 3, p75: 3 },
};

const graphSearchStats: { feasible: GraphSearchMetricStats; rejected: GraphSearchMetricStats } = {
  feasible: {
    count: 1,
    targetCoverage: { count: 1, min: 0.7, max: 0.7, mean: 0.7, median: 0.7, p25: 0.7, p75: 0.7 },
    headingAgreementDegrees: { count: 1, min: 20, max: 20, mean: 20, median: 20, p25: 20, p75: 20 },
    forwardProgress: { count: 1, min: 0.8, max: 0.8, mean: 0.8, median: 0.8, p25: 0.8, p75: 0.8 },
    backtracking: { count: 1, min: 0.05, max: 0.05, mean: 0.05, median: 0.05, p25: 0.05, p75: 0.05 },
    routeDistanceMeters: { count: 1, min: 1800, max: 1800, mean: 1800, median: 1800, p25: 1800, p75: 1800 },
    discoveryScore: { count: 1, min: 0.7, max: 0.7, mean: 0.7, median: 0.7, p25: 0.7, p75: 0.7 },
    streetFitScore: { count: 1, min: 0.6, max: 0.6, mean: 0.6, median: 0.6, p25: 0.6, p75: 0.6 },
    streetFitRank: { count: 1, min: 3, max: 3, mean: 3, median: 3, p25: 3, p75: 3 },
  },
  rejected: {
    count: 0,
    targetCoverage: { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null },
    headingAgreementDegrees: { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null },
    forwardProgress: { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null },
    backtracking: { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null },
    routeDistanceMeters: { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null },
    discoveryScore: { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null },
    streetFitScore: { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null },
    streetFitRank: { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null },
  },
};

const routeLengthSamples: RouteLengthSample[] = [
  {
    placementId: 'l',
    targetDistanceMeters: 2000,
    shapeRouteMeters: 1800,
    connectorDistanceMeters: 200,
    totalDistanceMeters: 2000,
    shapeRouteRatio: 0.9,
    totalRatio: 1.0,
    quality: 'excellent',
    usedStraightFallback: false,
  },
];

function report(input: { word: string; routes: GeneratedRoute[]; feasibility: FeasibilityRecord[] }): ExperimentalPipelineReport {
  const graphFeasible = input.feasibility.filter((item) => item.feasible).length;
  return {
    word: input.word,
    routes: input.routes,
    diagnostics: {
      placementsEvaluated: 1360,
      graphFeasible,
      placementsRejected: input.feasibility.length - graphFeasible,
      placementsRouted: input.routes.length,
      graphEdgesExamined: 100,
      searchStates: 10,
      valhallaLocateCalls: 11,
      valhallaRouteCalls: 1,
      valhallaTraceRouteCalls: 0,
      neighborhoodRadiusMeters: 2400,
      placementRadiusMeters: 800,
      feasibility: input.feasibility,
      routingAttempts: [],
      successPlacementRank: {
        placementId: 'sf-r315-s0.6-e565.7-n565.7',
        streetFitRank: -1,
        inFeasibilityTop96: false,
        graphFeasible: null,
      },
      searchOriginSnap: {
        originalLatitude: 30.06,
        originalLongitude: 31.22,
        snappedLatitude: 30.0601,
        snappedLongitude: 31.2201,
        snapDistanceMeters: 12,
        snapped: true,
      },
      graphNodeCount: 42,
      streetFitFunnel,
      graphSearchStats,
      routeLengthSamples,
    },
  } as unknown as ExperimentalPipelineReport;
}

const L = routed({ id: 'l', shapeScore: 0.9, coverage: 0.85, order: 0.88 });
const pipelineReport = report({
  word: 'L',
  routes: [L],
  feasibility: [feasibility({ placementId: 'l', feasible: true, coverage: 0.7 })],
});
const viability = buildExperimentalViabilityDiagnostics(
  { word: 'L', latitude: 30.06, longitude: 31.22, targetDistance: 2000 },
  pipelineReport,
);
const history = buildExperimentalHistoryRecord(
  { word: 'L', latitude: 30.06, longitude: 31.22, targetDistance: 2000 },
  pipelineReport,
  viability,
);

const tests: SelfTest[] = [
  {
    name: 'history record carries the current algorithm version',
    passed: history.algorithmVersion === EXPERIMENTAL_ALGORITHM_VERSION && history.algorithmVersion === 'baseline-2026-09',
    detail: history.algorithmVersion,
  },
  {
    name: 'route-length ratio stats are computed from the pipeline route-length samples',
    passed:
      history.routeLength.routedRatios.shapeRouteRatio.count === 1 &&
      history.routeLength.routedRatios.shapeRouteRatio.mean === 0.9 &&
      history.routeLength.routedRatios.totalRatio.mean === 1.0,
    detail: JSON.stringify(history.routeLength.routedRatios),
  },
  {
    name: 'final accepted candidates carry their individual length sample',
    passed:
      history.routeLength.finalAccepted.length === 1 &&
      history.routeLength.finalAccepted[0]?.placementId === 'l' &&
      history.routeLength.finalAccepted[0]?.usedStraightFallback === false,
    detail: JSON.stringify(history.routeLength.finalAccepted),
  },
  {
    name: 'street-fit funnel and graph-search stats pass through from the pipeline report',
    passed:
      history.streetFitFunnel?.totalPlacements === 1360 &&
      history.streetFitFunnel?.feasibilityTop === 96 &&
      history.graphSearchStats?.feasible.count === 1,
    detail: JSON.stringify({ funnel: history.streetFitFunnel, graph: history.graphSearchStats?.feasible.count }),
  },
  {
    name: 'product-gate candidates include per-metric values and an accepted flag',
    passed:
      history.productGate.candidates.length === 1 &&
      history.productGate.candidates[0]?.placementId === 'l' &&
      history.productGate.candidates[0]?.shapeScore === 0.9 &&
      typeof history.productGate.candidates[0]?.accepted === 'boolean',
    detail: JSON.stringify(history.productGate.candidates),
  },
  {
    name: 'neighborhood graph node count is threaded through',
    passed: history.neighborhood.graphNodeCount === 42 && history.neighborhood.graphEdgeCount === 100,
    detail: JSON.stringify(history.neighborhood),
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
