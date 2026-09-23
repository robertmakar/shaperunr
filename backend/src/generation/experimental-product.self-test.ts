/**
 * DEVELOPMENT ONLY. Product threshold and experimental API mapping tests.
 *
 * The layered-gate tests below (1-12) use synthetic, deterministic,
 * connected ROBZ routes built with the same validated construction pattern
 * used throughout the diagnostic investigation that produced this gate
 * (sky-bridge arc connectors for skip/reorder cases so letter attribution
 * is unambiguous; straight connectors for cases that only need to be
 * physically clean) — never a live Valhalla call, matching how every
 * diagnostic self-test in this codebase already works.
 */
import type { Vec2 } from '@/lib/geometry';
import { offsetCoordinate } from '@/lib/shape-projection';

import type { GeneratedRoute } from '../types';
import {
  meetsExperimentalProductThreshold,
  toExperimentalUserResponse,
  experimentalProductRejectionReasons,
  computeSupportingOrder,
  EXPERIMENTAL_PRODUCT,
} from './experimental-product';
import { productRejectionReasons } from './experimental-diagnostics';
import { buildWalkableWordShape } from './walkable-target';
import { analyzeTargetIdentity } from './target-identity';
import { scorePolylines } from '../scoring/shape-match';

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
    name: 'O product rejection rules are shapeScore, coverage (order is no longer a hard-gate condition)',
    passed: productRejectionReasons(O).join(',') === 'shapeScore,coverage',
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

// ---------------------------------------------------------------------------
// Layered-gate tests (1-12) — synthetic connected ROBZ routes, real gate.
// ---------------------------------------------------------------------------

const SCALE = 500;
function scalePoints(points: readonly Vec2[]): Vec2[] {
  return points.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
}
function densify(points: readonly Vec2[], factor: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let s = 0; s < factor; s += 1) {
      const t = s / factor;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}
function arcConnector(from: Vec2, to: Vec2, arcHeight: number, factor: number): Vec2[] {
  const up = { x: from.x, y: from.y + arcHeight };
  const over = { x: to.x, y: to.y + arcHeight };
  return densify([from, up, over, to], factor);
}
function buildArcedRoute(letterPointArrays: readonly (readonly Vec2[])[], arcHeight = 200): Vec2[] {
  let out: Vec2[] = [];
  letterPointArrays.forEach((points, i) => {
    const dense = densify(points, 6);
    if (i === 0) {
      out = [...dense];
      return;
    }
    const prevEnd = out[out.length - 1]!;
    const nextStart = dense[0]!;
    out.push(...arcConnector(prevEnd, nextStart, arcHeight, 8).slice(1, -1));
    out.push(...dense);
  });
  return out;
}
function buildStraightRoute(letterPointArrays: readonly (readonly Vec2[])[]): Vec2[] {
  let out: Vec2[] = [];
  letterPointArrays.forEach((points, i) => {
    const dense = densify(points, 6);
    if (i === 0) {
      out = [...dense];
      return;
    }
    const prevEnd = out[out.length - 1]!;
    const nextStart = dense[0]!;
    out.push(...densify([prevEnd, nextStart], 8).slice(1, -1));
    out.push(...dense);
  });
  return out;
}

const GATE_ANCHOR = { latitude: 30.0, longitude: 31.0 };
function toGeo(p: Vec2) {
  return offsetCoordinate(GATE_ANCHOR, p.x, p.y);
}

