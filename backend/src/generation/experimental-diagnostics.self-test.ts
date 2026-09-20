/**
 * DEVELOPMENT ONLY. Viability diagnostic summary tests.
 * Does not change generation.
 */
import type { GeneratedRoute } from '../types';
import {
  buildExperimentalViabilityDiagnostics,
  productRejectionReasons,
} from './experimental-diagnostics';
import type { ExperimentalPipelineReport, FeasibilityRecord } from './graph-constrained-pipeline';

type SelfTest = { name: string; passed: boolean; detail: string };

function routed(partial: {
  id: string;
  shapeScore: number;
  coverage: number;
  order: number;
  backtrack?: number;
  gap?: number;
  connected?: boolean;
  eastMeters?: number;
  northMeters?: number;
}): GeneratedRoute {
  return {
    id: partial.id,
    source: 'valhalla',
    developmentOnly: true,
    coordinates: [
      { latitude: 30.06, longitude: 31.22 },
      { latitude: 30.061, longitude: 31.22 },
    ],
    targetCoordinates: [],
    shapeCoordinates: [
      { latitude: 30.06, longitude: 31.22 },
      { latitude: 30.061, longitude: 31.22 },
    ],
    connectorCoordinates: [],
    distanceMeters: 1000,
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
      connected: partial.connected ?? true,
      startSnapDistanceMeters: 0,
      lengthError: 0,
      distanceError: 0,
      detourRatio: 0,
      backtrackRatio: partial.backtrack ?? 0,
      score: { score: partial.shapeScore } as GeneratedRoute['metadata']['score'],
      largestGap: partial.gap ?? 0.08,
      eastMeters: partial.eastMeters ?? 0,
      northMeters: partial.northMeters ?? 800,
      distanceFromUserMeters: Math.round(Math.hypot(partial.eastMeters ?? 0, partial.northMeters ?? 800)),
      headingAgreementDegrees: 20,
      shapeRouteDistanceMeters: 1000,
      totalDistanceMeters: 1000,
      connectorDistanceMeters: 0,
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
    shapeRouteMeters: 800,
    target: [],
    pathPoints: partial.feasible ? [{ x: 0, y: 0 }, { x: 10, y: 0 }] : [],
    graphLines: [],
    result: {} as FeasibilityRecord['result'],
    ...partial,
  };
}

function report(input: {
  word: string;
  routes: GeneratedRoute[];
  feasibility: FeasibilityRecord[];
}): ExperimentalPipelineReport {
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
      valhallaRouteCalls: 0,
      valhallaTraceRouteCalls: 0,
      feasibility: input.feasibility,
    },
  } as ExperimentalPipelineReport;
}

const L = routed({ id: 'l', shapeScore: 0.908, coverage: 0.88, order: 0.878 });
const O = routed({ id: 'o', shapeScore: 0.604, coverage: 0.45, order: 0.346, gap: 0.27 });

const oDiag = buildExperimentalViabilityDiagnostics(
  { word: 'O', latitude: 30.0619, longitude: 31.2195, targetDistance: 1500 },
  report({
    word: 'O',
    routes: [O],
    feasibility: [feasibility({ placementId: 'o', feasible: true, coverage: 0.69 })],
  }),
);

const emptyDiag = buildExperimentalViabilityDiagnostics(
  { word: 'L', latitude: 30.0444, longitude: 31.2357, targetDistance: 4000 },
  report({
    word: 'L',
    routes: [],
    feasibility: [feasibility({ placementId: 'fail', feasible: false })],
  }),
);

const tests: SelfTest[] = [
  {
    name: 'O diagnostic names product rules without changing generation',
    passed: oDiag.rejectedBy === 'product_threshold: shapeScore,coverage,order' && oDiag.stages.productAccepted === 0,
    detail: oDiag.rejectedBy,
  },
  {
    name: 'O best routed snapshot is before product filter',
    passed:
      oDiag.bestRoutedBeforeProduct?.shapeScore === 0.604 &&
      oDiag.bestRoutedBeforeProduct.productRejections.join(',') === 'shapeScore,coverage,order',
    detail: JSON.stringify(oDiag.bestRoutedBeforeProduct?.productRejections),
  },
  {
    name: 'downtown empty pool is graph_feasibility',
    passed: emptyDiag.rejectedBy.startsWith('graph_feasibility:') && emptyDiag.search.usedDowntownFallback,
    detail: emptyDiag.rejectedBy,
  },
  {
    name: '4000 m search and placement radii scale together',
    passed:
      emptyDiag.search.neighborhoodRadiusMeters === 3840 &&
      emptyDiag.search.placementRadiusMeters === 1280 &&
      emptyDiag.search.homeDefaultDistanceMeters === 2000,
    detail: `${emptyDiag.search.neighborhoodRadiusMeters}/${emptyDiag.search.placementRadiusMeters} default=${emptyDiag.search.homeDefaultDistanceMeters}`,
  },
  {
    name: 'O at 1500 m keeps the proven 2400 / 800 floors',
    passed: oDiag.search.neighborhoodRadiusMeters === 2400 && oDiag.search.placementRadiusMeters === 800,
    detail: `${oDiag.search.neighborhoodRadiusMeters}/${oDiag.search.placementRadiusMeters}`,
  },
  {
    name: 'L product rules empty',
    passed: productRejectionReasons(L).length === 0,
    detail: 'none',
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
