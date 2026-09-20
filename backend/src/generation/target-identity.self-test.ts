/**
 * DEVELOPMENT ONLY. Target-identity metrics: connected span vs local scribble.
 */
import { polylineLength } from '@/lib/geometry';
import { buildWalkableWordShape } from './walkable-target';
import { projectWordPlacement } from './street-fit-search';
import { analyzeTargetIdentity } from './target-identity';
import { scorePolylines } from '../scoring/shape-match';

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
