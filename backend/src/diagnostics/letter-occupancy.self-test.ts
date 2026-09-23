/**
 * DEVELOPMENT ONLY. Tests for the diagnostic ink-only occupancy metric.
 * Pure functions only — no network, no route generation, no gate/threshold
 * assertions (this metric never feeds into wordTraversal).
 */
import type { Vec2 } from '@/lib/geometry';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

// --- 1. a simple single-letter target ---
{
  const oShape = buildWalkableWordShape('O', { letterVariant: 'smooth' });
  const boundarySet = letterBoundariesFromWordShape(oShape);
  const result = computeInkOnlyOccupancy({ route: oShape.points, target: oShape.points, boundarySet });
  tests.push({
    name: '1. single-letter target: walking it fully gives near-complete ink-only occupancy',
    passed: result.inkOnlyOccupancy >= 0.9 && result.perLetterOccupancy.length === 1,
    detail: `inkOnlyOccupancy=${result.inkOnlyOccupancy.toFixed(3)} letters=${result.perLetterOccupancy.length}`,
  });
  tests.push({
    name: '1. single-letter target: every bin is an ink bin (a lone letter has no inter-letter gap to exclude)',
    passed: result.gapBinCount === 0 && result.inkBinCount === result.totalBinCount,
    detail: `ink=${result.inkBinCount} gap=${result.gapBinCount} total=${result.totalBinCount}`,
  });
}

// --- 2. a multi-letter target with artificial inter-letter connectors ---
const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const robzBoundarySet = letterBoundariesFromWordShape(robzShape);
{
  tests.push({
    name: '2. multi-letter target (ROBZ): a real inter-letter gap exists, so some bins are excluded as gap bins',
    passed: robzBoundarySet.interLetterGapLength > 0,
    detail: `gapLength=${robzBoundarySet.interLetterGapLength.toFixed(3)} of total=${robzBoundarySet.totalFlattenedLength.toFixed(3)}`,
  });
  const fullWalk = computeInkOnlyOccupancy({ route: robzShape.points, target: robzShape.points, boundarySet: robzBoundarySet });
  tests.push({
    name: '2. multi-letter target (ROBZ): walking the full target still has some gap bins excluded from the denominator',
    passed: fullWalk.gapBinCount > 0 && fullWalk.inkBinCount < fullWalk.totalBinCount,
    detail: `ink=${fullWalk.inkBinCount} gap=${fullWalk.gapBinCount} total=${fullWalk.totalBinCount}`,
  });
}

// --- 3. a route that follows all actual letters but not the artificial connectors ---
{
  // Each letter's own ink, densely covered, but detouring modestly off to the side between letters
  // instead of following the straight connector line — simulates a runner who traced every letter
  // but took a different nearby street in between, never hugging the artificial connector. Kept
  // small relative to the word's own ~1-unit-per-letter scale so the detour doesn't dominate
  // resamplePolyline's arc-length-based sampling budget (a huge detour would starve the letters
  // of samples, which is an artifact of the test construction, not of the metric itself).
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

  const inkResult = computeInkOnlyOccupancy({ route, target: robzShape.points, boundarySet: robzBoundarySet });
  const identity = analyzeTargetIdentity({ route, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });

  tests.push({
    name: '3. route follows every letter\'s ink but detours around the connectors: ink-only occupancy stays high',
    passed: inkResult.inkOnlyOccupancy >= 0.8,
    detail: `inkOnlyOccupancy=${inkResult.inkOnlyOccupancy.toFixed(3)}`,
  });
  tests.push({
    name: '3. same route: ink-only occupancy is higher than the existing spanOccupancy/targetSpan (the connector detour depresses the existing connected-span metric more than it depresses ink-only occupancy)',
    passed: inkResult.inkOnlyOccupancy > identity.targetSpan,
    detail: `inkOnlyOccupancy=${inkResult.inkOnlyOccupancy.toFixed(3)} existing targetSpan=${identity.targetSpan.toFixed(3)} existing spanOccupancy=${identity.spanOccupancy.toFixed(3)}`,
  });
  tests.push({
    name: '3. same route: every individual letter shows high per-letter occupancy',
    passed: inkResult.perLetterOccupancy.every((letter) => letter.occupancy >= 0.7),
    detail: inkResult.perLetterOccupancy.map((letter) => `${letter.letter}=${letter.occupancy.toFixed(2)}`).join(' '),
  });
}

