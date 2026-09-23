/**
 * DEVELOPMENT ONLY. Tests for the shadow/diagnostic traversal evaluators.
 * Pure functions only — no network, no route generation. These evaluators
 * never feed into wordTraversal/traversesMostOfWord/the product gate; this
 * file also re-verifies that computing them leaves the existing evaluator
 * completely unaffected.
 */
import type { Vec2 } from '@/lib/geometry';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { buildTraversalTrace, letterBoundariesFromWordShape } from './multi-letter-trace';
import {
  buildShadowDecisionRecord,
  classifyLetterFailure,
  computeLetterCompletionAtThreshold,
  computeOrderedCoveredLetters,
  evaluateInkAwareTraversal,
  SHADOW_INK_THRESHOLDS,
} from './shadow-traversal';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const robzBoundarySet = letterBoundariesFromWordShape(robzShape);
const EXPECTED_LETTERS = ['R', 'O', 'B', 'Z'];

function analyze(route: readonly Vec2[]) {
  const identity = analyzeTargetIdentity({ route, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inkResult = computeInkOnlyOccupancy({
    route,
    target: robzShape.points,
    boundarySet: robzBoundarySet,
    letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited),
  });
  const trace = buildTraversalTrace({
    pathPoints: route,
    target: robzShape.points,
    boundaries: robzBoundarySet.boundaries,
    expectedLetters: EXPECTED_LETTERS,
    actualWordTraversal: identity.traversesMostOfWord,
  });
  const decision = buildShadowDecisionRecord({
    word: 'ROBZ',
    geometryVariant: 'smooth',
    candidateRank: -1,
    identity,
    inkResult,
    trace,
  });
  return { identity, inkResult, trace, decision };
}

// --- 1. a route covering all letters with high raw ink occupancy ---
{
  const { decision } = analyze(robzShape.points);
  tests.push({
    name: '1. full target walk: every letter is ink-covered and in order',
    passed: decision.allLettersCovered && decision.allLettersCoveredAndOrdered,
    detail: `letters=${decision.letters.map((l) => `${l.letter}=${l.rawInkOccupancy.toFixed(2)}`).join(' ')} category=${decision.decisionCategory}`,
  });
}

// --- 2. a route covering all letters but in wrong order ---
{
  const [r, o, b, z] = robzShape.letters;
  const outOfOrderRoute: Vec2[] = [...o!.points, ...r!.points, ...b!.points, ...z!.points];
  const { decision } = analyze(outOfOrderRoute);
  tests.push({
    name: '2. O-then-R swapped route: all letters still ink-covered, but NOT covered-in-order; current+ink-aware evaluators both reject',
    passed:
      decision.allLettersCovered &&
      !decision.allLettersCoveredAndOrdered &&
      !decision.visitedLettersInOrder &&
      !decision.currentWordTraversal &&
      !decision.inkAwareTraversal &&
      decision.decisionCategory === 'covered_not_ordered',
    detail: `orderedCoveredLetters=${decision.orderedCoveredLetters.join(',')} category=${decision.decisionCategory}`,
  });
}

// --- 3. a route covering only the first letters ---
{
  const rOnlyRoute = robzShape.letters[0]!.points;
  const { decision } = analyze(rOnlyRoute);
  tests.push({
    name: '3. R-only route: not all letters covered, O is the first missing letter, category=missing_letter',
    passed: !decision.allLettersCovered && decision.firstMissingLetter === 'O' && decision.decisionCategory === 'missing_letter',
    detail: `covered=${decision.coveredLetters.join(',')} firstMissing=${decision.firstMissingLetter} category=${decision.decisionCategory}`,
  });
}

// --- 4. a route with high occupancy on letters but low existing order ---
{
  // Walk each letter's own points BACKWARDS (still visiting every point, so
  // raw ink occupancy stays high) while keeping the macro R->O->B->Z
  // sequence intact — isolates "did we draw the ink" from "did we draw it
  // in the letter's own expected direction", which is exactly what
  // scoreOrderedPath's per-letter `order` score penalizes.
  const reversedRoute: Vec2[] = robzShape.letters.flatMap((letter) => [...letter.points].reverse());
  const { decision } = analyze(reversedRoute);
  const lowOrderLetters = decision.letters.filter((letter) => letter.rawInkOccupancy >= 0.5 && letter.existingOrder < letter.existingCoverage);
  tests.push({
    name: '4. letters walked backwards: at least one letter has high raw ink occupancy but a depressed order score relative to its own coverage',
    passed: lowOrderLetters.length > 0,
    detail: decision.letters.map((l) => `${l.letter} ink=${l.rawInkOccupancy.toFixed(2)} cov=${l.existingCoverage.toFixed(2)} ord=${l.existingOrder.toFixed(2)}`).join(' | '),
  });
  const failureReasons = decision.letters.filter((l) => !l.existingMeaningfullyVisited).map((l) => classifyLetterFailure(l));
  tests.push({
    name: '4. per-letter failure attribution: every non-meaningfullyVisited letter is attributed to coverage, order, or both (never "none")',
    passed: failureReasons.every((reason) => reason !== 'none'),
    detail: `reasons=${failureReasons.join(',')}`,
  });
}

// --- 5. a route where connector geometry is absent/ignored by ink-only metrics ---
{
  const detourOffset = 0.15;
  const route: Vec2[] = [];
  robzShape.letters.forEach((letter, index) => {
    if (index > 0) {
      const last = route[route.length - 1]!;
      route.push({ x: last.x, y: last.y + detourOffset });
      route.push({ x: letter.points[0]!.x, y: letter.points[0]!.y + detourOffset });
    }
    route.push(...letter.points);
  });
  const { decision, inkResult } = analyze(route);
  tests.push({
    name: '5. route follows every letter but detours around connectors: ink-only occupancy stays high and all letters are covered-and-ordered regardless of the connector detour',
    passed: inkResult.inkOnlyOccupancy >= 0.8 && decision.allLettersCoveredAndOrdered,
    detail: `inkOnlyOccupancy=${inkResult.inkOnlyOccupancy.toFixed(3)} allLettersCoveredAndOrdered=${decision.allLettersCoveredAndOrdered}`,
  });
}

// --- 6. threshold sensitivity at 0.40 / 0.50 / 0.60 / 0.70 ---
{
  // A partial route (R fully, O half) gives a mixed per-letter occupancy
  // profile, so completion counts should be non-increasing as the threshold
  // rises — a structural invariant that holds for ANY candidate, not just
  // this one, and directly verifies the four SHADOW_INK_THRESHOLDS values.
  const oPoints = robzShape.letters[1]!.points;
  const partialRoute: Vec2[] = [...robzShape.letters[0]!.points, ...oPoints.slice(0, Math.ceil(oPoints.length / 2))];
  const { decision } = analyze(partialRoute);
  tests.push({
    name: '6. threshold sensitivity: completionByThreshold has one entry per SHADOW_INK_THRESHOLDS value, in ascending threshold order',
    passed:
      decision.completionByThreshold.length === SHADOW_INK_THRESHOLDS.length &&
      decision.completionByThreshold.every((entry, index) => entry.threshold === SHADOW_INK_THRESHOLDS[index]),
    detail: decision.completionByThreshold.map((e) => `${e.threshold}:${e.lettersCompleted}/${e.expectedLetters}`).join(' '),
  });
  tests.push({
    name: '6. threshold sensitivity: lettersCompleted is non-increasing as the threshold rises (a stricter bar never completes MORE letters)',
    passed: decision.completionByThreshold.every((entry, index) => index === 0 || entry.lettersCompleted <= decision.completionByThreshold[index - 1]!.lettersCompleted),
    detail: decision.completionByThreshold.map((e) => `${e.threshold}:${e.lettersCompleted}`).join(' '),
  });
}

// --- computeLetterCompletionAtThreshold / evaluateInkAwareTraversal / computeOrderedCoveredLetters are pure (no shared state) ---
{
  const { identity, inkResult, trace, decision } = analyze(robzShape.points);
  const before = evaluateInkAwareTraversal(identity, inkResult.inkOnlyOccupancy);
  computeLetterCompletionAtThreshold(decision.letters, 0.5);
  computeOrderedCoveredLetters(decision.letters, trace, 0.5);
  const after = evaluateInkAwareTraversal(identity, inkResult.inkOnlyOccupancy);
  tests.push({
    name: 'evaluators are pure: calling other shadow functions in between does not change evaluateInkAwareTraversal\'s result',
    passed: before === after,
    detail: `before=${before} after=${after}`,
  });
}

// --- existing wordTraversal/traversesMostOfWord output is completely unaffected by computing shadow metrics ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  analyze(robzShape.points);
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'existing spanOccupancy/targetSpan/wordTraversal/traversesMostOfWord are unaffected by computing shadow-evaluator metrics (no shared mutable state)',
    passed:
      identityBefore.spanOccupancy === identityAfter.spanOccupancy &&
      identityBefore.targetSpan === identityAfter.targetSpan &&
      identityBefore.wordTraversal === identityAfter.wordTraversal &&
      identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord,
    detail: `before traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
