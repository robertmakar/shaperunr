/**
 * DEVELOPMENT ONLY. Walkable letter-target covering stays on ink.
 */
import { flattenLetterStrokes, getLetterShape } from '@/lib/letter-shapes';
import { polylineLength } from '@/lib/geometry';
import { buildWordShape } from '@/lib/word-shape';

import { isClosedTarget, regionsFromTargetCorners } from './graph-shape';
import {
  buildWalkableWordShape,
  coverStrokesOnInk,
  longestEmptyJump,
  walkableLetterPoints,
} from './walkable-target';

type Result = { name: string; passed: boolean; detail: string };

function strokes(letter: string) {
  return getLetterShape(letter)?.strokes ?? [];
}

function flattenJump(letter: string): number {
  const shape = getLetterShape(letter);
  if (!shape) {
    return 0;
  }
  return longestEmptyJump(flattenLetterStrokes(shape), shape.strokes);
}

function walkableJump(letter: string): number {
  const shape = getLetterShape(letter);
  if (!shape) {
    return 0;
  }
  return longestEmptyJump(coverStrokesOnInk(shape.strokes), shape.strokes);
}

function letter(char: string) {
  return getLetterShape(char)!;
}

const lWalk = buildWalkableWordShape('L');
const lFlat = buildWordShape('L');
const oWalk = buildWalkableWordShape('O');
const tWalk = buildWalkableWordShape('T');
const tFlat = buildWordShape('T');
const iWalk = buildWalkableWordShape('I');
const iFlat = buildWordShape('I');
const eWalk = walkableLetterPoints(letter('E'));
const yWalk = walkableLetterPoints(letter('Y'));
const hWalk = walkableLetterPoints(letter('H'));
const dWalk = walkableLetterPoints(letter('D'));

const results: Result[] = [
  {
    name: 'L walkable geometry matches single-stroke flatten',
    passed: Math.abs(lWalk.length - lFlat.length) < 1e-6 && lWalk.points.length === lFlat.points.length,
    detail: `walk=${lWalk.length.toFixed(3)} flat=${lFlat.length.toFixed(3)} pts=${lWalk.points.length}/${lFlat.points.length}`,
  },
  {
    name: 'O remains a closed loop',
    passed: isClosedTarget(oWalk.points) && walkableJump('O') < 0.05,
    detail: `closed=${isClosedTarget(oWalk.points)} jump=${walkableJump('O').toFixed(3)}`,
  },
  {
    name: 'E flatten inserts an empty-space jump, walkable covering does not',
    passed:
      flattenJump('E') > 0.4 &&
      longestEmptyJump(eWalk, strokes('E')) < 0.05 &&
      polylineLength(eWalk) > polylineLength(flattenLetterStrokes(letter('E'))),
    detail: `flatJump=${flattenJump('E').toFixed(3)} walkJump=${longestEmptyJump(eWalk, strokes('E')).toFixed(3)} len=${polylineLength(eWalk).toFixed(3)}`,
  },
  {
    name: 'Y covering includes both the V and the stem',
    passed:
      yWalk.some((point) => point.y <= 0.05 && Math.abs(point.x - 0.5) < 0.08) &&
      yWalk.some((point) => point.y >= 0.95) &&
      walkableJump('Y') < 0.05,
    detail: `pts=${yWalk.length} jump=${walkableJump('Y').toFixed(3)} minY=${Math.min(...yWalk.map((point) => point.y)).toFixed(2)}`,
  },
  {
    name: 'H covering does not teleport between stems',
    passed: flattenJump('H') > 0.5 && longestEmptyJump(hWalk, strokes('H')) < 0.08,
    detail: `flatJump=${flattenJump('H').toFixed(3)} walkJump=${longestEmptyJump(hWalk, strokes('H')).toFixed(3)} pts=${hWalk.length}`,
  },
  {
    name: 'T and I keep flatten when strokes already meet',
    passed:
      Math.abs(tWalk.length - tFlat.length) < 1e-6 &&
      Math.abs(iWalk.length - iFlat.length) < 1e-6 &&
      flattenJump('T') <= 0.12 &&
      flattenJump('I') <= 0.12,
    detail: `T walk=${tWalk.length.toFixed(3)} flat=${tFlat.length.toFixed(3)} I walk=${iWalk.length.toFixed(3)} flat=${iFlat.length.toFixed(3)} Tjump=${flattenJump('T').toFixed(3)} Ijump=${flattenJump('I').toFixed(3)}`,
  },
  {
    name: 'T covering still includes the stem and top bar when forced',
    passed: coverStrokesOnInk(strokes('T')).length >= 4 && walkableJump('T') < 0.05,
    detail: `coverPts=${coverStrokesOnInk(strokes('T')).length} jump=${walkableJump('T').toFixed(3)}`,
  },
  {
    name: 'A walkable covering is used because flatten teleports to the bar',
    passed:
      flattenJump('A') > 0.12 &&
      longestEmptyJump(walkableLetterPoints(letter('A')), strokes('A')) < 0.05,
    detail: `flatJump=${flattenJump('A').toFixed(3)}`,
  },
  {
    name: 'D is detected as a closed generic loop',
    passed: isClosedTarget(dWalk) && regionsFromTargetCorners(dWalk).length >= 1,
    detail: `closed=${isClosedTarget(dWalk)} regions=${regionsFromTargetCorners(dWalk).length}`,
  },
  {
    name: 'Walkable E exposes multiple corner regions for graph search',
    passed: regionsFromTargetCorners(eWalk).length >= 2,
    detail: `regions=${regionsFromTargetCorners(eWalk).map((region) => region.id).join(',')}`,
  },
  {
    name: 'Y covering exposes branching regions',
    passed: regionsFromTargetCorners(yWalk).length >= 2,
    detail: `regions=${regionsFromTargetCorners(yWalk).map((region) => region.id).join(',')}`,
  },
];

for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
if (results.some((result) => !result.passed)) {
  process.exitCode = 1;
}
