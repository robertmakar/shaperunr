import assert from 'node:assert/strict';

import { EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';
import { baseRejectionReasons, type ShadowGateInput } from './shadow-product-gate-evaluator';
import {
  evaluatePhysicalLayer,
  evaluateLetterCompleteness,
  evaluateShadowL1,
  evaluateShadowL2,
  classifyShadowL3,
  type PhysicalLayerInput,
  type LayeredGateInput,
} from './shadow-layered-gate-diagnostic';
import type { PhysicalWordTraversalResult } from './physical-word-traversal-evaluator';
import type { LetterVisitationConfidence, SequenceIntegrityResult } from './letter-sequence-integrity-diagnostic';

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

const GOOD_PHYSICAL: PhysicalLayerInput = {
  connected: true,
  shapeScore: 0.9,
  coverage: 0.8,
  backtrack: 0.05,
  largestGap: 0.05,
  lengthRatio: 0.9,
  continuityValid: true,
};

function fakePhysicalWord(letters: string[], allCovered: boolean): PhysicalWordTraversalResult {
  return {
    wordTraversalPhysical: allCovered,
    allLettersCovered: allCovered,
    lettersInBroadOrder: true,
    letters: letters.map((letter, index) => ({
      index,
      letter,
      rawInkCoverage: allCovered ? 0.9 : index === 0 ? 0.1 : 0.9,
      coverage: allCovered ? 0.9 : index === 0 ? 0.1 : 0.9,
      medianProgress: index / Math.max(letters.length - 1, 1),
      physicallyCovered: allCovered ? true : index !== 0,
    })),
    thresholds: { ink: 0.6, coverage: 0.4, sequenceTolerance: 0.02 },
    coveredLetterCount: allCovered ? letters.length : letters.length - 1,
    letterCount: letters.length,
    coverageFraction: allCovered ? 1 : (letters.length - 1) / letters.length,
    firstMissingLetter: allCovered ? null : letters[0]!,
    firstOrderViolation: null,
  };
}

function fakeVisitation(letters: string[], allVisited: boolean): LetterVisitationConfidence[] {
  return letters.map((letter, index) => ({
    letter,
    letterIndex: index,
    visited: allVisited ? true : index !== 0,
    blockCount: 1,
    totalSampleCount: 5,
    totalRouteDistanceUnits: 1,
    firstSampleIndex: 0,
    lastSampleIndex: 5,
    medianSampleIndex: 2,
  }));
}

function fakeSequence(letters: string[], valid: boolean): SequenceIntegrityResult {
  const observed = valid ? letters : [letters[1]!, letters[0]!, ...letters.slice(2)];
  return {
    observedSequence: observed,
    firstOccurrenceOrder: observed,
    missingLetters: [],
    sequenceValid: valid,
    reorderedPairs: valid ? [] : [{ earlier: letters[0]!, later: letters[1]! }],
    hasRevisit: false,
    revisitedLetters: [],
  };
}

// ---------------------------------------------------------------------------
// Layer 1 (physical): parity with baseRejectionReasons minus 'order'.
// ---------------------------------------------------------------------------

check('evaluatePhysicalLayer passes on all-good input', () => {
  const result = evaluatePhysicalLayer(GOOD_PHYSICAL);
  assert.equal(result.passes, true);
  assert.deepEqual(result.reasons, []);
});

check('evaluatePhysicalLayer never emits an order reason (order is excluded by design)', () => {
  const result = evaluatePhysicalLayer(GOOD_PHYSICAL);
  assert.ok(!result.reasons.includes('order' as never));
});

check('evaluatePhysicalLayer flags each condition independently, matching EXPERIMENTAL_PRODUCT thresholds exactly', () => {
  assert.equal(evaluatePhysicalLayer({ ...GOOD_PHYSICAL, connected: false }).reasons.includes('connected'), true);
  assert.equal(evaluatePhysicalLayer({ ...GOOD_PHYSICAL, shapeScore: EXPERIMENTAL_PRODUCT.minShapeScore - 0.01 }).reasons.includes('shapeScore'), true);
  assert.equal(evaluatePhysicalLayer({ ...GOOD_PHYSICAL, coverage: EXPERIMENTAL_PRODUCT.minCoverage - 0.01 }).reasons.includes('coverage'), true);
  assert.equal(evaluatePhysicalLayer({ ...GOOD_PHYSICAL, backtrack: EXPERIMENTAL_PRODUCT.maxBacktrack + 0.01 }).reasons.includes('backtrack'), true);
  assert.equal(evaluatePhysicalLayer({ ...GOOD_PHYSICAL, largestGap: EXPERIMENTAL_PRODUCT.maxLargestGap + 0.01 }).reasons.includes('largestGap'), true);
  assert.equal(evaluatePhysicalLayer({ ...GOOD_PHYSICAL, lengthRatio: EXPERIMENTAL_PRODUCT.minLengthRatio - 0.01 }).reasons.includes('lengthRatio'), true);
  assert.equal(evaluatePhysicalLayer({ ...GOOD_PHYSICAL, continuityValid: false }).reasons.includes('continuity'), true);
});

check('evaluatePhysicalLayer reasons are a strict subset of baseRejectionReasons reasons (minus order) for an equivalent input', () => {
  const shared: ShadowGateInput = {
    word: 'ROBZ',
    connected: true,
    shapeScore: 0.5,
    coverage: 0.5,
    order: 0.9,
    backtrack: 0.3,
    largestGap: 0.05,
    targetSpan: 0.9,
    lengthRatio: 0.9,
    currentWordTraversal: true,
    physical: fakePhysicalWord(['R', 'O', 'B', 'Z'], true),
    transitions: [],
  };
  const baseline = baseRejectionReasons(shared).filter((r) => r !== 'order');
  const layered = evaluatePhysicalLayer({
    connected: shared.connected,
    shapeScore: shared.shapeScore,
    coverage: shared.coverage,
    backtrack: shared.backtrack,
    largestGap: shared.largestGap,
    lengthRatio: shared.lengthRatio,
    continuityValid: true,
  }).reasons;
  assert.deepEqual([...layered].sort(), [...baseline].sort());
});

// ---------------------------------------------------------------------------
// Layer 2 (letter completeness).
// ---------------------------------------------------------------------------

check('evaluateLetterCompleteness: complete when both physicallyCovered AND visited for every letter', () => {
  const letters = ['R', 'O', 'B', 'Z'];
  const result = evaluateLetterCompleteness(fakePhysicalWord(letters, true), fakeVisitation(letters, true));
  assert.equal(result.complete, true);
  assert.deepEqual(result.missingLetters, []);
});

check('evaluateLetterCompleteness: missing if physicallyCovered is false even though visited is true', () => {
  const letters = ['R', 'O', 'B', 'Z'];
  const result = evaluateLetterCompleteness(fakePhysicalWord(letters, false), fakeVisitation(letters, true));
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingLetters, ['R']);
});

