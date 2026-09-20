import {
  analyzeLetterGeometry,
  classifyCoverageStage,
} from './letter-coverage';

type Result = {
  name: string;
  passed: boolean;
  detail: string;
};

const l = analyzeLetterGeometry('L');
const o = analyzeLetterGeometry('O');
const results: Result[] = [
  {
    name: 'L geometry reports one corner and remains open',
    passed:
      l.strokeCount === 1 &&
      l.segmentCount === 2 &&
      l.sharpTurnCount === 1 &&
      !l.closed,
    detail: JSON.stringify(l),
  },
  {
    name: 'O geometry reports a closed multi-segment loop',
    passed: o.closed && o.segmentCount >= 12 && o.aspectRatio > 0.7,
    detail: JSON.stringify(o),
  },
  stageCase(
    'accepted route is PASS',
    {
      placementsEvaluated: 1360,
      graphEdges: 200,
      streetFitPasses: 40,
      graphFeasible: 8,
      productValidCandidates: 2,
      routedCandidates: 3,
      productAcceptedRoutes: 1,
      bestProductRejections: [],
      graphFailureReason: null,
    },
    'PASS',
  ),
  stageCase(
    'missing street fit is distinguished from graph failure',
    {
      placementsEvaluated: 1360,
      graphEdges: 200,
      streetFitPasses: 0,
      graphFeasible: 0,
      productValidCandidates: 0,
      routedCandidates: 0,
      productAcceptedRoutes: 0,
      bestProductRejections: [],
      graphFailureReason: 'poor target-progress coverage',
    },
    'NO_STREET_FIT',
  ),
  stageCase(
    'graph failure is reported after street-fit candidates exist',
    {
      placementsEvaluated: 1360,
      graphEdges: 200,
      streetFitPasses: 12,
      graphFeasible: 0,
      productValidCandidates: 0,
      routedCandidates: 0,
      productAcceptedRoutes: 0,
      bestProductRejections: [],
      graphFailureReason: 'disconnected candidate paths',
    },
    'ROUTE_FAILED',
  ),
  stageCase(
    'product rejection is a near miss',
    {
      placementsEvaluated: 1360,
      graphEdges: 200,
      streetFitPasses: 12,
      graphFeasible: 3,
      productValidCandidates: 0,
      routedCandidates: 2,
      productAcceptedRoutes: 0,
      bestProductRejections: ['coverage', 'order'],
      graphFailureReason: null,
    },
    'NEAR_MISS',
  ),
];

for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}

if (results.some((result) => !result.passed)) {
  process.exitCode = 1;
}

function stageCase(
  name: string,
  input: Parameters<typeof classifyCoverageStage>[0],
  expected: ReturnType<typeof classifyCoverageStage>['status'],
): Result {
  const actual = classifyCoverageStage(input);
  return {
    name,
    passed: actual.status === expected,
    detail: `${actual.status} ${actual.stage}: ${actual.reason}`,
  };
}
