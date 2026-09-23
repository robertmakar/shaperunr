/**
 * DEVELOPMENT ONLY. Runs the Recalibrated Whole-Route Order Under
 * Semantic Guardrails diagnostic.
 *
 * Two parts:
 *  (1) the validated connected adversarial battery from the prior task
 *      (Scenarios A-H, reused unmodified in construction), extended with
 *      I-M per this task's spec;
 *  (2) a full regeneration of the exact same deterministic 8-case/
 *      78-candidate corpus used by every prior task in this chain (same
 *      MULTI_LETTER_CASES, proven byte-identical across repeated runs),
 *      because order recalibration needs raw route/target geometry that
 *      is not present in any previously-persisted result JSON — this is
 *      the one part of this task that cannot be done by cross-referencing
 *      alone. Regenerated candidateRank/word sequences are checked for
 *      consistency against the immediately-prior task's persisted results
 *      as a sanity check.
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate. scoreOrderedPath() itself is never touched; see
 * recalibrated-order-diagnostic.ts's header for the wrapper design.
 *
 * Run with: npx tsx src/diagnostics/recalibrated-order-diagnostic.run.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import {
  assignRouteSamplesToLetters,
  deriveVisitationBlocks,
  deriveObservedSequence,
  evaluateSequenceIntegrity,
  computeVisitationConfidence,
  wordLetters,
  type SequenceIntegrityResult,
} from './letter-sequence-integrity-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './whole-route-order-diagnostic';
import { evaluateLetterCompleteness, evaluatePhysicalLayer, type LetterCompletenessResult } from './shadow-layered-gate-diagnostic';
import { computeRecalibratedOrderModels, RECALIBRATION_MODEL_KEYS, type RecalibrationModelKey, type RecalibratedOrderResult } from './recalibrated-order-diagnostic';
import { evaluateContinuity, SHADOW_CONTINUITY_DEFAULTS } from './shadow-product-gate-evaluator';
import { extractLetterRouteSpans, computeTransitionRecord, type TransitionRecord } from './inter-letter-continuity-diagnostic';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { scorePolylines } from '../scoring/shape-match';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import { runExperimentalPipelineMultiVariant, type ExperimentalPipelineReport, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// PART 0 — connected-route construction helpers. IDENTICAL to the prior
// task's (shadow-layered-gate-diagnostic.run.ts) validated, meter-scaled,
// sky-bridge-connector battery construction — duplicated here rather than
// imported (run scripts are not modules other run scripts import from,
// per this session's established convention), not redesigned.
// ---------------------------------------------------------------------------

const SCALE = 500;
const CONNECTOR_ARC_HEIGHT = 0.4 * SCALE;

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

function arcConnector(from: Vec2, to: Vec2, arcHeight: number, factor: number): Vec2[] {
  const up = { x: from.x, y: from.y + arcHeight };
  const over = { x: to.x, y: to.y + arcHeight };
  return densify([from, up, over, to], factor);
}

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
    route.push(...connector.slice(1, -1));
    route.push(...dense);
  });
  return route;
}

/** Reverses direction within each letter's own traversal N times (there-and-back), WITHOUT ever leaving that letter's own point range — tests trajectory fidelity (monotonicFit/jumpFit) independent of semantic sequence, since the observed LETTER sequence is unaffected by oscillating within one letter's own span. */
function zigzagWithinLetter(points: readonly Vec2[], repeats: number): Vec2[] {
  const dense = densify(points, 6);
  const out: Vec2[] = [...dense];
  for (let r = 0; r < repeats; r += 1) {
    const backward = [...dense].reverse();
    const forward = [...dense];
    out.push(...backward.slice(1), ...forward.slice(1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// PART 1 — adversarial battery A-M, evaluated under every recalibration model.
// ---------------------------------------------------------------------------

type ScenarioResult = {
  label: string;
  intendedLetters: string[];
  observedSequence: string[];
  sequenceValid: boolean;
  completeness: boolean;
  semanticValid: boolean;
  physicalPass: boolean;
  shapeScore: number;
  meanRawInk: number;
  models: Record<RecalibrationModelKey, RecalibratedOrderResult>;
};

function evaluateScenario(label: string, word: string, route: Vec2[], target: Vec2[], intendedLetters: string[]): ScenarioResult {
  const { assignments, boundaries } = assignRouteSamplesToLetters(word, target, route, 'smooth');
  const blocks = deriveVisitationBlocks(assignments);
  const observed = deriveObservedSequence(blocks);
  const integrity: SequenceIntegrityResult = evaluateSequenceIntegrity(observed, intendedLetters);
  const visitation = computeVisitationConfidence(boundaries, blocks);
  const physical = evaluatePhysicalWordTraversal(word, target, route, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const completeness = evaluateLetterCompleteness(physical, visitation);
  const scored = scorePolylines(route, target);
  const meanRawInk = physical.letters.length ? physical.letters.reduce((s, l) => s + l.rawInkCoverage, 0) / physical.letters.length : 0;
  const physicalLayer = evaluatePhysicalLayer({
    connected: true,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    largestGap: 0,
    lengthRatio: scored.details.routeLengthMeters / Math.max(scored.details.targetLengthMeters, 1e-6),
    continuityValid: true,
  });
  const models = computeRecalibratedOrderModels(route, target, word, 'smooth');

  return {
    label,
    intendedLetters,
    observedSequence: observed,
    sequenceValid: integrity.sequenceValid,
    completeness: completeness.complete,
    semanticValid: integrity.sequenceValid && completeness.complete,
    physicalPass: physicalLayer.passes,
    shapeScore: scored.score,
    meanRawInk,
    models,
  };
}

function printScenario(s: ScenarioResult) {
  console.log(`${s.label}: observed=${s.observedSequence.join('->')} semanticValid=${s.semanticValid} (completeness=${s.completeness} sequence=${s.sequenceValid}) physicalPass=${s.physicalPass} shapeScore=${s.shapeScore.toFixed(3)} meanRawInk=${s.meanRawInk.toFixed(3)}`);
  for (const key of RECALIBRATION_MODEL_KEYS) {
    const m = s.models[key];
    console.log(`    ${key}: order=${m.order.toFixed(3)} jumpFit=${m.jumpFit.toFixed(3)} monotonicFit=${m.monotonicFit.toFixed(3)} revisitFit=${m.revisitFit.toFixed(3)} dtwFit=${m.dtwFit.toFixed(3)} directionFit=${m.directionFit.toFixed(3)} allowance=${m.allowance.toFixed(4)}`);
  }
}

function runAdversarialBattery(): ScenarioResult[] {
  console.log('=== ADVERSARIAL BATTERY A-M UNDER RECALIBRATION MODELS ===');
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const target = scalePoints(robzShape.points);
  const [r, o, b, z] = robzShape.letters.map((l) => scalePoints(l.points));
  const intended = wordLetters('ROBZ', 'smooth');
  const results: ScenarioResult[] = [];

  const push = (s: ScenarioResult) => {
    printScenario(s);
    results.push(s);
  };

  push(evaluateScenario('A. Correct (R->O->B->Z)', 'ROBZ', buildConnectedRoute([r!, o!, b!, z!]), target, intended));
  push(evaluateScenario('B. Skip (R->O->Z)', 'ROBZ', buildConnectedRoute([r!, o!, z!]), target, intended));
  push(evaluateScenario('C. Reverse (Z->B->O->R)', 'ROBZ', buildConnectedRoute([z!, b!, o!, r!]), target, intended));
  push(evaluateScenario('D. Reorder (R->B->O->Z)', 'ROBZ', buildConnectedRoute([r!, b!, o!, z!]), target, intended));
  push(evaluateScenario('E. Local revisit (R->O->R->B->Z)', 'ROBZ', buildConnectedRoute([r!, o!, r!, b!, z!]), target, intended));

  const bDense = densify(b!, 6);
  const detourMid = Math.floor(bDense.length / 2);
  const detourPoint = { x: bDense[detourMid]!.x + 300, y: bDense[detourMid]!.y + 300 };
  const bWithDetour = [...bDense.slice(0, detourMid), detourPoint, ...bDense.slice(detourMid)];
  const roConnected = buildConnectedRoute([r!, o!]);
  const fRoute = [
    ...roConnected,
    ...arcConnector(roConnected[roConnected.length - 1]!, bWithDetour[0]!, CONNECTOR_ARC_HEIGHT, 8).slice(1, -1),
    ...bWithDetour,
    ...arcConnector(bWithDetour[bWithDetour.length - 1]!, densify(z!, 6)[0]!, CONNECTOR_ARC_HEIGHT, 8).slice(1, -1),
    ...densify(z!, 6),
  ];
  push(evaluateScenario('F. Large detour within a letter', 'ROBZ', fRoute, target, intended));

  const correctRoute = buildConnectedRoute([r!, o!, b!, z!]);
  const crossFrom = Math.floor(correctRoute.length * 0.62);
  const crossTo = Math.floor(correctRoute.length * 0.2);
  const gRoute = [...correctRoute.slice(0, crossFrom), correctRoute[crossTo]!, ...correctRoute.slice(crossFrom)];
  push(evaluateScenario('G. Legitimate spatial crossing', 'ROBZ', gRoute, target, intended));

  const rDense = densify(r!, 6);
  const oTargetPoint = o![Math.floor(o!.length / 2)]!;
  const bendIndex = Math.floor(rDense.length * 0.7);
  const rBent = rDense.map((p, i) => {
    if (i < bendIndex) return p;
    const t = Math.min(1, (i - bendIndex) / Math.max(1, rDense.length - bendIndex - 1));
    const pullStrength = Math.sin(t * Math.PI) * 0.5;
    return { x: p.x + (oTargetPoint.x - p.x) * pullStrength, y: p.y + (oTargetPoint.y - p.y) * pullStrength };
  });
  push(evaluateScenario('H. Near-letter confusion', 'ROBZ', buildConnectedRoute([rBent, o!, b!, z!]), target, intended));

  // I. Correct route with MODERATE street-network detours (small perpendicular wobble along the whole route, like a real street grid never departing far from the target line).
  const iRoute = correctRoute.map((p, i) => ({ x: p.x + Math.sin(i * 0.7) * 15, y: p.y + Math.cos(i * 0.5) * 15 }));
  push(evaluateScenario('I. Correct + moderate street-network detours', 'ROBZ', iRoute, target, intended));

  // J. Correct route with SEVERE but still physically valid (never reversing letter order) detours.
  const jRoute = correctRoute.map((p, i) => ({ x: p.x + Math.sin(i * 0.9) * 70, y: p.y + Math.cos(i * 0.6) * 70 }));
  push(evaluateScenario('J. Correct + severe but valid detours', 'ROBZ', jRoute, target, intended));

  // K. Physically distorted (sheared) route that still visits every letter in correct order.
  const kRoute = correctRoute.map((p) => ({ x: p.x, y: p.y + p.x * 0.35 }));
  push(evaluateScenario('K. Physically distorted (sheared), correct order', 'ROBZ', kRoute, target, intended));

  // L. Correct sequence but intentionally poor trajectory fidelity: oscillates back and forth within each letter's own span before moving on.
  const lRoute = buildConnectedRoute([zigzagWithinLetter(r!, 2), zigzagWithinLetter(o!, 2), zigzagWithinLetter(b!, 2), zigzagWithinLetter(z!, 2)]);
  push(evaluateScenario('L. Correct sequence, poor trajectory fidelity (oscillating)', 'ROBZ', lRoute, target, intended));

  // M. Correct sequence with MULTIPLE legitimate revisits.
  const mRoute = buildConnectedRoute([r!, o!, r!, o!, b!, z!, b!, z!]);
  push(evaluateScenario('M. Correct sequence, multiple legitimate revisits', 'ROBZ', mRoute, target, intended));

  return results;
}

// ---------------------------------------------------------------------------
// PART 2 — regenerate the exact same deterministic 78-candidate corpus.
// ---------------------------------------------------------------------------

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const MULTI_LETTER_CASES: Array<{ word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type CorpusCandidate = {
  caseIndex: number;
  candidateIndex: number;
  candidateRank: number;
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  shapeScore: number;
  coverage: number;
  backtrack: number;
  largestGap: number;
  targetSpan: number;
  lengthRatio: number;
  continuityValid: boolean;
  meanRawInk: number;
  physicalCoverageFraction: number;
  physicalPass: boolean;
  letterCompleteness: LetterCompletenessResult;
  sequence: SequenceIntegrityResult;
  observedSequence: string[];
  semanticValid: boolean;
  models: Record<RecalibrationModelKey, RecalibratedOrderResult>;
};

function analyzeCandidate(word: string, locationName: string, targetDistanceMeters: number, caseIndex: number, item: FeasibilityRecord, start: { latitude: number; longitude: number }): CorpusCandidate | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) return null;
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const graph = reconstructGraph(item.graphLines);
  const kind = shapeKindFromWord(word);

  const checkpointResult = generateCheckpointRoutes({
    word,
    target: item.target,
    graph,
    kind,
    geometryVariant,
    targetDistanceMeters: item.shapeRouteMeters > 0 ? item.shapeRouteMeters : 2000,
    searchOrigin: start,
    placement: { rotationDegrees: item.rotationDegrees, scale: item.scale, eastMeters: item.eastMeters, northMeters: item.northMeters, distanceFromUserMeters: 0 },
  });
  const best = checkpointResult.candidates[0] ?? null;
  if (!best) return null;
  const pathPoints = coordinatesToLocalMeters(start, best.route.shapeCoordinates ?? best.route.coordinates);
  if (pathPoints.length < 2) return null;

  const { assignments, boundaries } = assignRouteSamplesToLetters(word, item.target, pathPoints, geometryVariant);
  const blocks = deriveVisitationBlocks(assignments);
  const observedSequence = deriveObservedSequence(blocks);
  const intendedSequence = wordLetters(word, geometryVariant);
  const integrity = evaluateSequenceIntegrity(observedSequence, intendedSequence);
  const visitationConfidence = computeVisitationConfidence(boundaries, blocks);

  const identity = analyzeTargetIdentity({ route: pathPoints, target: item.target, word, geometryVariant });
  const scored = scorePolylines(pathPoints, item.target);
  const physical = evaluatePhysicalWordTraversal(word, item.target, pathPoints, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
  const completeness = evaluateLetterCompleteness(physical, visitationConfidence);
  const meanRawInk = physical.letters.length ? physical.letters.reduce((s, l) => s + l.rawInkCoverage, 0) / physical.letters.length : 0;

  const { spans, sampledRoute } = extractLetterRouteSpans(word, item.target, pathPoints, geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  const continuity = evaluateContinuity(transitions, SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio);

  const physicalLayer = evaluatePhysicalLayer({
    connected: true,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    largestGap: identity.largestTargetGap,
    lengthRatio: identity.lengthRatioProjected,
    continuityValid: continuity.continuityValid,
  });

  const models = computeRecalibratedOrderModels(pathPoints, item.target, word, geometryVariant);

  return {
    caseIndex,
    candidateIndex: item.variantRank ?? -1,
    candidateRank: item.variantRank ?? -1,
    word,
    locationName,
    targetDistanceMeters,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    largestGap: identity.largestTargetGap,
    targetSpan: identity.targetSpan,
    lengthRatio: identity.lengthRatioProjected,
    continuityValid: continuity.continuityValid,
    meanRawInk,
    physicalCoverageFraction: physical.coverageFraction,
    physicalPass: physicalLayer.passes,
    letterCompleteness: completeness,
    sequence: integrity,
    observedSequence,
    semanticValid: integrity.sequenceValid && completeness.complete,
    models,
  };
}

async function runCase(caseIndex: number, testCase: (typeof MULTI_LETTER_CASES)[number]): Promise<CorpusCandidate[]> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);
  return feasible
    .map((item) => analyzeCandidate(testCase.word, testCase.locationName, testCase.targetDistanceMeters, caseIndex, item, testCase.start))
    .filter((record): record is CorpusCandidate => record !== null);
}

// ---------------------------------------------------------------------------
// PART 3 — distribution / correlation / gate-threshold analysis.
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}
function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n === 0) return 0;
  const mx = mean(x);
  const my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

function reportModelDistribution(label: string, candidates: readonly CorpusCandidate[], modelKey: RecalibrationModelKey) {
  const orders = candidates.map((c) => c.models[modelKey].order);
  console.log(
    `  [${modelKey}] n=${candidates.length} meanOrder=${mean(orders).toFixed(4)} medianOrder=${median(orders).toFixed(4)} p25=${percentile(orders, 25).toFixed(3)} p75=${percentile(orders, 75).toFixed(3)} ` +
      `meanJumpFit=${mean(candidates.map((c) => c.models[modelKey].jumpFit)).toFixed(4)} meanMonotonicFit=${mean(candidates.map((c) => c.models[modelKey].monotonicFit)).toFixed(4)} ` +
      `meanRevisitFit=${mean(candidates.map((c) => c.models[modelKey].revisitFit)).toFixed(4)} meanDtwFit=${mean(candidates.map((c) => c.models[modelKey].dtwFit)).toFixed(4)} ` +
      `meanDirectionFit=${mean(candidates.map((c) => c.models[modelKey].directionFit)).toFixed(4)}`,
  );
}

function analyzeCorpus(candidates: CorpusCandidate[]) {
  console.log('');
  console.log(`=== PART 3: DISTRIBUTION ANALYSIS (n=${candidates.length}) ===`);

  const semanticValid = candidates.filter((c) => c.semanticValid);
  const completenessInvalid = candidates.filter((c) => !c.letterCompleteness.complete);
  const sequenceInvalid = candidates.filter((c) => !c.sequence.sequenceValid);

  console.log(`semantic-valid: ${semanticValid.length}/${candidates.length}, completeness-invalid: ${completenessInvalid.length}, sequence-invalid: ${sequenceInvalid.length}`);

  for (const modelKey of RECALIBRATION_MODEL_KEYS) {
    console.log('');
    console.log(`--- Model ${modelKey} ---`);
    console.log('All 78:');
    reportModelDistribution('all', candidates, modelKey);
    console.log('Semantic-valid population:');
    reportModelDistribution('semantic-valid', semanticValid, modelKey);
    console.log('Completeness-invalid population:');
    reportModelDistribution('completeness-invalid', completenessInvalid, modelKey);
    console.log('Sequence-invalid population:');
    reportModelDistribution('sequence-invalid', sequenceInvalid, modelKey);
  }

  console.log('');
  console.log('=== PART 5: KEY COMPARISON CASES (semantic-valid population only) ===');
  for (const modelKey of RECALIBRATION_MODEL_KEYS) {
    console.log('');
    console.log(`--- ${modelKey} ---`);
    const falsePenalty = semanticValid.filter((c) => c.shapeScore >= 0.7 && c.meanRawInk >= 0.85 && c.models[modelKey].order < 0.5);
    console.log(`Semantic-valid + high physical quality (shapeScore>=0.7, meanRawInk>=0.85) + low order (<0.5): ${falsePenalty.length}/${semanticValid.length} [FALSE PENALTY candidates]`);
    for (const c of falsePenalty.slice(0, 5)) {
      console.log(`    ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)} order=${c.models[modelKey].order.toFixed(3)} jumpFit=${c.models[modelKey].jumpFit.toFixed(3)}`);
    }

    const missedBad = semanticValid.filter((c) => (c.shapeScore < 0.6 || c.meanRawInk < 0.6) && c.models[modelKey].order >= 0.6);
    console.log(`Semantic-valid + poor physical quality (shapeScore<0.6 or meanRawInk<0.6) + high order (>=0.6): ${missedBad.length}/${semanticValid.length} [UNDETECTED BAD TRAJECTORY candidates]`);
    for (const c of missedBad.slice(0, 5)) {
      console.log(`    ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)} order=${c.models[modelKey].order.toFixed(3)}`);
    }
  }
  const semanticInvalidHighOrder = candidates.filter((c) => !c.semanticValid && c.models.A_current.order >= 0.6);
  console.log('');
  console.log(`Semantic-invalid + high order under A_current (>=0.6): ${semanticInvalidHighOrder.length}/${candidates.length} — no longer automatically problematic since the semantic layer independently rejects these`);

  console.log('');
  console.log('=== PART 6: CORRELATIONS (semantic-valid population, per model order vs physical metrics) ===');
  for (const modelKey of RECALIBRATION_MODEL_KEYS) {
    const orders = semanticValid.map((c) => c.models[modelKey].order);
    console.log(`--- ${modelKey} ---`);
    console.log(`  order vs meanRawInk: ${pearson(orders, semanticValid.map((c) => c.meanRawInk)).toFixed(3)}`);
    console.log(`  order vs shapeScore: ${pearson(orders, semanticValid.map((c) => c.shapeScore)).toFixed(3)}`);
    console.log(`  order vs physicalCoverageFraction: ${pearson(orders, semanticValid.map((c) => c.physicalCoverageFraction)).toFixed(3)}`);
    console.log(`  order vs continuity(1/0): ${pearson(orders, semanticValid.map((c) => (c.continuityValid ? 1 : 0))).toFixed(3)}`);
    console.log(`  order vs backtrack: ${pearson(orders, semanticValid.map((c) => c.backtrack)).toFixed(3)}`);
    console.log(`  order vs largestGap: ${pearson(orders, semanticValid.map((c) => c.largestGap)).toFixed(3)}`);
    console.log(`  order vs lengthRatio: ${pearson(orders, semanticValid.map((c) => c.lengthRatio)).toFixed(3)}`);
    console.log(`  order vs dtwFit(self): ${pearson(orders, semanticValid.map((c) => c.models[modelKey].dtwFit)).toFixed(3)}`);
    console.log(`  order vs directionFit(self): ${pearson(orders, semanticValid.map((c) => c.models[modelKey].directionFit)).toFixed(3)}`);
  }

  console.log('');
  console.log('=== PART 7: GATE P / P+B / P+C AT MULTIPLE ORDER THRESHOLDS ===');
  const gateP = candidates.filter((c) => c.physicalPass && c.letterCompleteness.complete && c.sequence.sequenceValid);
  console.log(`Gate P (physical + completeness + sequence, no order): ${gateP.length}/${candidates.length}`);

  const thresholds = [0.45, 0.5, 0.55, 0.6, 0.65];
  for (const modelKey of (['B_perLetterCount', 'C_targetGeometry'] as RecalibrationModelKey[])) {
    for (const threshold of thresholds) {
      const passing = gateP.filter((c) => c.models[modelKey].order >= threshold);
      const rejectedBySemanticValid = gateP.filter((c) => c.models[modelKey].order < threshold);
      console.log(`Gate P+${modelKey === 'B_perLetterCount' ? 'B' : 'C'} @ threshold ${threshold}: ${passing.length}/${gateP.length} (of Gate P population)`);
      if (rejectedBySemanticValid.length > 0 && rejectedBySemanticValid.length <= 10) {
        for (const c of rejectedBySemanticValid) {
          console.log(`    newly rejected: ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}] order=${c.models[modelKey].order.toFixed(3)} shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)} backtrack=${c.backtrack.toFixed(3)} largestGap=${c.largestGap.toFixed(3)} -> genuinely poor trajectory: ${c.shapeScore < 0.65 || c.meanRawInk < 0.7 || c.backtrack > 0.2 ? 'PLAUSIBLE' : 'QUESTIONABLE — inspect'}`);
        }
      }
    }
  }

  return { semanticValidCount: semanticValid.length, completenessInvalidCount: completenessInvalid.length, sequenceInvalidCount: sequenceInvalid.length, gatePCount: gateP.length };
}

async function main() {
  const started = Date.now();
  const scenarios = runAdversarialBattery();

  console.log('');
  const candidates: CorpusCandidate[] = [];
  for (let caseIndex = 0; caseIndex < MULTI_LETTER_CASES.length; caseIndex += 1) {
    const testCase = MULTI_LETTER_CASES[caseIndex]!;
    console.log(`[recalibrated-order] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const caseCandidates = await runCase(caseIndex, testCase);
    candidates.push(...caseCandidates);
    console.log(`[recalibrated-order] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> ${caseCandidates.length} candidates`);
  }

  // Sanity check against the immediately-prior task's persisted corpus (word sequence + count), not a hard requirement for this task but a useful consistency signal.
  try {
    const prior = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'letter-sequence-integrity-diagnostic-results.json'), 'utf8'));
    const priorWords = prior.cases.flatMap((c: { candidates: { word: string }[] }) => c.candidates.map((x) => x.word));
    const newWords = candidates.map((c) => c.word);
    const sameCount = priorWords.length === newWords.length;
    const sameWords = sameCount && priorWords.every((w: string, i: number) => w === newWords[i]);
    console.log('');
    console.log(`[recalibrated-order] consistency check vs prior corpus: count ${newWords.length} vs ${priorWords.length} (${sameCount ? 'MATCH' : 'MISMATCH'}), word sequence ${sameWords ? 'MATCH' : 'MISMATCH'}`);
  } catch (err) {
    console.log(`[recalibrated-order] consistency check skipped: ${err instanceof Error ? err.message : err}`);
  }

  const summary = analyzeCorpus(candidates);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'recalibrated-order-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), scenarios, candidates, summary }, null, 2), 'utf8');

  console.log('');
  console.log(`[recalibrated-order] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[recalibrated-order] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