check('evaluateLetterCompleteness: missing if visited is false even though physicallyCovered is true', () => {
  const letters = ['R', 'O', 'B', 'Z'];
  const result = evaluateLetterCompleteness(fakePhysicalWord(letters, true), fakeVisitation(letters, false));
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingLetters, ['R']);
});

// ---------------------------------------------------------------------------
// Shadow L1 vs L2: differ ONLY on the order-gating condition.
// ---------------------------------------------------------------------------

function layeredInput(overrides: Partial<LayeredGateInput> = {}): LayeredGateInput {
  const letters = ['R', 'O', 'B', 'Z'];
  return {
    ...GOOD_PHYSICAL,
    word: 'ROBZ',
    letterCompleteness: evaluateLetterCompleteness(fakePhysicalWord(letters, true), fakeVisitation(letters, true)),
    sequence: fakeSequence(letters, true),
    wholeRouteOrder: 0.9,
    ...overrides,
  };
}

check('Shadow L1 passes when order>=0.6 and physical/completeness/sequence all pass', () => {
  const result = evaluateShadowL1(layeredInput({ wholeRouteOrder: 0.61 }));
  assert.equal(result.passes, true);
});

check('Shadow L1 fails when order<0.6 even though physical/completeness/sequence all pass', () => {
  const result = evaluateShadowL1(layeredInput({ wholeRouteOrder: 0.4884 }));
  assert.equal(result.passes, false);
  assert.deepEqual(result.reasons, ['wholeRouteOrder']);
});