// --- 4. a route that only follows one letter ---
{
  const rLetter = robzShape.letters[0]!;
  const inkResult = computeInkOnlyOccupancy({ route: rLetter.points, target: robzShape.points, boundarySet: robzBoundarySet });
  tests.push({
    name: '4. route confined to letter R: R has high occupancy, the other three letters have ~zero',
    passed:
      (inkResult.perLetterOccupancy[0]?.occupancy ?? 0) >= 0.5 &&
      inkResult.perLetterOccupancy.slice(1).every((letter) => letter.occupancy <= 0.1),
    detail: inkResult.perLetterOccupancy.map((letter) => `${letter.letter}=${letter.occupancy.toFixed(2)}`).join(' '),
  });
}

// --- 5. a route that visits multiple letters in order ---
{
  const inkResult = computeInkOnlyOccupancy({ route: robzShape.points, target: robzShape.points, boundarySet: robzBoundarySet });
  tests.push({
    name: '5. route walking the full target in order: all four letters individually show high occupancy',
    passed: inkResult.perLetterOccupancy.every((letter) => letter.occupancy >= 0.6),
    detail: inkResult.perLetterOccupancy.map((letter) => `${letter.letter}=${letter.occupancy.toFixed(2)}`).join(' '),
  });
}

// --- 6. a route that visits letters out of order ---
{
  const [r, o, b, z] = robzShape.letters;
  const outOfOrderRoute: Vec2[] = [...o!.points, ...r!.points, ...b!.points, ...z!.points];
  const inkResult = computeInkOnlyOccupancy({ route: outOfOrderRoute, target: robzShape.points, boundarySet: robzBoundarySet });
  tests.push({
    name: '6. route visiting O then R (swapped) then B, Z: per-letter occupancy is still high for both R and O — occupancy measures density, not order',
    passed: (inkResult.perLetterOccupancy[0]?.occupancy ?? 0) >= 0.5 && (inkResult.perLetterOccupancy[1]?.occupancy ?? 0) >= 0.5,
    detail: inkResult.perLetterOccupancy.map((letter) => `${letter.letter}=${letter.occupancy.toFixed(2)}`).join(' '),
  });
}

// --- completed-letter count reuses the existing meaningfullyVisited flags, doesn't re-derive them ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inkResult = computeInkOnlyOccupancy({
    route: robzShape.points,
    target: robzShape.points,
    boundarySet: robzBoundarySet,
    letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited),
  });
  const completedCount = inkResult.perLetterOccupancy.filter((letter) => letter.completed).length;
  tests.push({
    name: 'completed-letter count: matches TargetIdentity.lettersVisited exactly (reused, not re-derived)',
    passed: completedCount === identity.lettersVisited,
    detail: `inkOnly completedCount=${completedCount} identity.lettersVisited=${identity.lettersVisited}`,
  });
}

// --- existing spanOccupancy is untouched by this module ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  computeInkOnlyOccupancy({ route: robzShape.points, target: robzShape.points, boundarySet: robzBoundarySet });
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'existing spanOccupancy/targetSpan/traversesMostOfWord are unaffected by computing the diagnostic metric (no shared mutable state)',
    passed:
      identityBefore.spanOccupancy === identityAfter.spanOccupancy &&
      identityBefore.targetSpan === identityAfter.targetSpan &&
      identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord,
    detail: `before spanOccupancy=${identityBefore.spanOccupancy.toFixed(4)} after=${identityAfter.spanOccupancy.toFixed(4)}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
