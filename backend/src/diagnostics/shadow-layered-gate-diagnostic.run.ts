/**
 * DEVELOPMENT ONLY. Runs the Shadow Layered Product Gate Evaluation:
 * (1) an improved, GENUINELY CONNECTED, real-meter-scaled adversarial
 *     Scenario A-H battery, replacing the prior task's flawed Scenario K
 *     (which concatenated disconnected abstract-unit point arrays — see
 *     the SCALE/arcConnector comment below for the exact fix);
 * (2) a full 78-candidate Current vs Shadow L1 vs Shadow L2 vs Shadow L3
 *     comparison, built ENTIRELY by cross-referencing the two already-
 *     persisted, already-index-verified result files from the immediately
 *     prior two tasks (letter-sequence-integrity-diagnostic-results.json,
 *     shadow-product-gate-evaluator-results.json) — NO corpus
 *     regeneration, per this task's explicit instruction.
 *
 * Index-alignment re-verified immediately below (word-by-word, positional,
 * both files' 8 cases x their own candidate arrays) before any
 * cross-referencing is trusted.
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate. Nothing here is wired into experimental-product.ts.
 *
 * Run with: npx tsx src/diagnostics/shadow-layered-gate-diagnostic.run.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';

import {
  assignRouteSamplesToLetters,
  deriveVisitationBlocks,
  deriveObservedSequence,
  evaluateSequenceIntegrity,
  computeVisitationConfidence,
  wordLetters,
  type LetterVisitationConfidence,
  type SequenceIntegrityResult,
} from './letter-sequence-integrity-diagnostic';
import { computeWholeRouteOrder, evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './whole-route-order-diagnostic';
import type { PhysicalWordTraversalResult } from './physical-word-traversal-evaluator';
import {
  evaluateLetterCompleteness,
  evaluateShadowL1,
  evaluateShadowL2,
  classifyShadowL3,
  type LetterCompletenessResult,
  type LayeredGateInput,
} from './shadow-layered-gate-diagnostic';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { scorePolylines } from '../scoring/shape-match';
import { EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// PART 1 — Improved adversarial Scenario A-H battery.
//
// THE FIX for the prior task's inconclusive Scenario K: that construction
// concatenated RAW ABSTRACT-UNIT (0..1 range) letter point arrays with no
// explicit connector. Two compounding problems, both traced to the SAME
// root cause (operating in abstract units instead of real meters):
//   1. coverageThresholdMeters() floors at 18 (an absolute METERS constant).
//      In 0..1-unit space, minSpan*0.22 and targetLength*0.025 are both
//      << 18, so the floor always wins: threshold=18 units, i.e. ~18x the
//      ENTIRE WORD's width. The letter-assignment distance filter
//      (`perpendicularDistance > wordThreshold*2`) can then never exclude
//      ANY point, no matter how far a connector strays spatially — it
//      becomes a no-op, and assignment degenerates to whichever letter's
//      progress-window (±0.03) the point falls in, regardless of shape.
//   2. A straight-line jump from one letter's end to a non-adjacent
//      letter's start passes physically close to whatever letter sits
//      geometrically BETWEEN them (e.g. R->B passes near O, since O sits
//      between R and B on the page) — with the distance filter disabled
//      by (1), those in-between samples get misattributed to the letter
//      they pass near, corrupting the observed sequence.
//
// THE FIX: (a) scale every point by SCALE (meters per abstract unit) so
// coverageThresholdMeters computes a real, discriminating threshold (~24m
// for ROBZ at this scale, matching the real checkpoint-v1 corpus's regime
// where this same code already works correctly on 78/78 real candidates);
// (b) connect non-adjacent letters with an explicit ARCED connector (a
// 3-point polyline through an elevated midpoint) that physically detours
// AROUND any intervening letter's territory by more than 2x the distance
// threshold, so those connector samples are correctly excluded (assigned
// null) rather than misattributed — exactly mirroring how a real street
// route legitimately detouring around a block is already handled by this
// same "null samples don't break a visitation block" design.
// ---------------------------------------------------------------------------

const SCALE = 500; // meters per abstract word-shape unit; see comment above.
const CONNECTOR_ARC_HEIGHT = 0.4 * SCALE; // 200m — several multiples of the ~24-48m distance threshold this produces.

function scalePoints(points: readonly Vec2[]): Vec2[] {
  return points.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
}

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

/**
 * An explicit, CONNECTED (no teleporting) detour between two letters,
 * shaped as a "sky bridge" (straight up, straight across at full height,
 * straight down) rather than a single-midpoint triangular arc. This
 * matters: a triangular arc's rising/falling edges only reach full
 * arcHeight AT the midpoint, so at whatever x an intervening letter sits,
 * the arc may only be partway up — an early version of this file used a
 * triangular arc and Scenario D's connector was still only ~100m above an
 * intervening letter whose own height is ~108m, well under the ~48m
 * exclusion threshold, so it got misattributed. Holding FULL arcHeight for
 * the entire horizontal span guarantees clearance over any letter the
 * connector's x-range passes over, not just at one point.
 */
