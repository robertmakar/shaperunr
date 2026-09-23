/**
 * DEVELOPMENT ONLY. Tests for the multi-letter traversal diagnostics
 * (letter boundary extraction, letter-from-progress lookup, traversal
 * trace construction, missing-letter / out-of-order detection). Pure
 * functions only — no network, no route generation.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { buildTraversalTrace, letterAtProgress, letterBoundariesFromWordShape } from './multi-letter-trace';

type SelfTest = { name: string; passed: boolean; detail: string };

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const robzBoundarySet = letterBoundariesFromWordShape(robzShape);
const robzBoundaries = robzBoundarySet.boundaries;

const tests: SelfTest[] = [];

// --- letter boundary extraction ---
tests.push({
  name: 'letter boundaries: one entry per letter, in word order',
  passed: robzBoundaries.length === 4 && robzBoundaries.map((b) => b.letter).join('') === 'ROBZ',
  detail: robzBoundaries.map((b) => b.letter).join(''),
});
tests.push({
  name: 'letter boundaries: projected progress is monotonically non-decreasing across letters',
  passed: robzBoundaries.every((b, i) => i === 0 || b.projectedStartProgress >= (robzBoundaries[i - 1]?.projectedStartProgress ?? 0) - 1e-6),
  detail: robzBoundaries.map((b) => b.projectedStartProgress.toFixed(3)).join(', '),
});
tests.push({
  name: 'letter boundaries: first letter starts at progress 0, last letter ends at progress 1',
  passed:
    Math.abs((robzBoundaries[0]?.projectedStartProgress ?? -1) - 0) < 1e-6 &&
    Math.abs((robzBoundaries[3]?.projectedEndProgress ?? -1) - 1) < 1e-6,
  detail: `start=${robzBoundaries[0]?.projectedStartProgress} end=${robzBoundaries[3]?.projectedEndProgress}`,
});
tests.push({
  name: 'letter boundaries: length-based representation (normalized against letter length only, matching regionsFromLetterLengths) also covers 0..1 across the word',
  passed:
    Math.abs((robzBoundaries[0]?.lengthStartProgress ?? -1) - 0) < 1e-6 &&
    Math.abs((robzBoundaries[3]?.lengthEndProgress ?? -1) - 1) < 1e-6,
  detail: `start=${robzBoundaries[0]?.lengthStartProgress} end=${robzBoundaries[3]?.lengthEndProgress}`,
});
tests.push({
  name: 'letter boundaries: ROBZ has a non-zero inter-letter gap (the flattened target polyline is longer than the sum of the 4 letters\' own ink)',
  passed: robzBoundarySet.interLetterGapLength > 0 && robzBoundarySet.totalFlattenedLength > robzBoundarySet.totalLetterLength,
  detail: `totalFlattened=${robzBoundarySet.totalFlattenedLength.toFixed(3)} totalLetters=${robzBoundarySet.totalLetterLength.toFixed(3)} gap=${robzBoundarySet.interLetterGapLength.toFixed(3)}`,
});

// --- letter identification from target progress ---
tests.push({
  name: 'letterAtProgress: progress 0 resolves to the first letter',
  passed: letterAtProgress(0, robzBoundaries)?.letter === 'R',
  detail: String(letterAtProgress(0, robzBoundaries)?.letter),
});
tests.push({
  name: 'letterAtProgress: progress 1 resolves to the last letter',
  passed: letterAtProgress(1, robzBoundaries)?.letter === 'Z',
  detail: String(letterAtProgress(1, robzBoundaries)?.letter),
});
tests.push({
  name: 'letterAtProgress: a mid-letter progress resolves to a real letter, not null',
  passed: letterAtProgress((robzBoundaries[1]!.projectedStartProgress + robzBoundaries[1]!.projectedEndProgress) / 2, robzBoundaries)?.letter === 'O',
  detail: String(letterAtProgress((robzBoundaries[1]!.projectedStartProgress + robzBoundaries[1]!.projectedEndProgress) / 2, robzBoundaries)?.letter),
});
tests.push({
  name: 'letterAtProgress: an out-of-range progress resolves to null, not a crash',
  passed: letterAtProgress(5, robzBoundaries) === null,
  detail: String(letterAtProgress(5, robzBoundaries)),
});

// --- traversal trace: complete, in-order ---
{
  // A synthetic path that walks straight along the real target, sampled in order — should read as the full expected sequence, in order.
  const target = robzShape.points;
  const trace = buildTraversalTrace({
    pathPoints: target,
    target,
    boundaries: robzBoundaries,
    expectedLetters: ['R', 'O', 'B', 'Z'],
  });
  tests.push({
    name: 'traversal trace: walking the exact target visits all 4 letters in order',
    passed: trace.allLettersVisited && trace.lettersVisitedInOrder && trace.failureMode === 'complete',
    detail: `visited=${trace.lettersVisited.join('')} inOrder=${trace.lettersVisitedInOrder} mode=${trace.failureMode}`,
  });
  tests.push({
    name: 'traversal trace: maxLetterIndexReached is the last letter (index 3) when the full word is walked',
    passed: trace.maxLetterIndexReached === 3 && trace.finalLetterIndexReached === 3,
    detail: `max=${trace.maxLetterIndexReached} final=${trace.finalLetterIndexReached}`,
  });
}

// --- traversal trace: missing-letter detection (Failure A) ---
{
  const target = robzShape.points;
  // Only the first quarter of the target (roughly the R) — should never reach O/B/Z.
  const rOnly = target.slice(0, Math.max(2, Math.round(target.length * 0.2)));
  const trace = buildTraversalTrace({
    pathPoints: rOnly,
    target,
    boundaries: robzBoundaries,
    expectedLetters: ['R', 'O', 'B', 'Z'],
  });
  tests.push({
    name: 'traversal trace: a path confined to the first letter reports missing later letters (failure A)',
    passed: trace.failureMode === 'never_reached_later_letters' && trace.firstMissingLetter != null && trace.firstMissingLetter !== 'R',
    detail: `mode=${trace.failureMode} firstMissing=${trace.firstMissingLetter} visited=${trace.lettersVisited.join('')}`,
  });
}

// --- traversal trace: out-of-order detection (Failure B) ---
// Only meaningful once every letter is eventually visited (failure A takes priority otherwise), so this walks all 4 letters' spans but with the first two swapped: O, R, B, Z.
{
  const target = robzShape.points;
  const sliceFor = (boundary: (typeof robzBoundaries)[number]) => {
    const startIndex = Math.max(0, Math.round(boundary.projectedStartProgress * (target.length - 1)));
    const endIndex = Math.min(target.length - 1, Math.round(boundary.projectedEndProgress * (target.length - 1)));
    return target.slice(startIndex, Math.max(endIndex, startIndex + 2));
  };
  const [boundaryR, boundaryO, boundaryB, boundaryZ] = robzBoundaries;
  const outOfOrderPath = [
    ...sliceFor(boundaryO!),
    ...sliceFor(boundaryR!),
    ...sliceFor(boundaryB!),
    ...sliceFor(boundaryZ!),
  ];
  const trace = buildTraversalTrace({
    pathPoints: outOfOrderPath,
    target,
    boundaries: robzBoundaries,
    expectedLetters: ['R', 'O', 'B', 'Z'],
  });
  tests.push({
    name: 'traversal trace: visiting O,R,B,Z (all 4, first two swapped) is detected as failure B, not failure A',
    passed: trace.allLettersVisited && !trace.lettersVisitedInOrder && trace.failureMode === 'reached_but_wrong_order',
    detail: `visited=${trace.lettersVisited.join(',')} allVisited=${trace.allLettersVisited} inOrder=${trace.lettersVisitedInOrder} mode=${trace.failureMode} firstOutOfOrder=${JSON.stringify(trace.firstOutOfOrderTransition)}`,
  });
}

// --- traversal trace: reached everything in order but an external gate still says false ---
{
  const target = robzShape.points;
  const trace = buildTraversalTrace({
    pathPoints: target,
    target,
    boundaries: robzBoundaries,
    expectedLetters: ['R', 'O', 'B', 'Z'],
    actualWordTraversal: false,
  });
  tests.push({
    name: 'traversal trace: full in-order visit but actualWordTraversal=false reports "reached_all_but_other_gate", not "complete"',
    passed: trace.failureMode === 'reached_all_but_other_gate',
    detail: trace.failureMode,
  });
}

// --- no data ---
{
  const target = robzShape.points;
  const trace = buildTraversalTrace({
    pathPoints: [],
    target,
    boundaries: robzBoundaries,
    expectedLetters: ['R', 'O', 'B', 'Z'],
  });
  tests.push({
    name: 'traversal trace: an empty path is reported as no_data, not a crash or a false "complete"',
    passed: trace.failureMode === 'no_data',
    detail: trace.failureMode,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
