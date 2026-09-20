/**
 * DEVELOPMENT ONLY. Product threshold and experimental API mapping tests.
 */
import type { GeneratedRoute } from '../types';
import {
  meetsExperimentalProductThreshold,
  toExperimentalUserResponse,
} from './experimental-product';
import { productRejectionReasons } from './experimental-diagnostics';

type SelfTest = { name: string; passed: boolean; detail: string };

const SHAPE = [
  { latitude: 30.0619, longitude: 31.2195 },
  { latitude: 30.064, longitude: 31.2195 },
  { latitude: 30.064, longitude: 31.222 },
];
const CONNECTOR = [
  { latitude: 30.058, longitude: 31.2195 },
  { latitude: 30.0619, longitude: 31.2195 },
];

function route(
  overrides: Partial<GeneratedRoute> & { id: string; shapeScore: number; coverage: number; order: number },
): GeneratedRoute {
  const breakdown = {
    proximity: 0.9,
    coverage: overrides.coverage,
    order: overrides.order,
    lengthFit: 0.8,
    detour: 0.9,
    backtrack: 0.95,
    finalScore: overrides.shapeScore,
  };
  return {
    id: overrides.id,
    source: 'valhalla',
    developmentOnly: true,
    coordinates: [...CONNECTOR, ...SHAPE.slice(1)],
    targetCoordinates: SHAPE,
    shapeCoordinates: SHAPE,
    connectorCoordinates: CONNECTOR,
    distanceMeters: 2898,
    shapeScore: overrides.shapeScore,
    coverage: overrides.coverage,
    scoreBreakdown: breakdown,
    metadata: {
      rotationDegrees: 157.5,
      scale: 0.8,
      placement: 'offset',
      offsetAcrossMeters: 800,
      method: 'graph_constrained',
      connectedFromStart: true,
      connected: true,
      startSnapDistanceMeters: 876,
      lengthError: 476,
      distanceError: 476,
      detourRatio: 0,
      backtrackRatio: 0,
      score: {
        score: overrides.shapeScore,
        distanceError: 20,
        coverage: overrides.coverage,
        lengthError: 476,
        breakdown,
      } as GeneratedRoute['metadata']['score'],
      connectorDistanceMeters: 876,
      shapeRouteDistanceMeters: 2024,
      totalDistanceMeters: 2898,
      headingAgreementDegrees: 18.7,
      largestGap: 0.08,
      eastMeters: 0,
      northMeters: 800,
      distanceFromUserMeters: 800,
      ...overrides.metadata,
    },
  };
}

const L = route({
  id: 'l-zamalek',
  shapeScore: 0.908,
  coverage: 0.88,
  order: 0.878,
});

const Z = route({
  id: 'z-north-cairo',
  shapeScore: 0.842,
  coverage: 0.81,
  order: 0.772,
  metadata: { ...L.metadata, largestGap: 0.1, headingAgreementDegrees: 23.6 },
});

const O = route({
  id: 'o-rectangle',
  shapeScore: 0.604,
  coverage: 0.45,
  order: 0.346,
  metadata: { ...L.metadata, largestGap: 0.27, headingAgreementDegrees: 24.9, shapeRouteDistanceMeters: 844 },
});

const ROBZ_FAKE = route({
  id: 'robz-downtown-scribble',
  shapeScore: 0.718,
  coverage: 0.762,
  order: 0.61,
  metadata: {
    ...L.metadata,
    largestGap: 0.125,
    backtrackRatio: 0.154,
    shapeRouteDistanceMeters: 994,
    scale: 0.6,
  },
});

const tests: SelfTest[] = [
  {
    name: 'proven L meets product threshold',
    passed: meetsExperimentalProductThreshold(L),
    detail: `score=${L.shapeScore} coverage=${L.coverage} order=${L.scoreBreakdown.order}`,
  },
  {
    name: 'partial Z meets product threshold',
    passed: meetsExperimentalProductThreshold(Z),
    detail: `score=${Z.shapeScore} coverage=${Z.coverage} order=${Z.scoreBreakdown.order}`,
  },
  {
    name: 'rectangular O is rejected by product threshold',
    passed: !meetsExperimentalProductThreshold(O),
    detail: `score=${O.shapeScore} coverage=${O.coverage} order=${O.scoreBreakdown.order}`,
  },
  {
    name: 'O product rejection rules are shapeScore, coverage, order',
    passed: productRejectionReasons(O).join(',') === 'shapeScore,coverage,order',
    detail: productRejectionReasons(O).join(','),
  },
  {
    name: 'L has no product rejection rules',
    passed: productRejectionReasons(L).length === 0,
    detail: productRejectionReasons(L).join(',') || 'none',
  },
  {
    name: 'no_viable_shape when only weak O remains',
    passed: toExperimentalUserResponse({ word: 'O', routes: [O] }, 1500).status === 'no_viable_shape',
    detail: toExperimentalUserResponse({ word: 'O', routes: [O] }, 1500).status,
  },
  {
    name: 'no routes returned for rejected O',
    passed: toExperimentalUserResponse({ word: 'O', routes: [O] }, 1500).routes.length === 0,
    detail: `n=${toExperimentalUserResponse({ word: 'O', routes: [O] }, 1500).routes.length}`,
  },
  {
    name: 'successful routes response keeps L',
    passed: (() => {
      const body = toExperimentalUserResponse({ word: 'L', routes: [L] }, 2500);
      return body.status === 'ok' && body.routes.length === 1 && body.word === 'L' && body.targetDistance === 2500;
    })(),
    detail: JSON.stringify(toExperimentalUserResponse({ word: 'L', routes: [L] }, 2500).status),
  },
  {
    name: 'connector separated from shape',
    passed: (() => {
      const mapped = toExperimentalUserResponse({ word: 'L', routes: [L] }, 2500).routes[0];
      return (
        mapped != null &&
        mapped.shapeDistance === 2024 &&
        mapped.connectorDistance === 876 &&
        mapped.totalDistance === 2898 &&
        mapped.shapeCoordinates.length === SHAPE.length &&
        mapped.connectorCoordinates.length === CONNECTOR.length &&
        mapped.fullRouteCoordinates.length === CONNECTOR.length + SHAPE.length - 1 &&
        mapped.shapeCoordinates[0]?.latitude === SHAPE[0]?.latitude &&
        mapped.connectorCoordinates[0]?.latitude === CONNECTOR[0]?.latitude
      );
    })(),
    detail: 'shape vs connector coordinates and distances',
  },
  {
    name: 'downtown ROBZ empty pool is no_viable_shape',
    passed: toExperimentalUserResponse({ word: 'ROBZ', routes: [] }, 4000).status === 'no_viable_shape',
    detail: toExperimentalUserResponse({ word: 'ROBZ', routes: [] }, 4000).message ?? '',
  },
  {
    name: 'ROBZ 994m scribble is rejected by identity/length gates',
    passed:
      !meetsExperimentalProductThreshold(ROBZ_FAKE, { word: 'ROBZ', targetDistance: 4000 }) &&
      toExperimentalUserResponse({ word: 'ROBZ', routes: [ROBZ_FAKE] }, 4000).status === 'no_viable_shape',
    detail: productRejectionReasons(ROBZ_FAKE, { word: 'ROBZ', targetDistance: 4000 }).join(','),
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