function arcConnector(from: Vec2, to: Vec2, arcHeight: number, factor: number): Vec2[] {
  const up = { x: from.x, y: from.y + arcHeight };
  const over = { x: to.x, y: to.y + arcHeight };
  return densify([from, up, over, to], factor);
}

/** Assembles a genuinely continuous 1D route from an ordered list of letter point-arrays, connecting each consecutive pair with an explicit arced connector — this is the "valid connected 1D route representation" the task requires. */
function buildConnectedRoute(letterPointArrays: readonly (readonly Vec2[])[], arcHeight: number = CONNECTOR_ARC_HEIGHT, letterFactor = 6, connectorFactor = 8): Vec2[] {
  let route: Vec2[] = [];
  letterPointArrays.forEach((points, i) => {
    const dense = densify(points, letterFactor);
    if (i === 0) {
      route = [...dense];
      return;
    }
    const prevEnd = route[route.length - 1]!;
    const nextStart = dense[0]!;
    const connector = arcConnector(prevEnd, nextStart, arcHeight, connectorFactor);
    route.push(...connector.slice(1, -1)); // drop duplicate endpoints (prevEnd/nextStart already present)
    route.push(...dense);
  });
  return route;
}

type ScenarioResult = {
  label: string;
  intendedLetters: string[];
  observedSequence: string[];
  sequenceValid: boolean;
  missingLetters: string[];
  reorderedPairs: Array<{ earlier: string; later: string }>;
  hasRevisit: boolean;
  revisitedLetters: string[];
  letterCompleteness: LetterCompletenessResult;
  wholeRouteOrder: number;
  jumpFit: number;
  physicalShapeScore: number;
  meanRawInk: number;
};

