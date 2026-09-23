/**
 * DEVELOPMENT ONLY. Target-identity metrics: connected span vs local scribble.
 */
import { polylineLength } from '@/lib/geometry';
import { offsetCoordinate } from '@/lib/shape-projection';
import { buildWalkableWordShape } from './walkable-target';
import { projectWordPlacement } from './street-fit-search';
import { analyzeGeneratedRouteIdentity, analyzeTargetIdentity } from './target-identity';
import { scorePolylines } from '../scoring/shape-match';
import type { GeneratedRoute } from '../types';

type Result = { name: string; passed: boolean; detail: string };

const L = projectWordPlacement(buildWalkableWordShape('L'), 2000, {
  rotationDegrees: 0,
  scale: 1,
  eastMeters: 0,
  northMeters: 0,
});
const ROBZ = projectWordPlacement(buildWalkableWordShape('ROBZ'), 4000, {
  rotationDegrees: 0,
  scale: 0.6,
  eastMeters: 0,
  northMeters: 0,
});

const fullL = analyzeTargetIdentity({
  route: L.target,
  target: L.target,
  word: 'L',
  requestedDistanceMeters: 2000,
});
const partialL = analyzeTargetIdentity({
  route: L.target.slice(0, 2),
  target: L.target,
  word: 'L',
  requestedDistanceMeters: 2000,
});
const isolatedEnds = analyzeTargetIdentity({
  route: [ROBZ.target[0]!, ROBZ.target[ROBZ.target.length - 1]!],
  target: ROBZ.target,
  word: 'ROBZ',
  requestedDistanceMeters: 4000,
});
const firstLetterOnly = firstLetterRoute(ROBZ.target, ROBZ.letters[0]?.length ?? 1);
const firstLetter = analyzeTargetIdentity({
  route: firstLetterOnly,
  target: ROBZ.target,
  word: 'ROBZ',
  requestedDistanceMeters: 4000,
});
const sausage = analyzeTargetIdentity({
  route: bboxSausage(ROBZ.target),
  target: ROBZ.target,
  word: 'ROBZ',
  requestedDistanceMeters: 4000,
});
const scoredSausage = scorePolylines(bboxSausage(ROBZ.target), ROBZ.target);
const fullRobz = analyzeTargetIdentity({
  route: ROBZ.target,
  target: ROBZ.target,
  word: 'ROBZ',
  requestedDistanceMeters: 4000,
});
const cornerDetour = analyzeTargetIdentity({
  route: lCornerDetour(L.target),
  target: L.target,
  word: 'L',
  requestedDistanceMeters: 2000,
});

const results: Result[] = [
  {
    name: 'full L traverses the target',
    passed: fullL.targetSpan >= 0.9 && fullL.traversesMostOfWord && fullL.lengthRatioProjected >= 0.95,
    detail: `span=${fullL.targetSpan.toFixed(3)} ratio=${fullL.lengthRatioProjected.toFixed(3)}`,
  },
  {
    name: 'vertical-only L does not span the whole letter',
    passed: partialL.targetSpan < 0.75 && partialL.lengthRatioProjected < 0.8,
    detail: `span=${partialL.targetSpan.toFixed(3)} ratio=${partialL.lengthRatioProjected.toFixed(3)}`,
  },
  {
    name: 'isolated ROBZ endpoints do not get full connected span',
    passed: isolatedEnds.naiveSpan > isolatedEnds.targetSpan + 0.4 && isolatedEnds.targetSpan < 0.2,
    detail: `naive=${isolatedEnds.naiveSpan.toFixed(3)} span=${isolatedEnds.targetSpan.toFixed(3)}`,
  },
  {
    name: 'first-letter ROBZ scribble is not a word traversal',
    passed:
      firstLetter.lettersVisited <= 2 &&
      firstLetter.wordTraversal < 0.75 &&
      !firstLetter.traversesMostOfWord,
    detail: `visited=${firstLetter.letters.map((item) => `${item.letter}:${item.coverage.toFixed(2)}/${item.order.toFixed(2)}`).join(' ')} span=${firstLetter.targetSpan.toFixed(3)} trav=${firstLetter.wordTraversal.toFixed(2)}`,
  },
  {
    name: 'ROBZ bbox sausage can score well without tracing letters',
    passed:
      scoredSausage.score >= 0.45 &&
      sausage.wordTraversal < 1 &&
      !sausage.traversesMostOfWord &&
      (sausage.lengthRatioRequested ?? 1) < 0.3,
    detail: `shape=${scoredSausage.score.toFixed(3)} cov=${scoredSausage.coverage.toFixed(3)} order=${scoredSausage.breakdown.order.toFixed(3)} span=${sausage.targetSpan.toFixed(3)} visited=${sausage.lettersVisited}/${sausage.letters.length} ratioReq=${sausage.lengthRatioRequested?.toFixed(3)} ratioProj=${sausage.lengthRatioProjected.toFixed(3)}`,
  },
  {
    name: 'true ROBZ target traces every letter in order',
    passed:
      fullRobz.lettersVisited === 4 &&
      fullRobz.lettersVisitedInOrder &&
      fullRobz.targetSpan >= 0.9 &&
      fullRobz.traversesMostOfWord,
    detail: `visited=${fullRobz.lettersVisited} span=${fullRobz.targetSpan.toFixed(3)} letters=${fullRobz.letters.map((item) => item.letter).join('')}`,
  },
  {
    name: 'street-corner L detour still spans the letter',
    passed: cornerDetour.targetSpan >= 0.7 && cornerDetour.naiveSpan >= 0.7,
    detail: `span=${cornerDetour.targetSpan.toFixed(3)} naive=${cornerDetour.naiveSpan.toFixed(3)}`,
  },
  ...geometryVariantPropagationTests(),
];

