/**
 * DEVELOPMENT ONLY. Word-identity report classification tests.
 */
import { buildWordIdentityCase, formatWordIdentityReport } from './word-identity';
import type { ExperimentalPipelineReport } from './graph-constrained-pipeline';
import type { GeneratedRoute } from '../types';

type Result = { name: string; passed: boolean; detail: string };

function route(partial: {
  id: string;
  shapeScore: number;
  coverage: number;
  order: number;
  shape: Array<{ latitude: number; longitude: number }>;
  target: Array<{ latitude: number; longitude: number }>;
  shapeMeters: number;
}): GeneratedRoute {
  return {
    id: partial.id,
    source: 'valhalla',
    developmentOnly: true,
    coordinates: partial.shape,
    targetCoordinates: partial.target,
    shapeCoordinates: partial.shape,
    connectorCoordinates: [],
    distanceMeters: partial.shapeMeters,
    shapeScore: partial.shapeScore,
    coverage: partial.coverage,
    scoreBreakdown: {
      proximity: 0.8,
      coverage: partial.coverage,
      order: partial.order,
      lengthFit: 0.8,
      detour: 0.8,
      backtrack: 0.9,
      finalScore: partial.shapeScore,
    },
    metadata: {
      rotationDegrees: 0,
      scale: 0.6,
      placement: 'offset',
      offsetAcrossMeters: 640,
      method: 'graph_constrained',
      connectedFromStart: true,
      connected: true,
      startSnapDistanceMeters: 0,
      lengthError: 0,
      distanceError: 0,
      detourRatio: 0,
      backtrackRatio: 0.15,
      score: { score: partial.shapeScore } as GeneratedRoute['metadata']['score'],
      largestGap: 0.12,
      shapeRouteDistanceMeters: partial.shapeMeters,
      eastMeters: 452.5,
      northMeters: -452.5,
    },
  };
}

const L_SHAPE = [
  { latitude: 30.06, longitude: 31.22 },
  { latitude: 30.05, longitude: 31.22 },
  { latitude: 30.05, longitude: 31.23 },
];

const emptyReport = {
  routes: [],
  diagnostics: { graphFeasible: 0 },
} as unknown as ExperimentalPipelineReport;

const lReport = {
  routes: [
    route({
      id: 'l-good',
      shapeScore: 0.86,
      coverage: 0.82,
      order: 0.81,
      shape: L_SHAPE,
      target: L_SHAPE,
      shapeMeters: 1800,
    }),
  ],
  diagnostics: { graphFeasible: 3 },
} as unknown as ExperimentalPipelineReport;

const lCase = buildWordIdentityCase('L', 2000, lReport);
const emptyCase = buildWordIdentityCase('ROBZ', 4000, emptyReport);
const text = formatWordIdentityReport({
  developmentOnly: true,
  location: { latitude: 30.0444, longitude: 31.2357 },
  generatedAt: 'test',
  elapsedMs: 1,
  cases: [lCase, emptyCase],
});

const results: Result[] = [
  {
    name: 'matching L is a global word match',
    passed: lCase.localShapeMatch && lCase.globalWordMatch && (lCase.best?.identity.targetSpan ?? 0) >= 0.9,
    detail: `local=${lCase.localShapeMatch} global=${lCase.globalWordMatch} span=${lCase.best?.identity.targetSpan.toFixed(3)}`,
  },
  {
    name: 'empty ROBZ pool is not a global match',
    passed: !emptyCase.localShapeMatch && !emptyCase.globalWordMatch && emptyCase.best == null,
    detail: `graph=${emptyCase.graphFeasible} routed=${emptyCase.routed}`,
  },
  {
    name: 'report distinguishes local vs global columns',
    passed: text.includes('local=') && text.includes('global='),
    detail: text.split('\n')[4] ?? text,
  },
];

for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
if (results.some((result) => !result.passed)) {
  process.exitCode = 1;
}