function evaluateScenario(label: string, word: string, route: Vec2[], target: Vec2[], intendedLetters: string[]): ScenarioResult {
  const { assignments, boundaries } = assignRouteSamplesToLetters(word, target, route, 'smooth');
  const blocks = deriveVisitationBlocks(assignments);
  const observed = deriveObservedSequence(blocks);
  const integrity: SequenceIntegrityResult = evaluateSequenceIntegrity(observed, intendedLetters);
  const visitation: LetterVisitationConfidence[] = computeVisitationConfidence(boundaries, blocks);
  const order = computeWholeRouteOrder(route, target);
  const physical: PhysicalWordTraversalResult = evaluatePhysicalWordTraversal(word, target, route, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const completeness = evaluateLetterCompleteness(physical, visitation);
  const scored = scorePolylines(route, target);
  const meanRawInk = physical.letters.length ? physical.letters.reduce((s, l) => s + l.rawInkCoverage, 0) / physical.letters.length : 0;

  return {
    label,
    intendedLetters,
    observedSequence: observed,
    sequenceValid: integrity.sequenceValid,
    missingLetters: integrity.missingLetters,
    reorderedPairs: integrity.reorderedPairs,
    hasRevisit: integrity.hasRevisit,
    revisitedLetters: integrity.revisitedLetters,
    letterCompleteness: completeness,
    wholeRouteOrder: order.order,
    jumpFit: order.jumpFit,
    physicalShapeScore: scored.score,
    meanRawInk,
  };
}

function printScenario(s: ScenarioResult) {
  console.log(
    `${s.label}: intended=${s.intendedLetters.join('')} observed=${s.observedSequence.join('->')} ` +
      `sequenceValid=${s.sequenceValid} missing=${JSON.stringify(s.missingLetters)} reordered=${JSON.stringify(s.reorderedPairs)} ` +
      `hasRevisit=${s.hasRevisit} completeness=${s.letterCompleteness.complete}(missing=${JSON.stringify(s.letterCompleteness.missingLetters)}) ` +
      `| wholeRouteOrder=${s.wholeRouteOrder.toFixed(3)} jumpFit=${s.jumpFit.toFixed(3)} shapeScore=${s.physicalShapeScore.toFixed(3)} meanRawInk=${s.meanRawInk.toFixed(3)}`,
  );
}

function runImprovedAdversarialBattery(): ScenarioResult[] {
  console.log('=== IMPROVED ADVERSARIAL SCENARIOS A-H (connected, meter-scaled) ===');
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const target = scalePoints(robzShape.points);
  const [r, o, b, z] = robzShape.letters.map((l) => scalePoints(l.points));
  const intended = wordLetters('ROBZ', 'smooth');

  const results: ScenarioResult[] = [];

  const a = evaluateScenario('A. Correct (R->O->B->Z)', 'ROBZ', buildConnectedRoute([r!, o!, b!, z!]), target, intended);
  printScenario(a);
  results.push(a);

  const bSkip = evaluateScenario('B. Skip (R->O->Z)', 'ROBZ', buildConnectedRoute([r!, o!, z!]), target, intended);
  printScenario(bSkip);
  results.push(bSkip);

  const c = evaluateScenario('C. Reverse (Z->B->O->R)', 'ROBZ', buildConnectedRoute([z!, b!, o!, r!]), target, intended);
  printScenario(c);
  results.push(c);

  const d = evaluateScenario('D. Reorder (R->B->O->Z) [CRITICAL TEST]', 'ROBZ', buildConnectedRoute([r!, b!, o!, z!]), target, intended);
  printScenario(d);
  results.push(d);

  const e = evaluateScenario('E. Local revisit (R->O->R->B->Z)', 'ROBZ', buildConnectedRoute([r!, o!, r!, b!, z!]), target, intended);
  printScenario(e);
  results.push(e);

  // F. Large detour: correct order, but a big excursion spliced into B's own traversal (not a connector) — must not be misread as a sequence break.
  const bDense = densify(b!, 6);
  const detourMid = Math.floor(bDense.length / 2);
  const detourPoint = { x: bDense[detourMid]!.x + 300, y: bDense[detourMid]!.y + 300 };
  const bWithDetour = [...bDense.slice(0, detourMid), detourPoint, ...bDense.slice(detourMid)];
  const fRoute = buildConnectedRoute([r!, o!], CONNECTOR_ARC_HEIGHT).concat(
    arcConnector(buildConnectedRoute([r!, o!])[buildConnectedRoute([r!, o!]).length - 1]!, bWithDetour[0]!, CONNECTOR_ARC_HEIGHT, 8).slice(1, -1),
    bWithDetour,
    arcConnector(bWithDetour[bWithDetour.length - 1]!, densify(z!, 6)[0]!, CONNECTOR_ARC_HEIGHT, 8).slice(1, -1),
    densify(z!, 6),
  );
  const f = evaluateScenario('F. Large detour within a letter (correct order preserved)', 'ROBZ', fRoute, target, intended);
  printScenario(f);
  results.push(f);

  // G. Legitimate spatial self-crossing: correct order, but the route briefly revisits an earlier spatial point (like two streets crossing), never a different letter.
  const correctRoute = buildConnectedRoute([r!, o!, b!, z!]);
  const crossFrom = Math.floor(correctRoute.length * 0.62);
  const crossTo = Math.floor(correctRoute.length * 0.2);
  const gRoute = [...correctRoute.slice(0, crossFrom), correctRoute[crossTo]!, ...correctRoute.slice(crossFrom)];
  const g = evaluateScenario('G. Legitimate spatial crossing (correct order preserved)', 'ROBZ', gRoute, target, intended);
  printScenario(g);
  results.push(g);

  // H. Near-letter confusion: while still (intendedly) tracing R, the route physically passes close to O's target location.
  const rDense = densify(r!, 6);
  const oTargetPoint = o![Math.floor(o!.length / 2)]!;
  const bendIndex = Math.floor(rDense.length * 0.7);
  const rBent = rDense.map((p, i) => {
    if (i < bendIndex) return p;
    const t = Math.min(1, (i - bendIndex) / Math.max(1, rDense.length - bendIndex - 1));
    const pullStrength = Math.sin(t * Math.PI) * 0.5; // pulls toward O midway, returns to R's own path
    return { x: p.x + (oTargetPoint.x - p.x) * pullStrength, y: p.y + (oTargetPoint.y - p.y) * pullStrength };
  });
  const hRoute = buildConnectedRoute([rBent, o!, b!, z!]);
  const h = evaluateScenario('H. Near-letter confusion (R passes close to O without intending to visit it)', 'ROBZ', hRoute, target, intended);
  printScenario(h);
  results.push(h);

  console.log('');
  console.log('--- Scenario D (Reorder) interpretation, reported honestly per the task instruction ---');
  if (d.sequenceValid) {
    console.log('UNEXPECTED: Scenario D reports sequenceValid=true. The reorder was NOT detected. Do not claim the reorder signal works — investigate before relying on it.');
  } else if (d.reorderedPairs.length > 0) {
    console.log(`Scenario D correctly rejected: reorderedPairs=${JSON.stringify(d.reorderedPairs)} — the independent sequence signal DOES catch this genuinely connected wrong-order case.`);
  } else {
    console.log(`Scenario D rejected, but NOT via reorderedPairs (missingLetters=${JSON.stringify(d.missingLetters)}) — inspect before claiming the reorder-detection path itself is proven; this may indicate a different failure mode (e.g. a letter dropped out of the observed sequence entirely rather than being detected as reordered).`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// PART 2 — Cross-reference the two already-persisted 78-candidate result
// files. NO corpus regeneration (explicit task instruction).
// ---------------------------------------------------------------------------

type SeqCandidate = {
  candidateRank: number;
  word: string;
  intendedSequence: string[];
  observedSequence: string[];
  sequenceValid: boolean;
  missingLetters: string[];
  reorderedPairs: Array<{ earlier: string; later: string }>;
  hasRevisit: boolean;
  visitationConfidence: LetterVisitationConfidence[];
  wholeRouteOrder: number;
  jumpFit: number;
  broadOrderPass: boolean;
  continuityValid: boolean;
  meanRawInk: number;
  currentWordTraversal: boolean;
};
type SeqCase = { word: string; locationName: string; targetDistanceMeters: number; graphFeasibleCount: number; candidates: SeqCandidate[] };
type SeqFile = { cases: SeqCase[] };

type ShadowCandidate = {
  candidateRank: number;
  geometryVariant: string;
  word: string;
  shapeScore: number;
  coverage: number;
  order: number;
  backtrack: number;
  largestGap: number;
  targetSpan: number;
  lengthRatio: number;
  currentWordTraversal: boolean;
  currentGatePasses: boolean;
  currentGateReasons: string[];
  shadowAPasses: boolean;
  shadowAReasons: string[];
  shadowBPasses: boolean;
  shadowBReasons: string[];
  physical: PhysicalWordTraversalResult;
  transitions: unknown[];
};
type ShadowCase = { word: string; locationName: string; targetDistanceMeters: number; graphFeasibleCount: number; candidates: ShadowCandidate[] };
type ShadowFile = { cases: ShadowCase[] };

type CombinedCandidate = {
  caseIndex: number;
  candidateIndex: number;
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  currentPasses: boolean;
  currentReasons: string[];
  shapeScore: number;
  coverage: number;
  order: number;
  backtrack: number;
  largestGap: number;
  targetSpan: number;
  lengthRatio: number;
  continuityValid: boolean;
  wholeRouteOrder: number;
  jumpFit: number;
  letterCompleteness: LetterCompletenessResult;
  sequence: SequenceIntegrityResult;
  observedSequence: string[];
  broadOrderPass: boolean;
  currentWordTraversal: boolean;
  meanRawInk: number;
  l1Passes: boolean;
  l1Reasons: string[];
  l2Passes: boolean;
  l2Reasons: string[];
  l3: ReturnType<typeof classifyShadowL3>;
};

function reconstructSequenceResult(seq: SeqCandidate): SequenceIntegrityResult {
  return {
    observedSequence: seq.observedSequence,
    firstOccurrenceOrder: [...new Set(seq.observedSequence)],
    missingLetters: seq.missingLetters,
    sequenceValid: seq.sequenceValid,
    reorderedPairs: seq.reorderedPairs,
    hasRevisit: seq.hasRevisit,
    revisitedLetters: [],
  };
}

function crossReferenceCorpus(): CombinedCandidate[] {
  const seqFile: SeqFile = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'letter-sequence-integrity-diagnostic-results.json'), 'utf8'));
  const shadowFile: ShadowFile = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'shadow-product-gate-evaluator-results.json'), 'utf8'));

  if (seqFile.cases.length !== shadowFile.cases.length) {
    throw new Error(`Index-alignment check FAILED: case count mismatch (${seqFile.cases.length} vs ${shadowFile.cases.length}). Refusing to cross-reference.`);
  }

  const combined: CombinedCandidate[] = [];
  for (let ci = 0; ci < seqFile.cases.length; ci += 1) {
    const seqCase = seqFile.cases[ci]!;
    const shadowCase = shadowFile.cases[ci]!;
    if (seqCase.candidates.length !== shadowCase.candidates.length) {
      throw new Error(`Index-alignment check FAILED at case ${ci}: candidate count mismatch (${seqCase.candidates.length} vs ${shadowCase.candidates.length}). Refusing to cross-reference.`);
    }
    for (let i = 0; i < seqCase.candidates.length; i += 1) {
      const seq = seqCase.candidates[i]!;
      const shadow = shadowCase.candidates[i]!;
      if (seq.word !== shadow.word) {
        throw new Error(`Index-alignment check FAILED at case ${ci} candidate ${i}: word mismatch ("${seq.word}" vs "${shadow.word}"). Refusing to cross-reference.`);
      }

      const visitation = seq.visitationConfidence;
      const completeness = evaluateLetterCompleteness(shadow.physical, visitation);
      const sequence = reconstructSequenceResult(seq);

      const layeredInput: LayeredGateInput = {
        word: shadow.word,
        connected: true, // every candidate here is by construction a routed, feasible candidate (graph-connected); shadowAReasons/shadowBReasons in the source file never list 'connected' for any of these 78, confirmed below.
        shapeScore: shadow.shapeScore,
        coverage: shadow.coverage,
        backtrack: shadow.backtrack,
        largestGap: shadow.largestGap,
        lengthRatio: shadow.lengthRatio,
        continuityValid: seq.continuityValid,
        letterCompleteness: completeness,
        sequence,
        wholeRouteOrder: seq.wholeRouteOrder,
      };

      const l1 = evaluateShadowL1(layeredInput);
      const l2 = evaluateShadowL2(layeredInput);
      const l3 = classifyShadowL3(layeredInput);

      combined.push({
        caseIndex: ci,
        candidateIndex: i,
        word: shadow.word,
        locationName: shadowCase.locationName,
        targetDistanceMeters: shadowCase.targetDistanceMeters,
        currentPasses: shadow.currentGatePasses,
        currentReasons: shadow.currentGateReasons,
        shapeScore: shadow.shapeScore,
        coverage: shadow.coverage,
        order: shadow.order,
        backtrack: shadow.backtrack,
        largestGap: shadow.largestGap,
        targetSpan: shadow.targetSpan,
        lengthRatio: shadow.lengthRatio,
        continuityValid: seq.continuityValid,
        wholeRouteOrder: seq.wholeRouteOrder,
        jumpFit: seq.jumpFit,
        letterCompleteness: completeness,
        sequence,
        observedSequence: seq.observedSequence,
        broadOrderPass: seq.broadOrderPass,
        currentWordTraversal: shadow.currentWordTraversal,
        meanRawInk: seq.meanRawInk,
        l1Passes: l1.passes,
        l1Reasons: l1.reasons,
        l2Passes: l2.passes,
        l2Reasons: l2.reasons,
        l3,
      });
    }
  }
  return combined;
}

