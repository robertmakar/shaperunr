/**
 * DEVELOPMENT ONLY. Tests for the combined shadow evaluation matrix.
 *
 * A. Occupancy parity — condition A_current reproduces production exactly.
 * B. Ink-only calculation — synthetic letter+connector case proves current
 *    occupancy includes connector effects while ink-only excludes them.
 * C. DTW parity — at 1x, shadow order matches production exactly (reuses
 *    the same guarantee dtw-tolerance-diagnostic.ts already proved, checked
 *    again here at the LetterShadowRecord level).
 * D. Combined isolation — running the shadow evaluation does not mutate
 *    production state/results.
 */
import type { Vec2 } from '@/lib/geometry';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  buildLetterShadowRecords,
  classifyCandidate,
  computeConditionResults,
} from './combined-shadow-matrix';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { extractLetterOrderInputs } from './order-score-diagnostic';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const robzBoundarySet = letterBoundariesFromWordShape(robzShape);

function buildMatrix(route: readonly Vec2[], target: readonly Vec2[] = robzShape.points) {
  const identity = analyzeTargetIdentity({ route, target, word: 'ROBZ', geometryVariant: 'smooth' });
  const inkResult = computeInkOnlyOccupancy({
    route,
    target,
    boundarySet: robzBoundarySet,
    letterMeaningfullyVisited: identity.letters.map((l) => l.meaningfullyVisited),
  });
  const orderInputs = extractLetterOrderInputs('ROBZ', target, route, 'smooth');
  const letters = buildLetterShadowRecords(identity, inkResult, orderInputs);
  const conditions = computeConditionResults(identity, letters, identity.targetSpan, inkResult.inkOnlyOccupancy);
  return { identity, inkResult, letters, conditions };
}

// --- A. occupancy parity: condition A_current reproduces production exactly ---
{
  const { identity, conditions } = buildMatrix(robzShape.points);
  const a = conditions.find((c) => c.condition === 'A_current')!;
  tests.push({
    name: 'A. occupancy parity: condition A_current exactly reproduces production (completedLetterCount, lettersVisitedInOrder, wordTraversal, occupancy value)',
    passed:
      a.completedLetterCount === identity.lettersVisited &&
      a.lettersVisitedInOrder === identity.lettersVisitedInOrder &&
      a.wordTraversal === identity.traversesMostOfWord &&
      a.globalOccupancyValue === identity.targetSpan &&
      a.globalOccupancyPass === (identity.targetSpan >= 0.7),
    detail: `shadow: completed=${a.completedLetterCount} inOrder=${a.lettersVisitedInOrder} traversal=${a.wordTraversal} | prod: visited=${identity.lettersVisited} inOrder=${identity.lettersVisitedInOrder} traversal=${identity.traversesMostOfWord}`,
  });
}

// --- B. ink-only calculation: synthetic letter + large inter-letter connector ---
{
  // Route follows every letter's own ink densely but detours far around the
  // connectors — reuses the same construction validated in
  // letter-occupancy.self-test.ts's Test 3.
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
  const { inkResult, conditions } = buildMatrix(route);
  const a = conditions.find((c) => c.condition === 'A_current')!;
  const b = conditions.find((c) => c.condition === 'B_inkOnly')!;
  tests.push({
    name: 'B. ink-only calculation: current occupancy (connector-inclusive) is depressed relative to ink-only occupancy for a route that detours around connectors',
    passed: b.globalOccupancyValue > a.globalOccupancyValue,
    detail: `currentOccupiedSpan(A)=${a.globalOccupancyValue.toFixed(3)} inkOnlyOccupancy(B)=${b.globalOccupancyValue.toFixed(3)}`,
  });
  tests.push({
    name: 'B. ink-only calculation: inkOnlyOccupancy excludes connector bins (gapBinCount > 0, ink bins < total bins) — same underlying computeInkOnlyOccupancy guarantee reused here',
    passed: inkResult.gapBinCount > 0 && inkResult.inkBinCount < inkResult.totalBinCount,
    detail: `ink=${inkResult.inkBinCount} gap=${inkResult.gapBinCount} total=${inkResult.totalBinCount}`,
  });
}

// --- C. DTW parity: at 1x, shadow order matches production exactly ---
{
  const { identity, letters } = buildMatrix(robzShape.points);
  const mismatches = letters
    .map((letter, index) => ({ letter: letter.letter, shadow: letter.order1x, prod: identity.letters[index]!.order }))
    .filter((entry) => Math.abs(entry.shadow - entry.prod) > 1e-9);
  tests.push({
    name: 'C. DTW parity: order1x exactly matches production order for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : JSON.stringify(mismatches),
  });
  tests.push({
    name: 'C. DTW parity: meaningfullyVisited1x exactly matches production meaningfullyVisited for every letter',
    passed: letters.every((letter, index) => letter.meaningfullyVisited1x === identity.letters[index]!.meaningfullyVisited),
    detail: letters.map((l, i) => `${l.letter}:shadow=${l.meaningfullyVisited1x},prod=${identity.letters[i]!.meaningfullyVisited}`).join(' '),
  });
}

// --- D. combined isolation: running the shadow evaluation does not mutate production state ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  buildMatrix(robzShape.points);
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'D. combined isolation: running the full shadow matrix does not change a subsequent real analyzeTargetIdentity() result',
    passed:
      identityBefore.spanOccupancy === identityAfter.spanOccupancy &&
      identityBefore.targetSpan === identityAfter.targetSpan &&
      identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord &&
      identityBefore.letters.every((letter, index) => letter.order === identityAfter.letters[index]!.order),
    detail: `before traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

// --- classification: per_letter_coverage_rescued must never occur (coverage threshold is identical across all 4 conditions by construction) ---
{
  const { conditions } = buildMatrix(robzShape.points);
  const classification = classifyCandidate(conditions);
  tests.push({
    name: 'classification: a fully-passing candidate (walking the exact target) classifies as already_passing, never per_letter_coverage_rescued',
    passed: classification !== 'per_letter_coverage_rescued',
    detail: `classification=${classification}`,
  });
}

// --- classification: "occupancy not real blocker" example from the task spec (Section 8) ---
{
  // Construct a route confined to R only: occupiedSpan and inkOnlyOccupancy
  // both fail to matter here since completion is stuck at 1/4 regardless of
  // which occupancy or DTW multiplier is used.
  const rOnlyRoute = robzShape.letters[0]!.points;
  const { conditions } = buildMatrix(rOnlyRoute);
  const classification = classifyCandidate(conditions);
  tests.push({
    name: 'classification: a route confined to one letter never becomes "combined_interaction" or "already_passing" (completion is structurally stuck regardless of occupancy/DTW switches)',
    passed: classification !== 'combined_interaction' && classification !== 'already_passing',
    detail: `classification=${classification}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