function buildGateTestRoute(word: string, routePoints: Vec2[], targetPoints: Vec2[]): GeneratedRoute {
  const scored = scorePolylines(routePoints, targetPoints);
  const identity = analyzeTargetIdentity({ route: routePoints, target: targetPoints, word, geometryVariant: 'smooth' });
  const shapeGeo = routePoints.map(toGeo);
  const targetGeo = targetPoints.map(toGeo);
  return {
    id: 'gate-test-route',
    source: 'valhalla',
    developmentOnly: true,
    coordinates: shapeGeo,
    targetCoordinates: targetGeo,
    shapeCoordinates: shapeGeo,
    connectorCoordinates: [],
    distanceMeters: 0,
    shapeScore: scored.score,
    coverage: scored.coverage,
    scoreBreakdown: scored.breakdown,
    metadata: {
      rotationDegrees: 0,
      scale: 1,
      placement: 'start-anchored',
      offsetAcrossMeters: 0,
      method: 'graph_constrained',
      connectedFromStart: true,
      connected: true,
      backtrackRatio: scored.details.backtrackRatio,
      score: scored,
      startSnapDistanceMeters: 0,
      lengthError: 0,
      distanceError: 0,
      detourRatio: 0,
      largestGap: identity.largestTargetGap,
      shapeRouteDistanceMeters: scored.details.routeLengthMeters,
      geometryVariant: 'smooth',
    },
  };
}

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const gateTarget = scalePoints(robzShape.points);
const [gR, gO, gB, gZ] = robzShape.letters.map((l) => scalePoints(l.points)) as [Vec2[], Vec2[], Vec2[], Vec2[]];
const gateContext = { word: 'ROBZ', targetDistance: 2000 };

function gateReasons(routePoints: Vec2[]): string[] {
  return experimentalProductRejectionReasons(buildGateTestRoute('ROBZ', routePoints, gateTarget), gateContext);
}
function gateAccepts(routePoints: Vec2[]): boolean {
  return meetsExperimentalProductThreshold(buildGateTestRoute('ROBZ', routePoints, gateTarget), gateContext);
}

// 1. Complete + correct sequence + physical pass -> ACCEPT
{
  const route = buildStraightRoute([gR, gO, gB, gZ]);
  tests.push({ name: '1. Complete + correct sequence + physical pass -> ACCEPT', passed: gateAccepts(route), detail: gateReasons(route).join(',') || 'accepted' });
}

// 2. Missing letter -> REJECT (completeness)
{
  const route = buildArcedRoute([gR, gO, gZ]); // B skipped, arced connector avoids ambiguous B attribution
  const reasons = gateReasons(route);
  tests.push({ name: '2. Missing letter -> REJECT (completeness)', passed: !gateAccepts(route) && reasons.includes('completeness'), detail: reasons.join(',') });
}

// 3. Wrong chronological sequence -> REJECT (sequenceIntegrity)
{
  const route = buildArcedRoute([gR, gB, gO, gZ]); // the validated connected reorder construction (R->B->O->Z)
  const reasons = gateReasons(route);
  tests.push({ name: '3. Wrong chronological sequence -> REJECT (sequenceIntegrity)', passed: !gateAccepts(route) && reasons.includes('sequenceIntegrity'), detail: reasons.join(',') });
}

// 4. Revisit of an already-visited letter -> ACCEPT
{
  const route = buildStraightRoute([gR, gO, gR, gB, gZ]);
  tests.push({ name: '4. Revisit of an already-visited letter -> ACCEPT', passed: gateAccepts(route), detail: gateReasons(route).join(',') || 'accepted' });
}

// 5. Spatial self-crossing -> ACCEPT when semantic/physical requirements are satisfied
{
  const correct = buildStraightRoute([gR, gO, gB, gZ]);
  const crossFrom = Math.floor(correct.length * 0.62);
  const crossTo = Math.floor(correct.length * 0.2);
  const route = [...correct.slice(0, crossFrom), correct[crossTo]!, ...correct.slice(crossFrom)];
  tests.push({ name: '5. Spatial self-crossing -> ACCEPT when semantic/physical requirements are satisfied', passed: gateAccepts(route), detail: gateReasons(route).join(',') || 'accepted' });
}

// 6. Severe disconnected transition -> REJECT (continuity)
{
  const route = buildArcedRoute([gR, gB, gZ]); // O never reached at all: genuine continuity disconnection
  const reasons = gateReasons(route);
  tests.push({ name: '6. Severe disconnected transition -> REJECT (continuity)', passed: !gateAccepts(route) && reasons.includes('continuity'), detail: reasons.join(',') });
}

// 7. Legitimate long connector -> ACCEPT when physical/completeness/sequence requirements pass
{
  const route = buildArcedRoute([gR, gO, gB, gZ], 100);
  tests.push({ name: '7. Legitimate long connector -> ACCEPT when physical/completeness/sequence requirements pass', passed: gateAccepts(route), detail: gateReasons(route).join(',') || 'accepted' });
}

