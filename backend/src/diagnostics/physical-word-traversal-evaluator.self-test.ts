/**
 * DEVELOPMENT ONLY. Tests for the shadow physical-word-traversal
 * evaluator (physical-word-traversal-evaluator.ts).
 *
 * A. classifyPhysicalLetter threshold correctness (both conditions required).
 * B. evaluatePhysicalWordTraversalFromLetters: all-covered + in-order -> pass.
 * C. missing letter (uncovered) -> allLettersCovered=false, firstMissingLetter set.
 * D. out-of-order letters -> lettersInBroadOrder=false, firstOrderViolation set.
 * E. sequenceTolerance: near-equal progress within tolerance still passes;
 *    just outside tolerance fails.
 * F. evaluatePhysicalWordTraversal (full, from a real route) produces
 *    letter-level rawInk/coverage matching the existing, unmodified
 *    computeInkOnlyOccupancy/TargetIdentity.letters exactly (parity).
 * G. read-only / production isolation.
 * H. threshold configurability: different threshold objects produce different results on the same input.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import {
  classifyPhysicalLetter,
  evaluatePhysicalWordTraversalFromLetters,
  evaluatePhysicalWordTraversal,
  PHYSICAL_TRAVERSAL_DEFAULTS,
  type PhysicalLetterInput,
} from './physical-word-traversal-evaluator';
import type { Vec2 } from '@/lib/geometry';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

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
const goodRoute = densify(robzShape.points, 6);

// --- A. classifyPhysicalLetter ---
{
  const t = PHYSICAL_TRAVERSAL_DEFAULTS;
  const bothPass = classifyPhysicalLetter({ index: 0, letter: 'X', rawInkCoverage: 0.7, coverage: 0.5, medianProgress: 0.1 }, t);
  const inkFails = classifyPhysicalLetter({ index: 0, letter: 'X', rawInkCoverage: 0.5, coverage: 0.5, medianProgress: 0.1 }, t);
  const coverageFails = classifyPhysicalLetter({ index: 0, letter: 'X', rawInkCoverage: 0.7, coverage: 0.3, medianProgress: 0.1 }, t);
  const bothFail = classifyPhysicalLetter({ index: 0, letter: 'X', rawInkCoverage: 0.5, coverage: 0.3, medianProgress: 0.1 }, t);
  tests.push({
    name: 'A. classifyPhysicalLetter requires BOTH rawInkCoverage>=ink AND coverage>=coverageThreshold',
    passed: bothPass.physicallyCovered && !inkFails.physicallyCovered && !coverageFails.physicallyCovered && !bothFail.physicallyCovered,
    detail: `bothPass=${bothPass.physicallyCovered} inkFails=${inkFails.physicallyCovered} coverageFails=${coverageFails.physicallyCovered} bothFail=${bothFail.physicallyCovered}`,
  });
}

// --- B. all-covered + in-order -> pass ---
{
  const letters: PhysicalLetterInput[] = [
    { index: 0, letter: 'R', rawInkCoverage: 1.0, coverage: 0.6, medianProgress: 0.1 },
    { index: 1, letter: 'O', rawInkCoverage: 0.9, coverage: 0.5, medianProgress: 0.3 },
    { index: 2, letter: 'B', rawInkCoverage: 0.8, coverage: 0.5, medianProgress: 0.6 },
    { index: 3, letter: 'Z', rawInkCoverage: 0.7, coverage: 0.4, medianProgress: 0.9 },
  ];
  const result = evaluatePhysicalWordTraversalFromLetters(letters);
  tests.push({
    name: 'B. all letters covered and in broad order -> wordTraversalPhysical=true',
    passed: result.wordTraversalPhysical && result.allLettersCovered && result.lettersInBroadOrder && result.coveredLetterCount === 4,
    detail: JSON.stringify({ wordTraversalPhysical: result.wordTraversalPhysical, allLettersCovered: result.allLettersCovered, lettersInBroadOrder: result.lettersInBroadOrder }),
  });
}

// --- C. missing letter ---
{
  const letters: PhysicalLetterInput[] = [
    { index: 0, letter: 'R', rawInkCoverage: 1.0, coverage: 0.6, medianProgress: 0.1 },
    { index: 1, letter: 'O', rawInkCoverage: 0.1, coverage: 0.0, medianProgress: 0.3 }, // uncovered
    { index: 2, letter: 'B', rawInkCoverage: 0.8, coverage: 0.5, medianProgress: 0.6 },
    { index: 3, letter: 'Z', rawInkCoverage: 0.7, coverage: 0.4, medianProgress: 0.9 },
  ];
  const result = evaluatePhysicalWordTraversalFromLetters(letters);
  tests.push({
    name: 'C. an uncovered letter -> allLettersCovered=false, firstMissingLetter="O", wordTraversalPhysical=false',
    passed: !result.allLettersCovered && result.firstMissingLetter === 'O' && !result.wordTraversalPhysical,
    detail: `allLettersCovered=${result.allLettersCovered} firstMissingLetter=${result.firstMissingLetter} coveredLetterCount=${result.coveredLetterCount}/${result.letterCount}`,
  });
}

// --- D. out-of-order letters ---
{
  const letters: PhysicalLetterInput[] = [
    { index: 0, letter: 'R', rawInkCoverage: 1.0, coverage: 0.6, medianProgress: 0.5 },
    { index: 1, letter: 'O', rawInkCoverage: 0.9, coverage: 0.5, medianProgress: 0.1 }, // out of order
    { index: 2, letter: 'B', rawInkCoverage: 0.8, coverage: 0.5, medianProgress: 0.6 },
  ];
  const result = evaluatePhysicalWordTraversalFromLetters(letters);
  tests.push({
    name: 'D. out-of-order median progress -> lettersInBroadOrder=false, firstOrderViolation from R to O, wordTraversalPhysical=false',
    passed: !result.lettersInBroadOrder && result.firstOrderViolation?.fromLetter === 'R' && result.firstOrderViolation?.toLetter === 'O' && !result.wordTraversalPhysical,
    detail: JSON.stringify(result.firstOrderViolation),
  });
}

// --- E. sequenceTolerance ---
{
  const letters: PhysicalLetterInput[] = [
    { index: 0, letter: 'A', rawInkCoverage: 1.0, coverage: 0.6, medianProgress: 0.3 },
    { index: 1, letter: 'B', rawInkCoverage: 1.0, coverage: 0.6, medianProgress: 0.31 }, // within 0.02 tolerance of "equal", but actually increasing so should pass regardless
    { index: 2, letter: 'C', rawInkCoverage: 1.0, coverage: 0.6, medianProgress: 0.295 }, // slightly LESS than B's 0.31, within 0.02 tolerance -> should still pass
  ];
  const withTolerance = evaluatePhysicalWordTraversalFromLetters(letters, { ...PHYSICAL_TRAVERSAL_DEFAULTS, sequenceTolerance: 0.02 });
  const withZeroTolerance = evaluatePhysicalWordTraversalFromLetters(letters, { ...PHYSICAL_TRAVERSAL_DEFAULTS, sequenceTolerance: 0 });
  tests.push({
    name: 'E1. sequenceTolerance=0.02 forgives a small (0.015) backward dip between B and C',
    passed: withTolerance.lettersInBroadOrder,
    detail: `lettersInBroadOrder=${withTolerance.lettersInBroadOrder}`,
  });
  tests.push({
    name: 'E2. sequenceTolerance=0 does NOT forgive the same small backward dip',
    passed: !withZeroTolerance.lettersInBroadOrder,
    detail: `lettersInBroadOrder=${withZeroTolerance.lettersInBroadOrder}`,
  });
}

// --- F. full evaluatePhysicalWordTraversal parity with existing infra ---
{
  const result = evaluatePhysicalWordTraversal('ROBZ', robzShape.points, goodRoute, 'smooth');
  const identity = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const boundarySet = letterBoundariesFromWordShape(robzShape);
  const ink = computeInkOnlyOccupancy({ route: goodRoute, target: robzShape.points, boundarySet, letterMeaningfullyVisited: identity.letters.map((l) => l.meaningfullyVisited) });
  let allMatch = true;
  const details: string[] = [];
  for (let i = 0; i < result.letters.length; i += 1) {
    const r = result.letters[i]!;
    const realCoverage = identity.letters[i]!.coverage;
    const realRawInk = ink.perLetterOccupancy[i]?.occupancy ?? 0;
    if (Math.abs(r.coverage - realCoverage) > 1e-9 || Math.abs(r.rawInkCoverage - realRawInk) > 1e-9) {
      allMatch = false;
      details.push(`${r.letter}: coverage=${r.coverage} real=${realCoverage} rawInk=${r.rawInkCoverage} real=${realRawInk}`);
    }
  }
  tests.push({
    name: 'F. evaluatePhysicalWordTraversal per-letter rawInkCoverage/coverage exactly match the existing, unmodified computeInkOnlyOccupancy/TargetIdentity.letters',
    passed: allMatch && result.letters.length === 4,
    detail: allMatch ? 'all letters match exactly' : details.join('; '),
  });
}

// --- G. read-only / production isolation ---
{
  const targetSnapshot = JSON.stringify(robzShape.points);
  const routeSnapshot = JSON.stringify(goodRoute);
  evaluatePhysicalWordTraversal('ROBZ', robzShape.points, goodRoute, 'smooth');
  tests.push({
    name: 'G1. read-only: target and route arrays are byte-identical before and after evaluation',
    passed: JSON.stringify(robzShape.points) === targetSnapshot && JSON.stringify(goodRoute) === routeSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  evaluatePhysicalWordTraversal('ROBZ', robzShape.points, goodRoute, 'smooth');
  const identityAfter = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'G2. production isolation: running the shadow evaluator does not change a subsequent real analyzeTargetIdentity() result',
    passed: JSON.stringify(identityBefore) === JSON.stringify(identityAfter),
    detail: `before.traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

// --- H. threshold configurability ---
{
  const letters: PhysicalLetterInput[] = [{ index: 0, letter: 'X', rawInkCoverage: 0.65, coverage: 0.45, medianProgress: 0.1 }];
  const strict = evaluatePhysicalWordTraversalFromLetters(letters, { inkThreshold: 0.8, coverageThreshold: 0.5, sequenceTolerance: 0.02 });
  const lenient = evaluatePhysicalWordTraversalFromLetters(letters, { inkThreshold: 0.5, coverageThreshold: 0.3, sequenceTolerance: 0.02 });
  tests.push({
    name: 'H. different threshold objects produce different results on the identical input (strict rejects, lenient accepts)',
    passed: !strict.allLettersCovered && lenient.allLettersCovered,
    detail: `strict.allLettersCovered=${strict.allLettersCovered} lenient.allLettersCovered=${lenient.allLettersCovered}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
