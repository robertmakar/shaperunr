import assert from 'node:assert/strict';
import { evaluateRepairGate, evaluateCombinedRepairGate, type RouteMetricsForGate } from './checkpoint-repair-gate-diagnostic';

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

function metrics(overrides: Partial<RouteMetricsForGate> = {}): RouteMetricsForGate {
  return {
    shapeScore: 0.75,
    coverage: 0.8,
    backtrack: 0.05,
    lengthRatio: 0.6,
    continuityValid: true,
    letters: [
      { letter: 'C', rawInkCoverage: 1, coverage: 0.83, physicallyCovered: true },
      { letter: 'A', rawInkCoverage: 0.9, coverage: 0.87, physicallyCovered: true },
      { letter: 'I', rawInkCoverage: 1, coverage: 0.04, physicallyCovered: false },
      { letter: 'R', rawInkCoverage: 0.57, coverage: 0.25, physicallyCovered: false },
      { letter: 'O', rawInkCoverage: 0.6, coverage: 0.33, physicallyCovered: false },
    ],
    ...overrides,
  };
}

check('a clean repair (I improves, everything else identical) is accepted', () => {
  const baseline = metrics();
  const repaired = metrics({ letters: baseline.letters.map((l, i) => (i === 2 ? { ...l, coverage: 0.55, physicallyCovered: true } : l)) });
  const result = evaluateRepairGate(baseline, repaired, 2);
  assert.equal(result.targetLetterImproved, true);
  assert.equal(result.targetLetterCrossedThreshold, true);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.regressedLetters, []);
  assert.deepEqual(result.improvedLetters, ['I']);
});

check('a repair that improves I but breaks C (C loses physicallyCovered) is REJECTED', () => {
  const baseline = metrics();
  const repaired = metrics({
    letters: baseline.letters.map((l, i) => {
      if (i === 2) return { ...l, coverage: 0.55, physicallyCovered: true };
      if (i === 0) return { ...l, rawInkCoverage: 0.3, coverage: 0.3, physicallyCovered: false };
      return l;
    }),
  });
  const result = evaluateRepairGate(baseline, repaired, 2);
  assert.equal(result.targetLetterImproved, true);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.regressedLetters, ['C']);
  const noNewGuard = result.guardrails.find((g) => g.name === 'noNewlyUncoveredLetter');
  assert.equal(noNewGuard?.passed, false);
});

check('a repair with no target-letter improvement is rejected regardless of guardrails', () => {
  const baseline = metrics();
  const repaired = metrics(); // identical
  const result = evaluateRepairGate(baseline, repaired, 2);
  assert.equal(result.targetLetterImproved, false);
  assert.equal(result.accepted, false);
});

check('a shapeScore drop exceeding the guardrail rejects an otherwise-improving repair', () => {
  const baseline = metrics();
  const repaired = metrics({
    shapeScore: baseline.shapeScore - 0.05, // exceeds maxShapeScoreDrop=0.03
    letters: baseline.letters.map((l, i) => (i === 2 ? { ...l, coverage: 0.55, physicallyCovered: true } : l)),
  });
  const result = evaluateRepairGate(baseline, repaired, 2);
  assert.equal(result.targetLetterImproved, true);
  assert.equal(result.accepted, false);
  const shapeScoreGuard = result.guardrails.find((g) => g.name === 'shapeScore');
  assert.equal(shapeScoreGuard?.passed, false);
});

check('continuity flipping from valid to invalid rejects the repair', () => {
  const baseline = metrics({ continuityValid: true });
  const repaired = metrics({
    continuityValid: false,
    letters: baseline.letters.map((l, i) => (i === 2 ? { ...l, coverage: 0.55, physicallyCovered: true } : l)),
  });
  const result = evaluateRepairGate(baseline, repaired, 2);
  assert.equal(result.accepted, false);
  const continuityGuard = result.guardrails.find((g) => g.name === 'continuity');
  assert.equal(continuityGuard?.passed, false);
});

check('lengthRatio relative-drop guardrail: a >25% relative decrease rejects, a smaller decrease passes', () => {
  const baseline = metrics({ lengthRatio: 0.6 });
  const repairedBad = metrics({ lengthRatio: 0.6 * 0.7, letters: baseline.letters.map((l, i) => (i === 2 ? { ...l, coverage: 0.55, physicallyCovered: true } : l)) }); // 30% relative drop
  const repairedOk = metrics({ lengthRatio: 0.6 * 0.85, letters: baseline.letters.map((l, i) => (i === 2 ? { ...l, coverage: 0.55, physicallyCovered: true } : l)) }); // 15% relative drop
  const bad = evaluateRepairGate(baseline, repairedBad, 2);
  const ok = evaluateRepairGate(baseline, repairedOk, 2);
  assert.equal(bad.guardrails.find((g) => g.name === 'lengthRatio')?.passed, false);
  assert.equal(ok.guardrails.find((g) => g.name === 'lengthRatio')?.passed, true);
});

check('evaluateCombinedRepairGate: both letters improving, nothing regressed -> accepted', () => {
  const baseline = metrics();
  const repaired = metrics({
    letters: baseline.letters.map((l, i) => {
      if (i === 2) return { ...l, coverage: 0.55, physicallyCovered: true }; // I
      if (i === 4) return { ...l, coverage: 0.45, physicallyCovered: true }; // O
      return l;
    }),
  });
  const result = evaluateCombinedRepairGate(baseline, repaired, [2, 4]);
  assert.deepEqual(result.targetedLettersImproved, [true, true]);
  assert.equal(result.allTargetedLettersImproved, true);
  assert.equal(result.accepted, true);
});

check('evaluateCombinedRepairGate: one targeted letter fails to improve -> rejected even if aggregate metrics look fine (COMPETITIVE case)', () => {
  const baseline = metrics();
  const repaired = metrics({
    letters: baseline.letters.map((l, i) => {
      if (i === 2) return { ...l, coverage: 0.55, physicallyCovered: true }; // I improves
      if (i === 4) return { ...l, coverage: 0.2, physicallyCovered: false }; // O gets WORSE (was 0.33, now 0.2) - not an improvement
      return l;
    }),
  });
  const result = evaluateCombinedRepairGate(baseline, repaired, [2, 4]);
  assert.deepEqual(result.targetedLettersImproved, [true, false]);
  assert.equal(result.allTargetedLettersImproved, false);
  assert.equal(result.accepted, false);
});

check('evaluateCombinedRepairGate: a collateral regression on a THIRD (non-targeted) letter still rejects via noNewlyUncoveredLetter', () => {
  const baseline = metrics();
  const repaired = metrics({
    letters: baseline.letters.map((l, i) => {
      if (i === 2) return { ...l, coverage: 0.55, physicallyCovered: true }; // I
      if (i === 4) return { ...l, coverage: 0.45, physicallyCovered: true }; // O
      if (i === 0) return { ...l, rawInkCoverage: 0.3, coverage: 0.3, physicallyCovered: false }; // C regresses (not targeted)
      return l;
    }),
  });
  const result = evaluateCombinedRepairGate(baseline, repaired, [2, 4]);
  assert.equal(result.allTargetedLettersImproved, true);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.regressedLetters, ['C']);
});

console.log(`checkpoint-repair-gate-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