// 8. Low physical quality -> REJECT even if semantic checks pass
{
  const route = buildArcedRoute([gR, gO, gB, gZ], 2000); // severe single-transition detour: shapeScore craters, sequence/completeness still perfect
  const reasons = gateReasons(route);
  tests.push({ name: '8. Low physical quality -> REJECT even if semantic checks pass', passed: !gateAccepts(route) && reasons.includes('shapeScore'), detail: reasons.join(',') });
}

// 9. Low completeness -> REJECT even if order score is high
{
  const straight = buildStraightRoute([gR, gO, gB, gZ]); // establishes a high-order baseline
  const straightOrder = computeSupportingOrder(buildGateTestRoute('ROBZ', straight, gateTarget), gateContext) ?? 0;
  const route = buildArcedRoute([gR, gO, gZ]); // missing B -> low completeness
  const reasons = gateReasons(route);
  tests.push({
    name: '9. Low completeness -> REJECT even if order score is high',
    passed: !gateAccepts(route) && reasons.includes('completeness') && straightOrder > 0.5,
    detail: `reasons=${reasons.join(',')} referenceStraightOrder=${straightOrder.toFixed(3)}`,
  });
}

// 10. Bad sequence -> REJECT even if whole-route order is high
{
  const route = buildArcedRoute([gR, gB, gO, gZ]);
  const reasons = gateReasons(route);
  const supportingOrder = computeSupportingOrder(buildGateTestRoute('ROBZ', route, gateTarget), gateContext) ?? 0;
  tests.push({
    name: '10. Bad sequence -> REJECT even though order is no longer gated (order is not what rejects it)',
    passed: !gateAccepts(route) && reasons.includes('sequenceIntegrity') && !reasons.includes('order' as never),
    detail: `reasons=${reasons.join(',')} supportingOrder=${supportingOrder.toFixed(3)}`,
  });
}

// 11. Low whole-route order + otherwise valid route -> ACCEPT
// Uses the same h=100 legitimate-long-connector route as test 7: empirically
// rawOrder=0.599 (just under the old 0.60 threshold) while shapeScore/
// completeness/sequence/continuity all still pass — a genuine demonstration
// that the OLD gate would have rejected this route on order alone.
{
  const route = buildArcedRoute([gR, gO, gB, gZ], 100);
  const realRoute = buildGateTestRoute('ROBZ', route, gateTarget);
  const rawOrder = realRoute.scoreBreakdown.order;
  tests.push({
    name: '11. Low whole-route order + otherwise valid route -> ACCEPT (order is no longer a hard gate)',
    passed: gateAccepts(route) && rawOrder < EXPERIMENTAL_PRODUCT.minOrder,
    detail: `rawOrder=${rawOrder.toFixed(3)} (below old minOrder threshold ${EXPERIMENTAL_PRODUCT.minOrder}, no longer applied) reasons=${gateReasons(route).join(',') || 'accepted'}`,
  });
}

// 12. targetSpan failure + otherwise valid route -> ACCEPT
// Same h=100 route: empirically targetSpan=0.202, well under the old 0.55
// threshold, while every other gate condition still passes.
{
  const route = buildArcedRoute([gR, gO, gB, gZ], 100);
  const realRoute = buildGateTestRoute('ROBZ', route, gateTarget);
  const identity = analyzeTargetIdentity({ route, target: gateTarget, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: '12. targetSpan failure + otherwise valid route -> ACCEPT (targetSpan is no longer a hard gate)',
    passed: gateAccepts(route) && identity.targetSpan < EXPERIMENTAL_PRODUCT.minTargetSpan && !gateReasons(route).includes('targetSpan' as never),
    detail: `targetSpan=${identity.targetSpan.toFixed(3)} (below old minTargetSpan threshold ${EXPERIMENTAL_PRODUCT.minTargetSpan}, no longer applied) reasons=${experimentalProductRejectionReasons(realRoute, gateContext).join(',') || 'accepted'}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