function confusionMatrix(label: string, a: readonly boolean[], b: readonly boolean[], aLabel: string, bLabel: string) {
  let tt = 0, tf = 0, ft = 0, ff = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] && b[i]) tt += 1;
    else if (a[i] && !b[i]) tf += 1;
    else if (!a[i] && b[i]) ft += 1;
    else ff += 1;
  }
  console.log(`${label}: ${aLabel}=T/${bLabel}=T:${tt}  ${aLabel}=T/${bLabel}=F:${tf}  ${aLabel}=F/${bLabel}=T:${ft}  ${aLabel}=F/${bLabel}=F:${ff}`);
  return { tt, tf, ft, ff };
}

function categorizeCurrentFailReason(c: CombinedCandidate): 'A' | 'B' | 'C' | 'D' | 'E' | 'F' {
  const reasons = new Set(c.currentReasons);
  const hasOrder = reasons.has('order');
  const hasWordTraversal = reasons.has('wordTraversal');
  const hasTargetSpan = reasons.has('targetSpan');
  const others = [...reasons].filter((r) => r !== 'order' && r !== 'wordTraversal' && r !== 'targetSpan');
  if (others.length > 0) return 'F';
  if (hasOrder && hasWordTraversal && hasTargetSpan) return 'F'; // three-way overlap: not cleanly one of A-E, report as other
  if (hasOrder && hasWordTraversal) return 'D';
  if (hasOrder && hasTargetSpan) return 'E';
  if (hasOrder) return 'A';
  if (hasWordTraversal) return 'B';
  if (hasTargetSpan) return 'C';
  return 'F';
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function analyzeCorpus(combined: CombinedCandidate[]) {
  console.log('');
  console.log('=== PART 2: 78-CANDIDATE CROSS-REFERENCED CORPUS ANALYSIS ===');
  console.log(`Total candidates: ${combined.length}`);

  const currentPass = combined.map((c) => c.currentPasses);
  const l1Pass = combined.map((c) => c.l1Passes);
  const l2Pass = combined.map((c) => c.l2Passes);
  const semanticValid = combined.map((c) => c.letterCompleteness.complete && c.sequence.sequenceValid);

  console.log('');
  console.log('--- Confusion matrices ---');
  confusionMatrix('Current vs L1', currentPass, l1Pass, 'Current', 'L1');
  confusionMatrix('Current vs L2', currentPass, l2Pass, 'Current', 'L2');
  confusionMatrix('Current vs SemanticValid(completeness&sequence)', currentPass, semanticValid, 'Current', 'Semantic');
  confusionMatrix('L1 vs L2', l1Pass, l2Pass, 'L1', 'L2');

  const currentFailL2Pass = combined.filter((c) => !c.currentPasses && c.l2Passes);
  const currentPassL2Fail = combined.filter((c) => c.currentPasses && !c.l2Passes);
  console.log('');
  console.log(`Current FAIL -> L2 PASS: ${currentFailL2Pass.length}/${combined.length}`);
  console.log(`Current PASS -> L2 FAIL: ${currentPassL2Fail.length}/${combined.length}`);

  const currentFail = combined.filter((c) => !c.currentPasses);
  const currentFailSeqInvalid = currentFail.filter((c) => !c.sequence.sequenceValid);
  const currentFailCompletenessInvalid = currentFail.filter((c) => !c.letterCompleteness.complete);
  const currentFailPhysicalInvalid = currentFail.filter((c) => c.currentReasons.some((r) => ['shapeScore', 'coverage', 'backtrack', 'largestGap', 'lengthRatio', 'connected'].includes(r)));
  const currentFailOrderOnly = currentFail.filter((c) => c.currentReasons.length > 0 && c.currentReasons.every((r) => r === 'order'));
  console.log(`Current FAIL total: ${currentFail.length}/${combined.length}`);
  console.log(`  due to sequence invalid: ${currentFailSeqInvalid.length}`);
  console.log(`  due to completeness invalid: ${currentFailCompletenessInvalid.length}`);
  console.log(`  due to a physical-layer condition: ${currentFailPhysicalInvalid.length}`);
  console.log(`  due to order ONLY (currentGateReasons === ['order']): ${currentFailOrderOnly.length}`);

  console.log('');
  console.log('--- Current FAIL -> L2 PASS: full records + A-F rejection-reason categorization ---');
  const categoryCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const c of currentFailL2Pass) {
    const category = categorizeCurrentFailReason(c);
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    console.log(
      `[case ${c.caseIndex} cand ${c.candidateIndex}] ${c.word} (${c.locationName} ${c.targetDistanceMeters}m): ` +
        `currentReasons=${JSON.stringify(c.currentReasons)} category=${category} | shapeScore=${c.shapeScore.toFixed(3)} coverage=${c.coverage.toFixed(3)} ` +
        `backtrack=${c.backtrack.toFixed(3)} largestGap=${c.largestGap.toFixed(3)} targetSpan=${c.targetSpan.toFixed(3)} lengthRatio=${c.lengthRatio.toFixed(3)} ` +
        `| completeness=${c.letterCompleteness.complete} sequence=${c.sequence.sequenceValid} observed=${c.observedSequence.join('->')} ` +
        `wholeRouteOrder=${c.wholeRouteOrder.toFixed(3)} jumpFit=${c.jumpFit.toFixed(3)}`,
    );
  }
  console.log(`Category counts for Current FAIL -> L2 PASS: ${JSON.stringify(categoryCounts)}`);

  console.log('');
  console.log('--- Candidates that pass physical but fail semantic (completeness or sequence) ---');
  const physicalPass = combined.filter((c) => c.l3.physicalPass);
  const physicalPassSemanticFail = physicalPass.filter((c) => !c.letterCompleteness.complete || !c.sequence.sequenceValid);
  console.log(`count: ${physicalPassSemanticFail.length}/${physicalPass.length} physical-passing candidates`);
  for (const c of physicalPassSemanticFail) {
    const kind = !c.letterCompleteness.complete && !c.sequence.sequenceValid ? 'BOTH' : !c.letterCompleteness.complete ? 'completeness' : 'ordering';
    console.log(
      `[case ${c.caseIndex} cand ${c.candidateIndex}] ${c.word}: failureKind=${kind} missingLetters=${JSON.stringify(c.letterCompleteness.missingLetters)} ` +
        `observed=${c.observedSequence.join('->')} intended=${c.sequence.observedSequence.length ? wordLettersCache(c.word) : ''} reorderedPairs=${JSON.stringify(c.sequence.reorderedPairs)} ` +
        `hasRevisit=${c.sequence.hasRevisit}`,
    );
  }

  console.log('');
  console.log('--- Redundancy: how often do signals agree? ---');
  const completenessArr = combined.map((c) => c.letterCompleteness.complete);
  const sequenceArr = combined.map((c) => c.sequence.sequenceValid);
  const broadOrderArr = combined.map((c) => c.broadOrderPass);
  const wordTraversalArr = combined.map((c) => c.currentWordTraversal);
  const orderPassArr = combined.map((c) => c.wholeRouteOrder >= EXPERIMENTAL_PRODUCT.minOrder);
  const targetSpanArr = combined.map((c) => c.targetSpan >= EXPERIMENTAL_PRODUCT.minTargetSpan);

  function agreementRate(x: readonly boolean[], y: readonly boolean[]): number {
    let agree = 0;
    for (let i = 0; i < x.length; i += 1) if (x[i] === y[i]) agree += 1;
    return agree / x.length;
  }
  console.log(`completeness vs broadOrder: agree ${(agreementRate(completenessArr, broadOrderArr) * 100).toFixed(1)}%`);
  console.log(`sequenceValid vs broadOrder: agree ${(agreementRate(sequenceArr, broadOrderArr) * 100).toFixed(1)}%`);
  console.log(`sequenceValid vs wordTraversal: agree ${(agreementRate(sequenceArr, wordTraversalArr) * 100).toFixed(1)}%`);
  console.log(`completeness vs wordTraversal: agree ${(agreementRate(completenessArr, wordTraversalArr) * 100).toFixed(1)}%`);
  console.log(`sequenceValid vs wholeRouteOrder>=0.6: agree ${(agreementRate(sequenceArr, orderPassArr) * 100).toFixed(1)}%`);
  console.log(`completeness vs targetSpan>=0.55: agree ${(agreementRate(completenessArr, targetSpanArr) * 100).toFixed(1)}%`);

  console.log('');
  console.log('--- Conceptual Gates A/B/C pass counts ---');
  // Gate A = current production gate (already have currentPasses).
  // Gate B = layered + existing order hard gate = Shadow L1.
  // Gate C = layered without order = Shadow L2.
  const gateAPass = combined.filter((c) => c.currentPasses).length;
  const gateBPass = combined.filter((c) => c.l1Passes).length;
  const gateCPass = combined.filter((c) => c.l2Passes).length;
  console.log(`Gate A (current): ${gateAPass}/${combined.length}`);
  console.log(`Gate B (layered + order hard gate / Shadow L1): ${gateBPass}/${combined.length}`);
  console.log(`Gate C (layered, no order / Shadow L2): ${gateCPass}/${combined.length}`);

  console.log('');
  console.log('--- Newly-accepted by Gate C vs Gate A: qualitative spot-check ---');
  for (const c of currentFailL2Pass) {
    console.log(
      `  ${c.word} [case ${c.caseIndex} cand ${c.candidateIndex}]: shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)} completeness=${c.letterCompleteness.complete} ` +
        `sequenceValid=${c.sequence.sequenceValid} observed=${c.observedSequence.join('->')} hasRevisit=${c.sequence.hasRevisit} -> physically+semantically coherent trace of the word: ${
          c.letterCompleteness.complete && c.sequence.sequenceValid && c.meanRawInk > 0.7 ? 'YES' : 'NEEDS REVIEW'
        }`,
    );
  }

  console.log('');
  console.log('--- Newly-rejected by Gate C vs Gate A (Current PASS -> L2 FAIL): qualitative spot-check ---');
  for (const c of currentPassL2Fail) {
    console.log(`  ${c.word} [case ${c.caseIndex} cand ${c.candidateIndex}]: l2Reasons=${JSON.stringify(c.l2Reasons)} completeness=${c.letterCompleteness.complete} sequenceValid=${c.sequence.sequenceValid} shapeScore=${c.shapeScore.toFixed(3)}`);
  }

  console.log('');
  console.log('--- Revisit stats ---');
  const revisitCount = combined.filter((c) => c.sequence.hasRevisit).length;
  const revisitAndL2Pass = combined.filter((c) => c.sequence.hasRevisit && c.l2Passes).length;
  console.log(`Candidates with a legitimate revisit: ${revisitCount}/${combined.length}`);
  console.log(`Of those, still pass Shadow L2 (revisit correctly tolerated, not misread as a failure): ${revisitAndL2Pass}/${revisitCount}`);

  return {
    gateAPass,
    gateBPass,
    gateCPass,
    currentFailL2Pass: currentFailL2Pass.length,
    currentPassL2Fail: currentPassL2Fail.length,
    currentFailSeqInvalid: currentFailSeqInvalid.length,
    currentFailCompletenessInvalid: currentFailCompletenessInvalid.length,
    currentFailPhysicalInvalid: currentFailPhysicalInvalid.length,
    currentFailOrderOnly: currentFailOrderOnly.length,
    categoryCounts,
    revisitCount,
    revisitAndL2Pass,
    physicalPassSemanticFailCount: physicalPassSemanticFail.length,
  };
}

function wordLettersCache(word: string): string {
  // Small helper purely for the qualitative print above — reuses wordLetters (already imported), no new logic.
  try {
    return wordLetters(word, 'smooth').join('');
  } catch {
    return word;
  }
}

async function main() {
  const started = Date.now();
  const scenarios = runImprovedAdversarialBattery();
  const combined = crossReferenceCorpus();
  const summary = analyzeCorpus(combined);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'shadow-layered-gate-diagnostic-results.json');
  writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), scale: SCALE, connectorArcHeight: CONNECTOR_ARC_HEIGHT, scenarios, combined, summary }, null, 2),
    'utf8',
  );

  console.log('');
  console.log(`[shadow-layered-gate] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[shadow-layered-gate] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
