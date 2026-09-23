/**
 * DEVELOPMENT ONLY. Shadow layered product-gate evaluator — diagnostic
 * only, never called from the live route-generation/scoring/gate path,
 * never wired into experimental-product.ts.
 *
 * Synthesizes the last four diagnostics into a single question: once
 * letter completeness and chronological sequence are validated
 * independently (letter-sequence-integrity-diagnostic.ts,
 * physical-word-traversal-evaluator.ts — both reused unchanged here),
 * how much responsibility does whole-route order actually need to carry?
 *
 * Layer 1 (physical quality) uses the EXACT existing EXPERIMENTAL_PRODUCT
 * constants and comparisons (imported read-only), explicitly EXCLUDING
 * `order` — order is Layer 4, evaluated separately (Shadow L1 includes
 * it as a hard gate; Shadow L2 does not; Shadow L3 reports it without
 * gating).
 *
 * Layer 2 (letter completeness) uses the STRONGEST already-validated
 * combined visitation criterion: a letter counts as complete only if
 * BOTH (a) physicalWordTraversal's own per-letter physicallyCovered
 * (rawInkCoverage>=0.60 AND coverage>=0.40, unchanged from
 * physical-word-traversal-evaluator.ts) AND (b) the chronological
 * visitation-confidence signal from letter-sequence-integrity-
 * diagnostic.ts (a real >=2-sample block, not a single fleeting touch)
 * — combining the coverage-based and position-based evidence, per that
 * diagnostic's own Step 5 finding that a combination signal is stronger
 * than either alone. This is a NEW composition of two already-validated
 * signals, not a new threshold invented from scratch.
 *
 * Layer 3 (sequence) reuses evaluateSequenceIntegrity() unchanged
 * (letter-sequence-integrity-diagnostic.ts) — every intended letter
 * present, first-occurrence order correct, revisits explicitly tolerated.
 */
import { EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';
import type { PhysicalWordTraversalResult } from './physical-word-traversal-evaluator';
import type { LetterVisitationConfidence, SequenceIntegrityResult } from './letter-sequence-integrity-diagnostic';

function isMultiLetter(word: string): boolean {
  return word.replace(/[^A-Za-z]/g, '').length > 1;
}

// ---------------------------------------------------------------------------
// Layer 1 — physical quality (existing constants, order EXCLUDED by design).
// ---------------------------------------------------------------------------

export type PhysicalLayerInput = {
  connected: boolean;
  shapeScore: number;
  coverage: number;
  backtrack: number;
  largestGap: number;
  lengthRatio: number;
  continuityValid: boolean;
};

export type PhysicalLayerRuleName = 'connected' | 'shapeScore' | 'coverage' | 'backtrack' | 'largestGap' | 'lengthRatio' | 'continuity';

export function evaluatePhysicalLayer(input: PhysicalLayerInput): { passes: boolean; reasons: PhysicalLayerRuleName[] } {
  const reasons: PhysicalLayerRuleName[] = [];
  if (!input.connected) reasons.push('connected');
  if (input.shapeScore < EXPERIMENTAL_PRODUCT.minShapeScore) reasons.push('shapeScore');
  if (input.coverage < EXPERIMENTAL_PRODUCT.minCoverage) reasons.push('coverage');
  if (input.backtrack > EXPERIMENTAL_PRODUCT.maxBacktrack) reasons.push('backtrack');
  if (input.largestGap > EXPERIMENTAL_PRODUCT.maxLargestGap) reasons.push('largestGap');
  if (input.lengthRatio < EXPERIMENTAL_PRODUCT.minLengthRatio) reasons.push('lengthRatio');
  if (!input.continuityValid) reasons.push('continuity');
  return { passes: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Layer 2 — letter completeness: combined coverage + visitation-position signal.
// ---------------------------------------------------------------------------

export type LetterCompletenessResult = { complete: boolean; missingLetters: string[] };

export function evaluateLetterCompleteness(physical: PhysicalWordTraversalResult, visitation: readonly LetterVisitationConfidence[]): LetterCompletenessResult {
  const missing: string[] = [];
  physical.letters.forEach((letter, index) => {
    const visited = visitation[index]?.visited ?? false;
    if (!(letter.physicallyCovered && visited)) missing.push(letter.letter);
  });
  return { complete: missing.length === 0, missingLetters: missing };
}

// ---------------------------------------------------------------------------
// Shadow gates L1 / L2 / L3
// ---------------------------------------------------------------------------

export type LayeredGateInput = PhysicalLayerInput & {
  word: string;
  letterCompleteness: LetterCompletenessResult;
  sequence: SequenceIntegrityResult;
  wholeRouteOrder: number;
};

export type LayeredRuleName = PhysicalLayerRuleName | 'letterCompleteness' | 'sequenceIntegrity' | 'wholeRouteOrder';

/** Shadow L1: physical + completeness + sequence + order>=0.6 (existing threshold, UNCHANGED, kept as a hard gate). */
export function evaluateShadowL1(input: LayeredGateInput): { passes: boolean; reasons: LayeredRuleName[] } {
  const physical = evaluatePhysicalLayer(input);
  const reasons: LayeredRuleName[] = [...physical.reasons];
  if (isMultiLetter(input.word)) {
    if (!input.letterCompleteness.complete) reasons.push('letterCompleteness');
    if (!input.sequence.sequenceValid) reasons.push('sequenceIntegrity');
    if (input.wholeRouteOrder < EXPERIMENTAL_PRODUCT.minOrder) reasons.push('wholeRouteOrder');
  }
  return { passes: reasons.length === 0, reasons };
}

/** Shadow L2: physical + completeness + sequence — whole-route order reported but NOT gated on. */
export function evaluateShadowL2(input: LayeredGateInput): { passes: boolean; reasons: LayeredRuleName[] } {
  const physical = evaluatePhysicalLayer(input);
  const reasons: LayeredRuleName[] = [...physical.reasons];
  if (isMultiLetter(input.word)) {
    if (!input.letterCompleteness.complete) reasons.push('letterCompleteness');
    if (!input.sequence.sequenceValid) reasons.push('sequenceIntegrity');
  }
  return { passes: reasons.length === 0, reasons };
}

export type ShadowL3Classification = {
  physicalPass: boolean;
  completenessPass: boolean;
  sequencePass: boolean;
  wholeRouteOrder: number;
  /** A compact 4-dimensional label, e.g. "physical:PASS completeness:PASS sequence:PASS order:0.49" — never a single collapsed score, per the task's explicit "do not invent a new weighted score" instruction. */
  label: string;
};

/** Shadow L3: reports the four dimensions separately, gates on nothing new — purely observational, to see whether order still carries information once physical/completeness/sequence are independently known. */
export function classifyShadowL3(input: LayeredGateInput): ShadowL3Classification {
  const physicalPass = evaluatePhysicalLayer(input).passes;
  const completenessPass = isMultiLetter(input.word) ? input.letterCompleteness.complete : true;
  const sequencePass = isMultiLetter(input.word) ? input.sequence.sequenceValid : true;
  return {
    physicalPass,
    completenessPass,
    sequencePass,
    wholeRouteOrder: input.wholeRouteOrder,
    label: `physical:${physicalPass ? 'PASS' : 'FAIL'} completeness:${completenessPass ? 'PASS' : 'FAIL'} sequence:${sequencePass ? 'PASS' : 'FAIL'} order:${input.wholeRouteOrder.toFixed(3)}`,
  };
}
