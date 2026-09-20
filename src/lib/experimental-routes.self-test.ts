import {
  experimentalNoMatchCopy,
  describeExperimentalParse,
  parseExperimentalRoutesResponse,
  type ExperimentalUserRoute,
} from '@/lib/experimental-routes-client';
import {
  clearSelectedExperimentalRoute,
  getSelectedExperimentalRoute,
  setSelectedExperimentalRoute,
} from '@/lib/experimental-route-session';

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

const sampleRoute: ExperimentalUserRoute = {
  id: 'l-zamalek',
  shapeCoordinates: SHAPE,
  fullRouteCoordinates: [...CONNECTOR, ...SHAPE.slice(1)],
  connectorCoordinates: CONNECTOR,
  shapeDistance: 2024,
  connectorDistance: 876,
  totalDistance: 2898,
  shapeScore: 0.908,
  coverage: 0.88,
  order: 0.878,
  heading: 18.7,
  backtrack: 0,
  placement: { eastMeters: 0, northMeters: 800 },
  rotation: 157.5,
  scale: 0.8,
  distanceFromUser: 800,
};

function okPayload() {
  return {
    status: 'ok' as const,
    word: 'L',
    targetDistance: 2500,
    routes: [sampleRoute],
  };
}

function iphoneAlexandriaPayload() {
  return {
    status: 'ok' as const,
    word: 'L',
    targetDistance: 2000,
    routes: [
      {
        id: 'sf-r315-s0.6-e565.7-n565.7',
        shapeCoordinates: SHAPE,
        fullRouteCoordinates: [...CONNECTOR, ...SHAPE.slice(1)],
        connectorCoordinates: CONNECTOR,
        shapeDistance: 1082.9308987113861,
        connectorDistance: 826.3304520994478,
        totalDistance: 1908.0243429951033,
        shapeScore: 0.8283049879918422,
        coverage: 0.625,
        order: 0.8580170610465256,
        heading: 10.696423533284031,
        backtrack: 0,
        placement: { eastMeters: 565.7, northMeters: 565.7 },
        rotation: 315,
        scale: 0.6,
        distanceFromUser: 800,
      },
    ],
    diagnostics: {
      rejectedBy: 'none (product accepted at least one route)',
      stages: { productAccepted: 1 },
    },
  };
}

clearSelectedExperimentalRoute();
setSelectedExperimentalRoute({ ...sampleRoute, word: 'L' });
const preserved = getSelectedExperimentalRoute();

const tests: SelfTest[] = [
  {
    name: 'successful routes response',
    passed: (() => {
      const parsed = parseExperimentalRoutesResponse(okPayload());
      return parsed?.status === 'ok' && parsed.routes.length === 1 && parsed.word === 'L';
    })(),
    detail: parseExperimentalRoutesResponse(okPayload())?.status ?? 'null',
  },
  {
    name: 'no_viable_shape response',
    passed: (() => {
      const parsed = parseExperimentalRoutesResponse({
        status: 'no_viable_shape',
        word: 'ROBZ',
        targetDistance: 4000,
        routes: [],
        message: 'No strong walkable match was found nearby.',
        diagnostics: { rejectedBy: 'graph_feasibility: poor target-progress coverage' },
      });
      return parsed?.status === 'no_viable_shape' && parsed.routes.length === 0;
    })(),
    detail: 'empty routes for ROBZ',
  },
  {
    name: 'connector separated from shape',
    passed: (() => {
      const route = parseExperimentalRoutesResponse(okPayload())?.routes[0];
      return (
        route != null &&
        route.shapeDistance === 2024 &&
        route.connectorDistance === 876 &&
        route.totalDistance === 2898 &&
        route.shapeCoordinates[0]?.latitude === SHAPE[0]?.latitude &&
        route.connectorCoordinates[0]?.latitude === CONNECTOR[0]?.latitude &&
        route.fullRouteCoordinates.length === CONNECTOR.length + SHAPE.length - 1
      );
    })(),
    detail: 'shape 2024 / connector 876 / total 2898',
  },
  {
    name: 'selected route preserved when navigating to Run',
    passed:
      preserved != null &&
      preserved.id === sampleRoute.id &&
      preserved.word === 'L' &&
      preserved.shapeCoordinates === sampleRoute.shapeCoordinates &&
      preserved.fullRouteCoordinates.length === sampleRoute.fullRouteCoordinates.length,
    detail: `id=${preserved?.id ?? 'none'} word=${preserved?.word ?? ''}`,
  },
  {
    name: 'empty state copy',
    passed: (() => {
      const copy = experimentalNoMatchCopy('ROBZ');
      return (
        copy.title === 'NO STRONG MATCH FOUND' &&
        copy.body.includes('"ROBZ"') &&
        copy.tries.includes('a different word')
      );
    })(),
    detail: experimentalNoMatchCopy('ROBZ').title,
  },
  {
    name: 'iPhone Alexandria L 2000 payload is accepted as ok with 1 route',
    passed: (() => {
      const parsed = parseExperimentalRoutesResponse(iphoneAlexandriaPayload());
      const described = describeExperimentalParse(iphoneAlexandriaPayload());
      return (
        parsed?.status === 'ok' &&
        parsed.routes.length === 1 &&
        parsed.routes[0]?.id === 'sf-r315-s0.6-e565.7-n565.7' &&
        described.dropReason === null &&
        described.acceptedRouteCount === 1
      );
    })(),
    detail: parseExperimentalRoutesResponse(iphoneAlexandriaPayload())?.routes[0]?.id ?? 'null',
  },
  {
    name: 'ok status with structurally invalid routes is malformed, not no_viable_shape',
    passed: (() => {
      const broken = {
        status: 'ok',
        word: 'L',
        targetDistance: 2000,
        routes: [{ id: 'broken' }],
      };
      const parsed = parseExperimentalRoutesResponse(broken);
      const described = describeExperimentalParse(broken);
      return parsed == null && described.dropReason === 'ok_status_but_no_routes_passed_shape_guard';
    })(),
    detail:
      describeExperimentalParse({
        status: 'ok',
        word: 'L',
        targetDistance: 2000,
        routes: [{ id: 'broken' }],
      }).dropReason ?? 'none',
  },
];

clearSelectedExperimentalRoute();

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
