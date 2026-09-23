import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';

import { decomposeTargetSpan } from './target-span-decomposition-diagnostic';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
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

const SCALE = 500;
function scalePoints(points: readonly Vec2[]): Vec2[] {
  return points.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
}

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const target = scalePoints(robzShape.points);
const perfectRoute = densify(target, 6);

check('targetSpan/naiveSpan/spanOccupancy/largestTargetGap exactly match a direct analyzeTargetIdentity() call — parity, not reimplementation', () => {
  const identity = analyzeTargetIdentity({ route: perfectRoute, target, word: 'ROBZ', geometryVariant: 'smooth' });
  const decomposed = decomposeTargetSpan('ROBZ', target, perfectRoute, 'smooth');
  assert.equal(decomposed.targetSpan, identity.targetSpan);
  assert.equal(decomposed.naiveSpan, identity.naiveSpan);
  assert.equal(decomposed.spanOccupancy, identity.spanOccupancy);
  assert.equal(decomposed.largestTargetGap, identity.largestTargetGap);
  assert.equal(decomposed.routeStartProgress, identity.startProgress);
  assert.equal(decomposed.routeEndProgress, identity.endProgress);
  assert.equal(decomposed.firstTargetProgressReached, identity.onTargetProgressMin);
  assert.equal(decomposed.lastTargetProgressReached, identity.onTargetProgressMax);
  assert.equal(decomposed.wordTraversal, identity.wordTraversal);
  assert.equal(decomposed.lettersVisitedInOrder, identity.lettersVisitedInOrder);
  assert.equal(decomposed.traversesMostOfWord, identity.traversesMostOfWord);
});

check('perLetterTargetProgress has one entry per real letter, in word order, matching identity.letters exactly', () => {
  const identity = analyzeTargetIdentity({ route: perfectRoute, target, word: 'ROBZ', geometryVariant: 'smooth' });
  const decomposed = decomposeTargetSpan('ROBZ', target, perfectRoute, 'smooth');
  assert.equal(decomposed.perLetterTargetProgress.length, identity.letters.length);
  decomposed.perLetterTargetProgress.forEach((entry, i) => {
    assert.equal(entry.letter, identity.letters[i]!.letter);
    assert.equal(entry.startProgress, identity.letters[i]!.startProgress);
    assert.equal(entry.endProgress, identity.letters[i]!.endProgress);
    assert.equal(entry.meaningfullyVisited, identity.letters[i]!.meaningfullyVisited);
  });
});

check('firstVisitedLetter/lastVisitedLetter are null when no letter is meaningfully visited (empty route)', () => {
  const decomposed = decomposeTargetSpan('ROBZ', target, [], 'smooth');
  assert.equal(decomposed.firstVisitedLetter, null);
  assert.equal(decomposed.lastVisitedLetter, null);
});

check('firstVisitedLetter/lastVisitedLetter are R and Z for a perfect full traversal', () => {
  const decomposed = decomposeTargetSpan('ROBZ', target, perfectRoute, 'smooth');
  assert.equal(decomposed.firstVisitedLetter, 'R');
  assert.equal(decomposed.lastVisitedLetter, 'Z');
});

check('read-only: route/target arrays are byte-identical before and after decomposeTargetSpan', () => {
  const routeCopy = perfectRoute.map((p) => ({ ...p }));
  const targetCopy = target.map((p) => ({ ...p }));
  decomposeTargetSpan('ROBZ', targetCopy, routeCopy, 'smooth');
  assert.deepEqual(routeCopy, perfectRoute);
  assert.deepEqual(targetCopy, target);
});

check('production isolation: running the decomposition does not change a subsequent real analyzeTargetIdentity() result', () => {
  const before = analyzeTargetIdentity({ route: perfectRoute, target, word: 'ROBZ', geometryVariant: 'smooth' }).traversesMostOfWord;
  decomposeTargetSpan('ROBZ', target, perfectRoute, 'smooth');
  const after = analyzeTargetIdentity({ route: perfectRoute, target, word: 'ROBZ', geometryVariant: 'smooth' }).traversesMostOfWord;
  assert.equal(before, after);
});

console.log(`target-span-decomposition-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