check('Shadow L2 passes even when order<0.6, as long as physical/completeness/sequence pass (order is diagnostic-only)', () => {
  const result = evaluateShadowL2(layeredInput({ wholeRouteOrder: 0.0 }));
  assert.equal(result.passes, true);
});

check('Shadow L2 never emits a wholeRouteOrder reason under any order value', () => {
  const low = evaluateShadowL2(layeredInput({ wholeRouteOrder: 0.0 }));
  const high = evaluateShadowL2(layeredInput({ wholeRouteOrder: 1.0 }));
  assert.ok(!low.reasons.includes('wholeRouteOrder'));
  assert.ok(!high.reasons.includes('wholeRouteOrder'));
});

check('Shadow L1 and L2 agree exactly (both pass, or both fail for the same non-order reasons) whenever order>=0.6', () => {
  const highOrder = layeredInput({ wholeRouteOrder: 0.9 });
  const l1 = evaluateShadowL1(highOrder);
  const l2 = evaluateShadowL2(highOrder);
  assert.deepEqual(l1, l2);

  const failingBoth = layeredInput({ wholeRouteOrder: 0.9, shapeScore: 0.1 });
  const l1b = evaluateShadowL1(failingBoth);
  const l2b = evaluateShadowL2(failingBoth);
  assert.deepEqual(l1b, l2b);
});

check('Shadow L1/L2 fail on missing letter completeness regardless of order', () => {
  const letters = ['R', 'O', 'B', 'Z'];
  const input = layeredInput({
    letterCompleteness: evaluateLetterCompleteness(fakePhysicalWord(letters, false), fakeVisitation(letters, true)),
    wholeRouteOrder: 0.9,
  });
  assert.equal(evaluateShadowL1(input).reasons.includes('letterCompleteness'), true);
  assert.equal(evaluateShadowL2(input).reasons.includes('letterCompleteness'), true);
});

check('Shadow L1/L2 fail on invalid sequence regardless of order', () => {
  const letters = ['R', 'O', 'B', 'Z'];
  const input = layeredInput({ sequence: fakeSequence(letters, false), wholeRouteOrder: 0.9 });
  assert.equal(evaluateShadowL1(input).reasons.includes('sequenceIntegrity'), true);
  assert.equal(evaluateShadowL2(input).reasons.includes('sequenceIntegrity'), true);
});

check('Single-letter words skip completeness/sequence/order gating entirely (matches production isMultiLetter carve-out)', () => {
  const input = layeredInput({
    word: 'L',
    letterCompleteness: { complete: false, missingLetters: ['L'] },
    sequence: fakeSequence(['L'], false),
    wholeRouteOrder: 0.0,
  });
  assert.equal(evaluateShadowL1(input).passes, true);
  assert.equal(evaluateShadowL2(input).passes, true);
});

// ---------------------------------------------------------------------------
// Shadow L3: pure classification, no collapsed score, no gating decision.
// ---------------------------------------------------------------------------

check('Shadow L3 reports all four dimensions independently without producing a pass/fail verdict field', () => {
  const input = layeredInput({ wholeRouteOrder: 0.4884 });
  const result = classifyShadowL3(input);
  assert.equal(result.physicalPass, true);
  assert.equal(result.completenessPass, true);
  assert.equal(result.sequencePass, true);
  assert.equal(result.wholeRouteOrder, 0.4884);
  assert.ok(!('passes' in result));
});

check('Shadow L3 label reflects a physical/semantic pass with a sub-threshold order (the exact case this whole task investigates)', () => {
  const input = layeredInput({ wholeRouteOrder: 0.4884 });
  const result = classifyShadowL3(input);
  assert.equal(result.label, 'physical:PASS completeness:PASS sequence:PASS order:0.488');
});

check('Shadow L3 correctly separates a physical failure from a semantic failure (independent dimensions, not collapsed)', () => {
  const letters = ['R', 'O', 'B', 'Z'];
  const input = layeredInput({
    shapeScore: 0.1,
    sequence: fakeSequence(letters, false),
    wholeRouteOrder: 0.9,
  });
  const result = classifyShadowL3(input);
  assert.equal(result.physicalPass, false);
  assert.equal(result.sequencePass, false);
  assert.equal(result.completenessPass, true);
});

console.log(`shadow-layered-gate-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
