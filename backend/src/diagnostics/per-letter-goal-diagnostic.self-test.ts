import assert from 'node:assert/strict';

import type { LetterBinRange, SearchState } from './graph-shape-goal-mirror';
import { snapshotPerLetterCoverage, makeMinFractionGoal, makeMinHitCountGoal, findUnsatisfiableLetters } from './per-letter-goal-diagnostic';

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

function stateWithCovered(covered: number): SearchState {
  return { node: 'n', progress: 1, cost: 0, length: 0, covered, edgeIds: [], usedUndirected: new Set(), usedInterior: false, extraMask: 0 };
}

// Two letters: "A" occupies bins [0,1,2,3] (4 bins), "B" occupies bins [4] (1 bin, narrow).
const letterBins: LetterBinRange[] = [
  { letter: 'A', bins: [0, 1, 2, 3] },
  { letter: 'B', bins: [4] },
];

check('snapshotPerLetterCoverage reports correct coveredBins/fraction per letter', () => {
  const covered = (1 << 0) | (1 << 1) | (1 << 4); // A: bins 0,1 covered (2/4); B: bin 4 covered (1/1)
  const snap = snapshotPerLetterCoverage(covered, letterBins);
  assert.deepEqual(snap, [
    { letter: 'A', totalBins: 4, coveredBins: 2, fraction: 0.5 },
    { letter: 'B', totalBins: 1, coveredBins: 1, fraction: 1 },
  ]);
});

check('makeMinFractionGoal(0.5): fails when A is under 50%, passes once A reaches 50% and B is fully covered', () => {
  const goal = makeMinFractionGoal(0.5);
  const under = stateWithCovered((1 << 0) | (1 << 4)); // A: 1/4=0.25 < 0.5
  const at = stateWithCovered((1 << 0) | (1 << 1) | (1 << 4)); // A: 2/4=0.5 >= 0.5, B: 1/1
  assert.equal(goal(under, letterBins), false);
  assert.equal(goal(at, letterBins), true);
});

check('Variant A (fraction) and Variant C (adaptive ceil) are mathematically equivalent for X>0 — proof by direct comparison across a range of X and coverage patterns', () => {
  function adaptiveCeilGoal(minFraction: number) {
    return (state: SearchState, bins: readonly LetterBinRange[]): boolean => {
      for (const entry of bins) {
        const required = Math.max(1, Math.ceil(entry.bins.length * minFraction));
        let coveredCount = 0;
        for (const bin of entry.bins) if (state.covered & (1 << bin)) coveredCount += 1;
        if (coveredCount < required) return false;
      }
      return true;
    };
  }
  const wideLetterBins: LetterBinRange[] = [{ letter: 'W', bins: [0, 1, 2, 3, 4, 5, 6] }]; // 7 bins
  for (const x of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    const fractionGoal = makeMinFractionGoal(x);
    const ceilGoal = adaptiveCeilGoal(x);
    for (let coveredCount = 0; coveredCount <= 7; coveredCount += 1) {
      let mask = 0;
      for (let i = 0; i < coveredCount; i += 1) mask |= 1 << i;
      const state = stateWithCovered(mask);
      assert.equal(fractionGoal(state, wideLetterBins), ceilGoal(state, wideLetterBins), `mismatch at X=${x} coveredCount=${coveredCount}`);
    }
  }
});

check('makeMinHitCountGoal(2): a narrow 1-bin letter can NEVER satisfy a 2-hit requirement, regardless of coverage — an unsatisfiable-by-construction case', () => {
  const goal = makeMinHitCountGoal(2);
  const fullyCoveredNarrowLetter = stateWithCovered(1 << 4); // B's only bin, fully covered
  assert.equal(goal(fullyCoveredNarrowLetter, letterBins), false);
});

check('findUnsatisfiableLetters correctly flags B (1 bin) as unsatisfiable at minHits=2, and not at minHits=1', () => {
  assert.deepEqual(findUnsatisfiableLetters(letterBins, 2), ['B']);
  assert.deepEqual(findUnsatisfiableLetters(letterBins, 1), []);
});

check('makeMinFractionGoal(0) requires nothing (every state trivially passes)', () => {
  const goal = makeMinFractionGoal(0);
  assert.equal(goal(stateWithCovered(0), letterBins), true);
});

console.log(`per-letter-goal-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
