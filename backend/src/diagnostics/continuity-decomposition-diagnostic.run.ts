/**
 * DEVELOPMENT ONLY. Runs the Continuity Sufficiency After TargetSpan
 * Removal diagnostic — the final validation before designing the first
 * production layered-gate implementation.
 *
 * Four parts:
 *  (1) an adversarial battery A-L specifically stressing continuity's own
 *      mechanics (route-space ratio, genuine disconnection, detours,
 *      revisits, crossings, many-small-deviations vs one-large-detour);
 *  (2) a regeneration of the exact deterministic 78-candidate corpus
 *      (continuity's full decomposition — break classification, route
 *      point stats — is not present in any previously-persisted JSON);
 *  (3) continuity-vs-targetSpan population classification, the 8
 *      targetSpan-false-rejection candidates re-examined under continuity
 *      alone, sampling-density sensitivity, and threshold sensitivity;
 *  (4) Gate P-final vs current production gate vs the previous layered
 *      gate (physical+completeness+sequence, no targetSpan).
 *
 * Pure observation — never modifies production. evaluateContinuity() and
 * every function it calls are read-only, unmodified reuse.
 *
 * Run with: npx tsx src/diagnostics/continuity-decomposition-diagnostic.run.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import { decomposeContinuity, decomposeContinuityAtSampleCount, type ContinuityDecomposition } from './continuity-decomposition-diagnostic';
import { decomposeTargetSpan, type TargetSpanDecomposition } from './target-span-decomposition-diagnostic';
import {
  assignRouteSamplesToLetters,
  deriveVisitationBlocks,
  deriveObservedSequence,
  evaluateSequenceIntegrity,
  computeVisitationConfidence,
  wordLetters,
  type SequenceIntegrityResult,
} from './letter-sequence-integrity-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS, computeWholeRouteOrder } from './whole-route-order-diagnostic';
import { evaluateLetterCompleteness, evaluatePhysicalLayer, type LetterCompletenessResult } from './shadow-layered-gate-diagnostic';
import { computeRecalibratedOrderModels } from './recalibrated-order-diagnostic';
import { SHADOW_CONTINUITY_DEFAULTS } from './shadow-product-gate-evaluator';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { scorePolylines } from '../scoring/shape-match';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import { runExperimentalPipelineMultiVariant, type ExperimentalPipelineReport, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// PART 0 — connected-route helpers (identical validated pattern, duplicated).
// ---------------------------------------------------------------------------

const SCALE = 500;
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
function buildConnectedRoute(letterPointArrays: readonly (readonly Vec2[])[], arcHeight = 200, letterFactor = 6, connectorFactor = 8): Vec2[] {
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

// ---------------------------------------------------------------------------
// PART 1 — adversarial battery A-L targeting continuity mechanics.
// ---------------------------------------------------------------------------

type ScenarioResult = {
  label: string;
  observedSequence: string[];
  completeness: boolean;
  sequenceValid: boolean;
  shapeScore: number;
  meanRawInk: number;
  recalibratedOrderModelB: number;
  continuity: ContinuityDecomposition;
  targetSpan: TargetSpanDecomposition;
};

function evaluateScenario(label: string, word: string, route: Vec2[], target: Vec2[], intendedLetters: string[]): ScenarioResult {
  const geometryVariant = 'smooth' as const;
  const { assignments, boundaries } = assignRouteSamplesToLetters(word, target, route, geometryVariant);
  const blocks = deriveVisitationBlocks(assignments);
  const observed = deriveObservedSequence(blocks);
  const integrity: SequenceIntegrityResult = evaluateSequenceIntegrity(observed, intendedLetters);
  const visitation = computeVisitationConfidence(boundaries, blocks);
  const physical = evaluatePhysicalWordTraversal(word, target, route, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
  const completeness = evaluateLetterCompleteness(physical, visitation);
  const scored = scorePolylines(route, target);
  const meanRawInk = physical.letters.length ? physical.letters.reduce((s, l) => s + l.rawInkCoverage, 0) / physical.letters.length : 0;
  const recalibrated = computeRecalibratedOrderModels(route, target, word, geometryVariant);
  const continuity = decomposeContinuity(word, target, route, geometryVariant);
  const targetSpan = decomposeTargetSpan(word, target, route, geometryVariant);

  return {
    label,
    observedSequence: observed,
    completeness: completeness.complete,
    sequenceValid: integrity.sequenceValid,
    shapeScore: scored.score,
    meanRawInk,
    recalibratedOrderModelB: recalibrated.B_perLetterCount.order,
    continuity,
    targetSpan,
  };
}

function printScenario(s: ScenarioResult) {
  const c = s.continuity;
  console.log(
    `${s.label}: observed=${s.observedSequence.join('->')} completeness=${s.completeness} sequenceValid=${s.sequenceValid} shapeScore=${s.shapeScore.toFixed(3)} meanRawInk=${s.meanRawInk.toFixed(3)} recalibOrderB=${s.recalibratedOrderModelB.toFixed(3)}`,
  );
  console.log(
    `    continuityValid=${c.continuityValid} hasDisconnected=${c.hasDisconnectedTransition} worstRatio=${c.worstRatio === null ? 'null' : c.worstRatio.toFixed(2)} numberOfBreaks=${c.numberOfBreaks} breaks=${JSON.stringify(c.breaks.map((b) => `${b.fromLetter}->${b.toLetter}:${b.kind}(${b.ratio === null ? 'null' : b.ratio.toFixed(2)})`))} | targetSpan=${s.targetSpan.targetSpan.toFixed(3)} (comparison only)`,
  );
}

function runAdversarialBattery(): ScenarioResult[] {
  console.log('=== ADVERSARIAL BATTERY A-L TARGETING CONTINUITY MECHANICS ===');
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const target = scalePoints(robzShape.points);
  const [r, o, b, z] = robzShape.letters.map((l) => scalePoints(l.points));
  const intended = wordLetters('ROBZ', 'smooth');
  const results: ScenarioResult[] = [];
  const push = (s: ScenarioResult) => {
    printScenario(s);
    results.push(s);
  };

  push(evaluateScenario('A. Perfect route', 'ROBZ', buildConnectedRoute([r!, o!, b!, z!]), target, intended));

  const correctRoute = buildConnectedRoute([r!, o!, b!, z!]);
  const moderateDetour = correctRoute.map((p, i) => ({ x: p.x + Math.sin(i * 0.6) * 20, y: p.y + Math.cos(i * 0.4) * 20 }));
  push(evaluateScenario('B. Moderate street detour (whole-route wobble, 20m)', 'ROBZ', moderateDetour, target, intended));

  // C. Severe but valid detour: ONE inter-letter connector's arc height is made very large (a genuine, connected, just very long single detour), stressing the routeToStraightRatio directly.
  push(evaluateScenario('C. Severe but valid single-transition detour (2000m arc)', 'ROBZ', buildConnectedRoute([r!, o!, b!, z!], 2000), target, intended));

  // D. Broken/disconnected route: O never reached at all.
  push(evaluateScenario('D. Broken/disconnected route (O never reached)', 'ROBZ', buildConnectedRoute([r!, b!, z!]), target, intended));

  // E. Long off-target excursion: after O, a large out-and-back loop before continuing to B.
  const roConnected = buildConnectedRoute([r!, o!]);
  const farPoint = { x: roConnected[roConnected.length - 1]!.x + 3000, y: roConnected[roConnected.length - 1]!.y + 3000 };
  const excursion = [...roConnected, ...densify([roConnected[roConnected.length - 1]!, farPoint, roConnected[roConnected.length - 1]!], 10).slice(1)];
  const eRoute = [...excursion, ...arcConnector(excursion[excursion.length - 1]!, densify(b!, 6)[0]!, 200, 8).slice(1, -1), ...densify(b!, 6), ...arcConnector(densify(b!, 6)[densify(b!, 6).length - 1]!, densify(z!, 6)[0]!, 200, 8).slice(1, -1), ...densify(z!, 6)];
  push(evaluateScenario('E. Long off-target excursion (out-and-back loop)', 'ROBZ', eRoute, target, intended));

  // F. Wrong bridge: R->B connector routed at ground level directly through O's own target location (not elevated), to see whether it gets ambiguously attributed.
  const rDense = densify(r!, 6);
  const bDense = densify(b!, 6);
  const oMid = o![Math.floor(o!.length / 2)]!;
  const throughOBridge = densify([rDense[rDense.length - 1]!, oMid, bDense[0]!], 10);
  const fRoute = [...rDense, ...throughOBridge.slice(1, -1), ...bDense, ...arcConnector(bDense[bDense.length - 1]!, densify(z!, 6)[0]!, 200, 8).slice(1, -1), ...densify(z!, 6)];
  push(evaluateScenario('F. Wrong bridge (R->B routed through O\'s own territory)', 'ROBZ', fRoute, target, intended));

  push(evaluateScenario('G. Skip final letter (Z never reached)', 'ROBZ', buildConnectedRoute([r!, o!, b!]), target, intended));

  push(evaluateScenario('H. Correct sequence + repeated local revisits', 'ROBZ', buildConnectedRoute([r!, o!, r!, o!, b!, z!, b!, z!]), target, intended));

  // I. Spatial self-crossing: revisit an earlier spatial point mid-route (legitimate crossing, not a new letter).
  const crossFrom = Math.floor(correctRoute.length * 0.62);
  const crossTo = Math.floor(correctRoute.length * 0.2);
  const iRoute = [...correctRoute.slice(0, crossFrom), correctRoute[crossTo]!, ...correctRoute.slice(crossFrom)];
  push(evaluateScenario('I. Spatial self-crossing', 'ROBZ', iRoute, target, intended));

  // J. Large single jump: raw stitch (no connector at all) between O and B — one abrupt discontinuity.
  const jRoute = [...densify(r!, 6), ...densify(o!, 6), ...densify(b!, 6), ...densify(z!, 6)];
  push(evaluateScenario('J. Large single raw jump (no connector between any letters)', 'ROBZ', jRoute, target, intended));

  // K. Many small deviations instead of one large one (same total wobble energy roughly, higher frequency, smaller amplitude).
  const manySmall = correctRoute.map((p, i) => ({ x: p.x + Math.sin(i * 2.5) * 8, y: p.y + Math.cos(i * 2.1) * 8 }));
  push(evaluateScenario('K. Many small deviations (high-frequency, 8m)', 'ROBZ', manySmall, target, intended));

  // L. Long legitimate street connector far from target polyline but connected (a genuinely necessary, moderate-large detour, framed as legitimate street routing rather than adversarial).
  push(evaluateScenario('L. Long legitimate street connector (600m arc)', 'ROBZ', buildConnectedRoute([r!, o!, b!, z!], 600), target, intended));

  return results;
}

// ---------------------------------------------------------------------------
// PART 2 — regenerate the exact deterministic 78-candidate corpus.
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
  candidateRank: number;
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  shapeScore: number;
  coverage: number;
  backtrack: number;
  lengthRatioProjected: number;
  meanRawInk: number;
  physicalPass: boolean;
  letterCompleteness: LetterCompletenessResult;
  sequence: SequenceIntegrityResult;
  observedSequence: string[];
  wholeRouteOrderCurrent: number;
  recalibratedOrderModelB: number;
  continuity: ContinuityDecomposition;
  targetSpan: TargetSpanDecomposition;
  wordTraversal: boolean;
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

  const scored = scorePolylines(pathPoints, item.target);
  const physical = evaluatePhysicalWordTraversal(word, item.target, pathPoints, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
  const completeness = evaluateLetterCompleteness(physical, visitationConfidence);
  const meanRawInk = physical.letters.length ? physical.letters.reduce((s, l) => s + l.rawInkCoverage, 0) / physical.letters.length : 0;

  const continuity = decomposeContinuity(word, item.target, pathPoints, geometryVariant);
  const targetSpan = decomposeTargetSpan(word, item.target, pathPoints, geometryVariant, targetDistanceMeters);

  const physicalLayer = evaluatePhysicalLayer({
    connected: true,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    largestGap: targetSpan.largestTargetGap,
    lengthRatio: targetSpan.lengthRatioProjected,
    continuityValid: continuity.continuityValid,
  });

  const order = computeWholeRouteOrder(pathPoints, item.target);
  const recalibrated = computeRecalibratedOrderModels(pathPoints, item.target, word, geometryVariant);

  return {
    caseIndex,
    candidateRank: item.variantRank ?? -1,
    word,
    locationName,
    targetDistanceMeters,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    lengthRatioProjected: targetSpan.lengthRatioProjected,
    meanRawInk,
    physicalPass: physicalLayer.passes,
    letterCompleteness: completeness,
    sequence: integrity,
    observedSequence,
    wholeRouteOrderCurrent: order.order,
    recalibratedOrderModelB: recalibrated.B_perLetterCount.order,
    continuity,
    targetSpan,
    wordTraversal: targetSpan.wordTraversal >= 1,
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
// PART 3 — populations, deep-dive, sampling sensitivity, threshold sweep, gates.
// ---------------------------------------------------------------------------

function analyzeCorpus(candidates: CorpusCandidate[]) {
  console.log('');
  console.log(`=== PART 3: CONTINUITY vs TARGETSPAN POPULATIONS (n=${candidates.length}) ===`);
  const targetSpanPass = (c: CorpusCandidate) => c.targetSpan.targetSpan >= EXPERIMENTAL_PRODUCT.minTargetSpan;

  const popA = candidates.filter((c) => c.continuity.continuityValid && !targetSpanPass(c));
  const popB = candidates.filter((c) => !c.continuity.continuityValid && targetSpanPass(c));
  const popC = candidates.filter((c) => c.continuity.continuityValid && targetSpanPass(c));
  const popD = candidates.filter((c) => !c.continuity.continuityValid && !targetSpanPass(c));
  console.log(`A (continuity=PASS, targetSpan=FAIL): ${popA.length}/${candidates.length}`);
  console.log(`B (continuity=FAIL, targetSpan=PASS): ${popB.length}/${candidates.length}`);
  console.log(`C (continuity=PASS, targetSpan=PASS): ${popC.length}/${candidates.length}`);
  console.log(`D (continuity=FAIL, targetSpan=FAIL): ${popD.length}/${candidates.length}`);
  for (const c of popB) {
    console.log(`  Pop B detail: ${c.word} [case ${c.caseIndex}]: worstRatio=${c.continuity.worstRatio?.toFixed(2)} breaks=${JSON.stringify(c.continuity.breaks.map((b) => b.kind))} shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)} completeness=${c.letterCompleteness.complete} sequenceValid=${c.sequence.sequenceValid}`);
  }

  console.log('');
  console.log('=== PART 3b: THE 8 TARGETSPAN-FALSE-REJECTION CANDIDATES, RE-EXAMINED UNDER CONTINUITY ===');
  const eightCandidates = candidates.filter((c) => c.physicalPass && c.letterCompleteness.complete && c.sequence.sequenceValid && !targetSpanPass(c));
  console.log(`Found: ${eightCandidates.length} (expect 8, matching the prior task's finding)`);
  for (const c of eightCandidates) {
    console.log(
      `  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: continuityValid=${c.continuity.continuityValid} worstRatio=${c.continuity.worstRatio?.toFixed(2) ?? 'null'} shapeScore=${c.shapeScore.toFixed(3)} coverage=${c.coverage.toFixed(3)} backtrack=${c.backtrack.toFixed(3)} lengthRatio=${c.lengthRatioProjected.toFixed(3)} observed=${c.observedSequence.join('->')} targetSpan=${c.targetSpan.targetSpan.toFixed(3)} recalibOrderB=${c.recalibratedOrderModelB.toFixed(3)}`,
    );
  }
  const acceptedByContinuity = eightCandidates.filter((c) => c.continuity.continuityValid).length;
  console.log(`Of these 8, continuity ACCEPTS (continuityValid=true): ${acceptedByContinuity}/${eightCandidates.length}`);

  console.log('');
  console.log('=== PART 3c: THRESHOLD SENSITIVITY (maxInterLetterRouteRatio) ===');
  for (const threshold of [5, 8, 10, 15, 20, 30]) {
    const passing = candidates.filter((c) => !c.continuity.hasDisconnectedTransition && (c.continuity.worstRatio === null || c.continuity.worstRatio <= threshold));
    const semanticValid = candidates.filter((c) => c.letterCompleteness.complete && c.sequence.sequenceValid);
    const semanticValidPassing = semanticValid.filter((c) => !c.continuity.hasDisconnectedTransition && (c.continuity.worstRatio === null || c.continuity.worstRatio <= threshold));
    console.log(`threshold ${threshold}: passing=${passing.length}/${candidates.length}, of semantic-valid population: ${semanticValidPassing.length}/${semanticValid.length}`);
  }

  console.log('');
  console.log('=== PART 8: GATE P-FINAL vs CURRENT PRODUCTION vs PREVIOUS LAYERED GATE ===');
  const gateCurrent = candidates.filter((c) => c.physicalPass && c.wordTraversal && targetSpanPass(c) && c.wholeRouteOrderCurrent >= EXPERIMENTAL_PRODUCT.minOrder);
  const gatePrevious = candidates.filter((c) => c.physicalPass && c.letterCompleteness.complete && c.sequence.sequenceValid);
  const gatePFinal = candidates.filter((c) => c.physicalPass && c.continuity.continuityValid && c.letterCompleteness.complete && c.sequence.sequenceValid);
  console.log(`Current production gate (physical+wordTraversal+targetSpan+order>=0.6): ${gateCurrent.length}/${candidates.length}`);
  console.log(`Previous layered gate (physical+completeness+sequence, no targetSpan, no order): ${gatePrevious.length}/${candidates.length}`);
  console.log(`Gate P-final (physical[incl. continuity]+completeness+sequence, no targetSpan, no order): ${gatePFinal.length}/${candidates.length}`);

  console.log('');
  console.log('=== PART 9: CURRENT FAIL -> P-FINAL PASS ===');
  const currentFailPFinalPass = candidates.filter((c) => !(c.physicalPass && c.wordTraversal && targetSpanPass(c) && c.wholeRouteOrderCurrent >= EXPERIMENTAL_PRODUCT.minOrder) && c.physicalPass && c.continuity.continuityValid && c.letterCompleteness.complete && c.sequence.sequenceValid);
  console.log(`count: ${currentFailPFinalPass.length}/${candidates.length}`);
  for (const c of currentFailPFinalPass) {
    const classification = c.shapeScore >= 0.65 && c.meanRawInk >= 0.85 ? 'A. clearly legitimate' : c.shapeScore >= 0.5 ? 'B. ambiguous' : 'C. clearly invalid';
    console.log(
      `  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)} continuity=${c.continuity.continuityValid} completeness=${c.letterCompleteness.complete} sequence=${c.sequence.sequenceValid} targetSpan=${c.targetSpan.targetSpan.toFixed(3)} wholeRouteOrder=${c.wholeRouteOrderCurrent.toFixed(3)} wordTraversal=${c.wordTraversal} -> classification: ${classification}`,
    );
  }

  console.log('');
  console.log('=== PART 10: P-FINAL FAIL DESPITE PHYSICAL+SEMANTIC PASS (continuity is the blocker) ===');
  const continuityOnlyBlocked = candidates.filter((c) => c.physicalPass && c.letterCompleteness.complete && c.sequence.sequenceValid && !c.continuity.continuityValid);
  console.log(`count: ${continuityOnlyBlocked.length}/${candidates.length}`);
  for (const c of continuityOnlyBlocked) {
    const reason = c.continuity.hasDisconnectedTransition ? 'genuine disconnection (a letter never reached)' : `excessive detour ratio (${c.continuity.worstRatio?.toFixed(2)}x, threshold ${SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio})`;
    console.log(`  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: reason=${reason} shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)}`);
  }

  return {
    popACount: popA.length,
    popBCount: popB.length,
    popCCount: popC.length,
    popDCount: popD.length,
    eightCandidatesFound: eightCandidates.length,
    eightAcceptedByContinuity: acceptedByContinuity,
    gateCurrentCount: gateCurrent.length,
    gatePreviousCount: gatePrevious.length,
    gatePFinalCount: gatePFinal.length,
    currentFailPFinalPassCount: currentFailPFinalPass.length,
    continuityOnlyBlockedCount: continuityOnlyBlocked.length,
  };
}

async function runSamplingSensitivity() {
  console.log('');
  console.log('=== PART 6: SAMPLING DENSITY SENSITIVITY ===');
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const target = scalePoints(robzShape.points);
  const [r, o, b, z] = robzShape.letters.map((l) => scalePoints(l.points));
  const perfectRoute = buildConnectedRoute([r!, o!, b!, z!]);
  const severeDetourRoute = buildConnectedRoute([r!, o!, b!, z!], 2000);

  for (const [label, route] of [['A. Perfect route', perfectRoute], ['C. Severe detour route', severeDetourRoute]] as const) {
    console.log(`${label}:`);
    for (const sampleCount of [40, 60, 80, 120, 160]) {
      const result = decomposeContinuityAtSampleCount('ROBZ', target, route, 'smooth', sampleCount);
      console.log(`  n=${sampleCount}: continuityValid=${result.continuityValid} worstRatio=${result.worstRatio === null ? 'null' : result.worstRatio.toFixed(2)}`);
    }
  }
}

async function main() {
  const started = Date.now();
  const scenarios = runAdversarialBattery();
  await runSamplingSensitivity();

  console.log('');
  const candidates: CorpusCandidate[] = [];
  for (let caseIndex = 0; caseIndex < MULTI_LETTER_CASES.length; caseIndex += 1) {
    const testCase = MULTI_LETTER_CASES[caseIndex]!;
    console.log(`[continuity] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const caseCandidates = await runCase(caseIndex, testCase);
    candidates.push(...caseCandidates);
    console.log(`[continuity] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> ${caseCandidates.length} candidates`);
  }

  try {
    const prior = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'letter-sequence-integrity-diagnostic-results.json'), 'utf8'));
    const priorWords = prior.cases.flatMap((c: { candidates: { word: string }[] }) => c.candidates.map((x) => x.word));
    const newWords = candidates.map((c) => c.word);
    const sameCount = priorWords.length === newWords.length;
    const sameWords = sameCount && priorWords.every((w: string, i: number) => w === newWords[i]);
    console.log('');
    console.log(`[continuity] consistency check vs prior corpus: count ${newWords.length} vs ${priorWords.length} (${sameCount ? 'MATCH' : 'MISMATCH'}), word sequence ${sameWords ? 'MATCH' : 'MISMATCH'}`);
  } catch (err) {
    console.log(`[continuity] consistency check skipped: ${err instanceof Error ? err.message : err}`);
  }

  const summary = analyzeCorpus(candidates);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'continuity-decomposition-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), scenarios, candidates, summary }, null, 2), 'utf8');

  console.log('');
  console.log(`[continuity] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[continuity] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
