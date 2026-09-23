/**
 * DEVELOPMENT ONLY. Shadow product-gate evaluator — diagnostic only,
 * never called from the live route-generation/scoring/gate path, never
 * wired into experimental-product.ts.
 *
 * Answers: if the existing product gate's `wordTraversal` condition (and,
 * in one variant, `targetSpan` too) were replaced by the new physical
 * word-traversal evaluator + lightweight inter-letter continuity, what
 * would actually change?
 *
 * Reuses, unmodified: EXPERIMENTAL_PRODUCT (experimental-product.ts) — the
 * REAL threshold constants, imported read-only, never redefined here.
 * Every OTHER condition (shapeScore, coverage, order, backtrack,
 * largestGap, connected, lengthRatio) is reproduced using those SAME
 * constants and the SAME comparison operators as the real
 * experimentalProductRejectionReasons() — this file does not invent any
 * new threshold for those. The only new logic is which SOURCE feeds the
 * word-traversal-shaped condition:
 *
 *   Shadow A — surgical substitution: replace only wordTraversal with
 *     physicalWordTraversal (physical coverage + broad sequence +
 *     continuity). targetSpan stays exactly as production checks it.
 *   Shadow B — physical evaluator experiment: replace BOTH wordTraversal
 *     AND targetSpan with physicalWordTraversal + continuity. Every other
 *     constraint (shapeScore/coverage/order/backtrack/largestGap/
 *     lengthRatio/connected) is untouched.
 */
import { EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';
import type { PhysicalWordTraversalResult } from './physical-word-traversal-evaluator';
import type { TransitionRecord } from './inter-letter-continuity-diagnostic';

export const SHADOW_CONTINUITY_DEFAULTS = {
  maxInterLetterRouteRatio: 15,
} as const;

export type ContinuityEvaluation = {
  continuityValid: boolean;
  hasDisconnectedTransition: boolean;
  maxRatio: number | null;
  worstTransition: { fromLetter: string; toLetter: string; ratio: number } | null;
};

/** Rejects only null/disconnected transitions and extreme route/straight-line outliers above the threshold — never a normal street-network detour, per this task's explicit design. */
export function evaluateContinuity(transitions: readonly TransitionRecord[], maxRatio: number = SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio): ContinuityEvaluation {
  const hasDisconnectedTransition = transitions.some((t) => t.routeDistance === null || t.straightLineDistance === null);
  const ratios = transitions.map((t) => t.routeToStraightRatio).filter((r): r is number => r !== null && Number.isFinite(r));
  const worst = ratios.length ? Math.max(...ratios) : null;
  const worstTransition = worst === null ? null : (() => {
    const found = transitions.find((t) => t.routeToStraightRatio === worst);
    return found ? { fromLetter: found.fromLetter, toLetter: found.toLetter, ratio: worst } : null;
  })();
  const continuityValid = !hasDisconnectedTransition && (worst === null || worst <= maxRatio);
  return { continuityValid, hasDisconnectedTransition, maxRatio: worst, worstTransition };
}

export type ShadowGateInput = {
  word: string;
  connected: boolean;
  shapeScore: number;
  coverage: number;
  order: number;
  backtrack: number;
  largestGap: number;
  targetSpan: number;
  lengthRatio: number;
  currentWordTraversal: boolean;
  physical: PhysicalWordTraversalResult;
  transitions: readonly TransitionRecord[];
};

export type ShadowRuleName =
  | 'connected'
  | 'shapeScore'
  | 'coverage'
  | 'order'
  | 'backtrack'
  | 'largestGap'
  | 'targetSpan'
  | 'lengthRatio'
  | 'wordTraversal'
  | 'physicalWordTraversal'
  | 'continuity';

function isMultiLetter(word: string): boolean {
  return word.replace(/[^A-Za-z]/g, '').length > 1;
}

/** Reproduces every EXISTING production rule (same EXPERIMENTAL_PRODUCT constants, same comparisons) EXCEPT wordTraversal, which is fed by the real, unmodified experimentalProductRejectionReasons()'s own result — i.e. this function is only ever called to COMPARE against the current gate, not to replace it; see evaluateShadowGateA/B below for the actual substitutions. */
export function baseRejectionReasons(input: ShadowGateInput): ShadowRuleName[] {
  const reasons: ShadowRuleName[] = [];
  if (!input.connected) reasons.push('connected');
  if (input.shapeScore < EXPERIMENTAL_PRODUCT.minShapeScore) reasons.push('shapeScore');
  if (input.coverage < EXPERIMENTAL_PRODUCT.minCoverage) reasons.push('coverage');
  if (input.order < EXPERIMENTAL_PRODUCT.minOrder) reasons.push('order');
  if (input.backtrack > EXPERIMENTAL_PRODUCT.maxBacktrack) reasons.push('backtrack');
  if (input.largestGap > EXPERIMENTAL_PRODUCT.maxLargestGap) reasons.push('largestGap');
  if (input.lengthRatio < EXPERIMENTAL_PRODUCT.minLengthRatio) reasons.push('lengthRatio');
  return reasons;
}

/** Shadow Gate A — surgical substitution: only wordTraversal is replaced by physicalWordTraversal; targetSpan (and every other constraint) stays exactly as production checks it. Single-letter words: physical evaluator's own letter-count handling already makes physicalWordTraversal trivially about the one letter, matching how the real gate's wordTraversal check is skipped entirely for single-letter words (see isMultiLetter below) — so for single letters this shadow gate reduces to identical behavior to the real gate, by construction, not by a special case added here. */
export function evaluateShadowGateA(input: ShadowGateInput): { passes: boolean; reasons: ShadowRuleName[] } {
  const reasons = baseRejectionReasons(input);
  if (input.targetSpan < EXPERIMENTAL_PRODUCT.minTargetSpan) reasons.push('targetSpan');
  if (isMultiLetter(input.word) && !input.physical.wordTraversalPhysical) reasons.push('physicalWordTraversal');
  return { passes: reasons.length === 0, reasons };
}

/** Shadow Gate B — physical evaluator experiment: targetSpan is DROPPED entirely; wordTraversal is replaced by physicalWordTraversal + continuity. Every other constraint is unchanged. */
export function evaluateShadowGateB(input: ShadowGateInput, continuityThreshold: number = SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio): { passes: boolean; reasons: ShadowRuleName[]; continuity: ContinuityEvaluation } {
  const reasons = baseRejectionReasons(input);
  const continuity = evaluateContinuity(input.transitions, continuityThreshold);
  if (isMultiLetter(input.word)) {
    if (!input.physical.wordTraversalPhysical) reasons.push('physicalWordTraversal');
    if (!continuity.continuityValid) reasons.push('continuity');
  }
  return { passes: reasons.length === 0, reasons, continuity };
}