for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
if (results.some((result) => !result.passed)) {
  process.exitCode = 1;
}

function firstLetterRoute(target: { x: number; y: number }[], letterLength: number): { x: number; y: number }[] {
  const total = polylineLength(target);
  const fraction = total <= 0 ? 0.22 : Math.min(0.28, letterLength / total + 0.04);
  const keep = Math.max(2, Math.round(target.length * fraction));
  return target.slice(0, keep);
}

function lCornerDetour(target: { x: number; y: number }[]): { x: number; y: number }[] {
  if (target.length < 3) {
    return target.map((point) => ({ ...point }));
  }
  const start = target[0]!;
  const corner = target[1]!;
  const end = target[target.length - 1]!;
  return [
    start,
    { x: corner.x + 40, y: corner.y },
    { x: corner.x + 40, y: corner.y + 40 },
    { x: corner.x, y: corner.y + 40 },
    end,
  ];
}

/**
 * Regression coverage for the geometryVariant correctness fix: identity
 * analysis previously always used 'smooth' letter boundaries regardless of
 * which geometry actually produced the candidate.
 */
function geometryVariantPropagationTests(): Result[] {
  const RO = projectWordPlacement(buildWalkableWordShape('RO'), 2000, {
    rotationDegrees: 0,
    scale: 1,
    eastMeters: 0,
    northMeters: 0,
  });

  // Same external route/target for both calls — isolates the effect of the
  // geometryVariant parameter itself on the internal letter-boundary math
  // (letterIdentities rebuilds the word shape from this parameter).
  const identitySmooth = analyzeTargetIdentity({ route: RO.target, target: RO.target, word: 'RO', geometryVariant: 'smooth' });
  const identityAngular = analyzeTargetIdentity({ route: RO.target, target: RO.target, word: 'RO', geometryVariant: 'angular' });
  const identityDefault = analyzeTargetIdentity({ route: RO.target, target: RO.target, word: 'RO' });

  const oSmooth = identitySmooth.letters.find((letter) => letter.letter === 'O');
  const oAngular = identityAngular.letters.find((letter) => letter.letter === 'O');
  const oDefault = identityDefault.letters.find((letter) => letter.letter === 'O');

  const origin = { latitude: 30.06, longitude: 31.22 };
  const roCoordinates = RO.target.map((point) => offsetCoordinate(origin, point.x, point.y));

  function fakeRoute(geometryVariant: GeneratedRoute['metadata']['geometryVariant']): GeneratedRoute {
    return {
      id: 'test',
      source: 'valhalla',
      developmentOnly: true,
      coordinates: roCoordinates,
      targetCoordinates: roCoordinates,
      shapeCoordinates: roCoordinates,
      connectorCoordinates: [],
      distanceMeters: polylineLength(RO.target),
      shapeScore: 0.8,
      coverage: 0.8,
      scoreBreakdown: { proximity: 0.8, coverage: 0.8, order: 0.8, lengthFit: 0.8, detour: 0.8, backtrack: 0.8, finalScore: 0.8 },
      metadata: {
        rotationDegrees: 0,
        scale: 1,
        placement: 'start-anchored',
        offsetAcrossMeters: 0,
        method: 'graph_constrained',
        connectedFromStart: true,
        connected: true,
        startSnapDistanceMeters: 0,
        lengthError: 0,
        distanceError: 0,
        detourRatio: 0,
        backtrackRatio: 0,
        score: { score: 0.8 } as GeneratedRoute['metadata']['score'],
        geometryVariant,
      },
    };
  }
  const routeSmoothIdentity = analyzeGeneratedRouteIdentity(fakeRoute('smooth'), { word: 'RO', targetDistance: 2000 });
  const routeAngularIdentity = analyzeGeneratedRouteIdentity(fakeRoute('angular'), { word: 'RO', targetDistance: 2000 });
  const routeUndefinedIdentity = analyzeGeneratedRouteIdentity(fakeRoute(undefined), { word: 'RO', targetDistance: 2000 });
  const oRouteSmooth = routeSmoothIdentity.letters.find((letter) => letter.letter === 'O');
  const oRouteAngular = routeAngularIdentity.letters.find((letter) => letter.letter === 'O');
  const oRouteUndefined = routeUndefinedIdentity.letters.find((letter) => letter.letter === 'O');

  return [
    {
      name: 'geometryVariant fix: smooth vs angular produce DIFFERENT O letter boundaries (proves the parameter actually reaches letterIdentities)',
      passed:
        oSmooth != null &&
        oAngular != null &&
        (Math.abs(oSmooth.startProgress - oAngular.startProgress) > 1e-6 || Math.abs(oSmooth.endProgress - oAngular.endProgress) > 1e-6),
      detail: `smooth O=[${oSmooth?.startProgress.toFixed(3)}-${oSmooth?.endProgress.toFixed(3)}] angular O=[${oAngular?.startProgress.toFixed(3)}-${oAngular?.endProgress.toFixed(3)}]`,
    },
    {
      name: 'geometryVariant fix: omitting geometryVariant behaves exactly like explicit "smooth" (default unchanged)',
      passed: oDefault != null && oSmooth != null && oDefault.startProgress === oSmooth.startProgress && oDefault.endProgress === oSmooth.endProgress,
      detail: `default O=[${oDefault?.startProgress.toFixed(3)}-${oDefault?.endProgress.toFixed(3)}] smooth O=[${oSmooth?.startProgress.toFixed(3)}-${oSmooth?.endProgress.toFixed(3)}]`,
    },
    {
      name: 'geometryVariant fix: analyzeGeneratedRouteIdentity auto-uses route.metadata.geometryVariant (smooth route differs from angular route)',
      passed:
        oRouteSmooth != null &&
        oRouteAngular != null &&
        (Math.abs(oRouteSmooth.startProgress - oRouteAngular.startProgress) > 1e-6 || Math.abs(oRouteSmooth.endProgress - oRouteAngular.endProgress) > 1e-6),
      detail: `route smooth O=[${oRouteSmooth?.startProgress.toFixed(3)}-${oRouteSmooth?.endProgress.toFixed(3)}] route angular O=[${oRouteAngular?.startProgress.toFixed(3)}-${oRouteAngular?.endProgress.toFixed(3)}]`,
    },
    {
      name: 'geometryVariant fix: a route with no geometryVariant tag falls back to smooth (legacy routes unaffected)',
      passed: oRouteUndefined != null && oRouteSmooth != null && oRouteUndefined.startProgress === oRouteSmooth.startProgress && oRouteUndefined.endProgress === oRouteSmooth.endProgress,
      detail: `route undefined O=[${oRouteUndefined?.startProgress.toFixed(3)}-${oRouteUndefined?.endProgress.toFixed(3)}]`,
    },
  ];
}

function bboxSausage(target: { x: number; y: number }[]): { x: number; y: number }[] {
  const xs = target.map((point) => point.x);
  const ys = target.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
  return [
    { x: minX, y: midY },
    { x: (minX + maxX) / 2, y: midY },
    { x: maxX, y: midY },
  ];
}
