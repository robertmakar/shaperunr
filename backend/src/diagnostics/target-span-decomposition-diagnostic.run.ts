/**
 * DEVELOPMENT ONLY. Runs the TargetSpan Redundancy Under the Layered
 * Product Gate diagnostic.
 *
 * Three parts:
 *  (1) a connected adversarial battery A-N specifically targeting
 *      targetSpan's own mechanics (route-chronological connected-run +
 *      bin-occupancy), including uneven letter length/spacing cases;
 *  (2) a regeneration of the exact same deterministic 78-candidate corpus
 *      (needed: targetSpan's full decomposition — naiveSpan, spanOccupancy,
 *      largestTargetGap, per-letter target progress — is not present in
 *      any previously-persisted result JSON);
 *  (3) population A/B/C/D identification, disagreement analysis, threshold
 *      sweep, and Gate A/B/C/D evaluation (physical+completeness+sequence,
 *      with/without targetSpan, with/without recalibrated Model B order).
 *
 * Pure observation — never modifies production. analyzeTargetIdentity()
 * (the real targetSpan implementation) is called read-only, never edited.
 *
 * Run with: npx tsx src/diagnostics/target-span-decomposition-diagnostic.run.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

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
import { evaluateContinuity, SHADOW_CONTINUITY_DEFAULTS } from './shadow-product-gate-evaluator';
import { extractLetterRouteSpans, computeTransitionRecord, type TransitionRecord } from './inter-letter-continuity-diagnostic';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { scorePolylines } from '../scoring/shape-match';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import { runExperimentalPipelineMultiVariant, type ExperimentalPipelineReport, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// PART 0 — connected-route helpers, identical pattern to the prior two
// tasks' validated battery (duplicated, not redesigned).
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

/** Straight (non-arced) connected layout — for scenarios where the ROUTE should legitimately follow a custom target exactly (spacing tests), not detour around it. */
function buildStraightConnectedRoute(letterPointArrays: readonly (readonly Vec2[])[], letterFactor = 6, connectorFactor = 8): Vec2[] {
  let route: Vec2[] = [];
  letterPointArrays.forEach((points, i) => {
    const dense = densify(points, letterFactor);
    if (i === 0) {
      route = [...dense];
      return;
    }
    const prevEnd = route[route.length - 1]!;
    const nextStart = dense[0]!;
    route.push(...densify([prevEnd, nextStart], connectorFactor).slice(1, -1));
    route.push(...dense);
  });
  return route;
}

/** Repositions each letter's own point array so consecutive letters sit exactly `gaps[i]` meters apart on the x axis (custom, controllable spacing — buildWalkableWordShape hardcodes a fixed 0.28-unit gap with no override, so this is built by hand for Scenario M only). */
function relayoutWithGaps(letterPointArrays: readonly (readonly Vec2[])[], gaps: readonly number[]): Vec2[][] {
  let cursorX = 0;
  return letterPointArrays.map((points, i) => {
    const minX = Math.min(...points.map((p) => p.x));
    const shift = cursorX - minX;
    const shifted = points.map((p) => ({ x: p.x + shift, y: p.y }));
    const maxX = Math.max(...shifted.map((p) => p.x));
    cursorX = maxX + (gaps[i] ?? 50);
    return shifted;
  });
}

// ---------------------------------------------------------------------------
// PART 1 — adversarial battery A-N targeting targetSpan mechanics.
// ---------------------------------------------------------------------------

type ScenarioResult = {
  label: string;
  word: string;
  observedSequence: string[];
  completeness: boolean;
  sequenceValid: boolean;
  physicalPass: boolean;
  shapeScore: number;
  meanRawInk: number;
  wholeRouteOrder: number;
  decomposition: TargetSpanDecomposition;
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
  const physicalLayer = evaluatePhysicalLayer({
    connected: true,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    largestGap: 0,
    lengthRatio: scored.details.routeLengthMeters / Math.max(scored.details.targetLengthMeters, 1e-6),
    continuityValid: true,
  });
  const order = computeWholeRouteOrder(route, target);
  const decomposition = decomposeTargetSpan(word, target, route, geometryVariant);

  return {
    label,
    word,
    observedSequence: observed,
    completeness: completeness.complete,
    sequenceValid: integrity.sequenceValid,
    physicalPass: physicalLayer.passes,
    shapeScore: scored.score,
    meanRawInk,
    wholeRouteOrder: order.order,
    decomposition,
  };
}

function printScenario(s: ScenarioResult) {
  const d = s.decomposition;
  console.log(
    `${s.label}: observed=${s.observedSequence.join('->')} completeness=${s.completeness} sequenceValid=${s.sequenceValid} physicalPass=${s.physicalPass} shapeScore=${s.shapeScore.toFixed(3)} meanRawInk=${s.meanRawInk.toFixed(3)} wholeRouteOrder=${s.wholeRouteOrder.toFixed(3)}`,
  );
  console.log(
    `    targetSpan=${d.targetSpan.toFixed(3)} naiveSpan=${d.naiveSpan.toFixed(3)} spanOccupancy=${d.spanOccupancy.toFixed(3)} largestTargetGap=${d.largestTargetGap.toFixed(3)} ` +
      `firstReached=${d.firstTargetProgressReached?.toFixed(3) ?? 'null'} lastReached=${d.lastTargetProgressReached?.toFixed(3) ?? 'null'} firstVisitedLetter=${d.firstVisitedLetter} lastVisitedLetter=${d.lastVisitedLetter} wordTraversal=${d.wordTraversal.toFixed(3)} traversesMostOfWord=${d.traversesMostOfWord}`,
  );
}

function runAdversarialBattery(): ScenarioResult[] {
  console.log('=== ADVERSARIAL BATTERY A-N TARGETING TARGETSPAN MECHANICS ===');
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const target = scalePoints(robzShape.points);
  const [r, o, b, z] = robzShape.letters.map((l) => scalePoints(l.points));
  const intended = wordLetters('ROBZ', 'smooth');
  const results: ScenarioResult[] = [];
  const push = (s: ScenarioResult) => {
    printScenario(s);
    results.push(s);
  };

  push(evaluateScenario('A. Perfect complete traversal', 'ROBZ', buildConnectedRoute([r!, o!, b!, z!]), target, intended));
  push(evaluateScenario('B. Skip first letter (R)', 'ROBZ', buildConnectedRoute([o!, b!, z!]), target, intended));
  push(evaluateScenario('C. Skip middle letter (O)', 'ROBZ', buildConnectedRoute([r!, b!, z!]), target, intended));
  push(evaluateScenario('D. Skip final letter (Z)', 'ROBZ', buildConnectedRoute([r!, o!, b!]), target, intended));

  // E. Minimal touch: only a few points near each letter's own midpoint, not the full stroke.
  const minimalTouch = (points: readonly Vec2[]) => {
    const mid = points[Math.floor(points.length / 2)]!;
    const near = points[Math.floor(points.length / 2) + 1] ?? mid;
    return densify([mid, near], 3);
  };
  push(evaluateScenario('E. Minimal touch (every letter barely traced)', 'ROBZ', buildConnectedRoute([minimalTouch(r!), minimalTouch(o!), minimalTouch(b!), minimalTouch(z!)]), target, intended));

  // F. Full tracing + moderate-to-large legitimate street detours (whole route wobble, not severe enough to corrupt letter attribution).
  const correctRoute = buildConnectedRoute([r!, o!, b!, z!]);
  const fRoute = correctRoute.map((p, i) => ({ x: p.x + Math.sin(i * 0.6) * 40, y: p.y + Math.cos(i * 0.4) * 40 }));
  push(evaluateScenario('F. Full tracing + huge street detours', 'ROBZ', fRoute, target, intended));

  push(evaluateScenario('G. Correct sequence + extensive revisits', 'ROBZ', buildConnectedRoute([r!, o!, r!, o!, b!, z!, b!, z!]), target, intended));

  // H. Late start: begin partway through R.
  const rDense = densify(r!, 6);
  const rLateStart = rDense.slice(Math.floor(rDense.length * 0.4));
  push(evaluateScenario('H. Correct sequence + late start (partway through R)', 'ROBZ', buildConnectedRoute([rLateStart, o!, b!, z!]), target, intended));

  // I. Early finish: stop partway through Z.
  const zDense = densify(z!, 6);
  const zEarlyFinish = zDense.slice(0, Math.ceil(zDense.length * 0.5));
  push(evaluateScenario('I. Correct sequence + early finish (stops partway through Z)', 'ROBZ', buildConnectedRoute([r!, o!, b!, zEarlyFinish]), target, intended));

  // J. Very short middle letter: MIM (I is much narrower than the two Ms).
  const mimShape = buildWalkableWordShape('MIM', { letterVariant: 'smooth' });
  const mimTarget = scalePoints(mimShape.points);
  const [m1, iShort, m2] = mimShape.letters.map((l) => scalePoints(l.points));
  push(evaluateScenario('J. Very short middle letter (MIM)', 'MIM', buildConnectedRoute([m1!, iShort!, m2!]), mimTarget, wordLetters('MIM', 'smooth')));

  // K. Very long middle letter: IMI (M is much wider than the two Is).
  const imiShape = buildWalkableWordShape('IMI', { letterVariant: 'smooth' });
  const imiTarget = scalePoints(imiShape.points);
  const [i1, mLong, i2] = imiShape.letters.map((l) => scalePoints(l.points));
  push(evaluateScenario('K. Very long middle letter (IMI)', 'IMI', buildConnectedRoute([i1!, mLong!, i2!]), imiTarget, wordLetters('IMI', 'smooth')));

  // L. Uneven letter lengths mixed: MIWI (wide, narrow, wide, narrow).
  const miwiShape = buildWalkableWordShape('MIWI', { letterVariant: 'smooth' });
  const miwiTarget = scalePoints(miwiShape.points);
  const miwiLetters = miwiShape.letters.map((l) => scalePoints(l.points));
  push(evaluateScenario('L. Uneven letter lengths (MIWI)', 'MIWI', buildConnectedRoute(miwiLetters), miwiTarget, wordLetters('MIWI', 'smooth')));

  // M. Uneven letter spacing: same ROBZ letters, custom small/large gaps, route follows the custom target exactly (legitimate spacing, not a detour test).
  const gapPositioned = relayoutWithGaps([r!, o!, b!, z!], [5, 5, 400]); // R-O: 5m (tiny), O-B: 5m (tiny), B-Z: 400m (huge, legitimate wide word layout)
  let mTarget: Vec2[] = [];
  gapPositioned.forEach((points, i) => {
    if (i === 0) {
      mTarget = densify(points, 6);
      return;
    }
    const prevEnd = mTarget[mTarget.length - 1]!;
    const nextStart = points[0]!;
    mTarget.push(...densify([prevEnd, nextStart], 8).slice(1));
    mTarget.push(...densify(points, 6).slice(1));
  });
  const mRoute = buildStraightConnectedRoute(gapPositioned);
  push(evaluateScenario('M. Uneven letter spacing (tiny, tiny, huge legitimate gaps)', 'ROBZ', mRoute, mTarget, intended));

  // N. Wrong sequence but broad target span: R->B->O->Z (starts at the true beginning, ends at the true end, wrong in the middle).
  push(evaluateScenario('N. Wrong sequence but broad target span (R->B->O->Z)', 'ROBZ', buildConnectedRoute([r!, b!, o!, z!]), target, intended));

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
  largestGap: number;
  continuityValid: boolean;
  meanRawInk: number;
  physicalCoverageFraction: number;
  physicalPass: boolean;
  letterCompleteness: LetterCompletenessResult;
  sequence: SequenceIntegrityResult;
  observedSequence: string[];
  wholeRouteOrderCurrent: number;
  recalibratedOrderModelB: number;
  decomposition: TargetSpanDecomposition;
  targetSpanPass: boolean;
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

  const { spans, sampledRoute } = extractLetterRouteSpans(word, item.target, pathPoints, geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  const continuity = evaluateContinuity(transitions, SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio);

  const decomposition = decomposeTargetSpan(word, item.target, pathPoints, geometryVariant, targetDistanceMeters);

  const physicalLayer = evaluatePhysicalLayer({
    connected: true,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    largestGap: decomposition.largestTargetGap,
    lengthRatio: decomposition.lengthRatioProjected,
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
    largestGap: decomposition.largestTargetGap,
    continuityValid: continuity.continuityValid,
    meanRawInk,
    physicalCoverageFraction: physical.coverageFraction,
    physicalPass: physicalLayer.passes,
    letterCompleteness: completeness,
    sequence: integrity,
    observedSequence,
    wholeRouteOrderCurrent: order.order,
    recalibratedOrderModelB: recalibrated.B_perLetterCount.order,
    decomposition,
    targetSpanPass: decomposition.targetSpan >= EXPERIMENTAL_PRODUCT.minTargetSpan,
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
// PART 3 — populations, disagreement, threshold sweep, gates.
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
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

function analyzeCorpus(candidates: CorpusCandidate[]) {
  console.log('');
  console.log(`=== PART 3: FOUR CRITICAL POPULATIONS (n=${candidates.length}) ===`);

  const popA = candidates.filter((c) => c.letterCompleteness.complete && !c.targetSpanPass);
  const popB = candidates.filter((c) => !c.letterCompleteness.complete && c.targetSpanPass);
  const popC = candidates.filter((c) => c.letterCompleteness.complete && c.sequence.sequenceValid && !c.targetSpanPass);
  const popD = candidates.filter((c) => !c.letterCompleteness.complete && !c.targetSpanPass);

  console.log(`Population A (completeness=true, targetSpan=FAIL): ${popA.length}/${candidates.length}`);
  for (const c of popA) {
    const d = c.decomposition;
    console.log(
      `  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: targetSpan=${d.targetSpan.toFixed(3)} (span-component from longestConnectedSpan; occupancy=${d.spanOccupancy.toFixed(3)}) naiveSpan=${d.naiveSpan.toFixed(3)} largestTargetGap=${d.largestTargetGap.toFixed(3)} firstReached=${d.firstTargetProgressReached?.toFixed(3)} lastReached=${d.lastTargetProgressReached?.toFixed(3)} sequenceValid=${c.sequence.sequenceValid} observed=${c.observedSequence.join('->')} shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)}`,
    );
  }

  console.log('');
  console.log(`Population B (completeness=false, targetSpan=PASS): ${popB.length}/${candidates.length}`);
  for (const c of popB) {
    const d = c.decomposition;
    console.log(
      `  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: targetSpan=${d.targetSpan.toFixed(3)} missingLetters=${JSON.stringify(c.letterCompleteness.missingLetters)} observed=${c.observedSequence.join('->')} firstVisited=${d.firstVisitedLetter} lastVisited=${d.lastVisitedLetter} firstReached=${d.firstTargetProgressReached?.toFixed(3)} lastReached=${d.lastTargetProgressReached?.toFixed(3)}`,
    );
  }

  console.log('');
  console.log(`Population C (completeness=true, sequenceValid=true, targetSpan=FAIL): ${popC.length}/${candidates.length}`);
  for (const c of popC) {
    const d = c.decomposition;
    console.log(
      `  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: targetSpan=${d.targetSpan.toFixed(3)} span-component-implies-fractured-run=${(d.naiveSpan - d.targetSpan).toFixed(3)} largestTargetGap=${d.largestTargetGap.toFixed(3)} continuityValid=${c.continuityValid} shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)} physicalPass=${c.physicalPass}`,
    );
  }

  console.log('');
  console.log(`Population D (completeness=false, targetSpan=FAIL): ${popD.length}/${candidates.length}`);

  console.log('');
  console.log('=== PART 4: DISAGREEMENT WITH OTHER SIGNALS (targetSpanPass vs X) ===');
  function agreementRate(x: readonly boolean[], y: readonly boolean[]): number {
    let agree = 0;
    for (let i = 0; i < x.length; i += 1) if (x[i] === y[i]) agree += 1;
    return agree / x.length;
  }
  const targetSpanArr = candidates.map((c) => c.targetSpanPass);
  const completenessArr = candidates.map((c) => c.letterCompleteness.complete);
  const sequenceArr = candidates.map((c) => c.sequence.sequenceValid);
  const physicalArr = candidates.map((c) => c.physicalPass);
  console.log(`targetSpan vs completeness: agree ${(agreementRate(targetSpanArr, completenessArr) * 100).toFixed(1)}%`);
  console.log(`targetSpan vs sequenceValid: agree ${(agreementRate(targetSpanArr, sequenceArr) * 100).toFixed(1)}%`);
  console.log(`targetSpan vs physicalPass: agree ${(agreementRate(targetSpanArr, physicalArr) * 100).toFixed(1)}%`);

  const targetSpanValues = candidates.map((c) => c.decomposition.targetSpan);
  console.log(`targetSpan vs shapeScore: corr ${pearson(targetSpanValues, candidates.map((c) => c.shapeScore)).toFixed(3)}`);
  console.log(`targetSpan vs meanRawInk: corr ${pearson(targetSpanValues, candidates.map((c) => c.meanRawInk)).toFixed(3)}`);
  console.log(`targetSpan vs continuity(1/0): corr ${pearson(targetSpanValues, candidates.map((c) => (c.continuityValid ? 1 : 0))).toFixed(3)}`);
  console.log(`targetSpan vs backtrack: corr ${pearson(targetSpanValues, candidates.map((c) => c.backtrack)).toFixed(3)}`);
  console.log(`targetSpan vs largestGap: corr ${pearson(targetSpanValues, candidates.map((c) => c.largestGap)).toFixed(3)}`);
  console.log(`targetSpan vs wholeRouteOrder(current): corr ${pearson(targetSpanValues, candidates.map((c) => c.wholeRouteOrderCurrent)).toFixed(3)}`);
  console.log(`targetSpan vs recalibratedOrder(ModelB): corr ${pearson(targetSpanValues, candidates.map((c) => c.recalibratedOrderModelB)).toFixed(3)}`);
  console.log(`targetSpan vs wordTraversal: corr ${pearson(targetSpanValues, candidates.map((c) => c.decomposition.wordTraversal)).toFixed(3)}`);

  console.log('');
  console.log('=== PART 7: THRESHOLD SENSITIVITY ===');
  const semanticValid = candidates.filter((c) => c.letterCompleteness.complete && c.sequence.sequenceValid);
  for (const threshold of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
    const passing = candidates.filter((c) => c.decomposition.targetSpan >= threshold);
    const completenessInvalidPassing = passing.filter((c) => !c.letterCompleteness.complete);
    const sequenceInvalidPassing = passing.filter((c) => !c.sequence.sequenceValid);
    const physicallyWeakPassing = passing.filter((c) => c.shapeScore < 0.6 || c.meanRawInk < 0.6);
    const strongSemanticValidRejected = semanticValid.filter((c) => c.decomposition.targetSpan < threshold && c.shapeScore >= 0.7 && c.meanRawInk >= 0.85);
    console.log(
      `threshold ${threshold}: passing=${passing.length}/${candidates.length} completenessInvalidPassing=${completenessInvalidPassing.length} sequenceInvalidPassing=${sequenceInvalidPassing.length} physicallyWeakPassing=${physicallyWeakPassing.length} strongSemanticValidRejected=${strongSemanticValidRejected.length}`,
    );
  }

  console.log('');
  console.log('=== PART 8: GATE A/B/C/D ===');
  const gateA = candidates.filter((c) => c.physicalPass && c.letterCompleteness.complete && c.sequence.sequenceValid);
  console.log(`Gate A (physical+completeness+sequence, NO targetSpan): ${gateA.length}/${candidates.length}`);
  const gateBExisting = gateA.filter((c) => c.decomposition.targetSpan >= EXPERIMENTAL_PRODUCT.minTargetSpan);
  console.log(`Gate B (Gate A + targetSpan>=${EXPERIMENTAL_PRODUCT.minTargetSpan}): ${gateBExisting.length}/${gateA.length} (of Gate A population)`);

  console.log('Gate C (targetSpan threshold sweep, of Gate A population):');
  for (const threshold of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
    const passing = gateA.filter((c) => c.decomposition.targetSpan >= threshold);
    console.log(`  @${threshold}: ${passing.length}/${gateA.length}`);
  }

  console.log('Gate D (Gate A + targetSpan>=0.55 + recalibrated Model B order, of Gate B-existing population):');
  for (const orderThreshold of [0.4, 0.45, 0.5, 0.55]) {
    const passing = gateBExisting.filter((c) => c.recalibratedOrderModelB >= orderThreshold);
    console.log(`  order>=${orderThreshold}: ${passing.length}/${gateBExisting.length}`);
  }

  console.log('');
  console.log('=== PART 9: TARGETSPAN-ONLY PROTECTION ===');
  const spanOnlyRejected = candidates.filter((c) => c.physicalPass && c.letterCompleteness.complete && c.sequence.sequenceValid && !c.targetSpanPass);
  console.log(`physical=true, completeness=true, sequence=true, targetSpan=FAIL: ${spanOnlyRejected.length}/${candidates.length}`);
  for (const c of spanOnlyRejected) {
    const d = c.decomposition;
    console.log(
      `  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: targetSpan=${d.targetSpan.toFixed(3)} shapeScore=${c.shapeScore.toFixed(3)} meanRawInk=${c.meanRawInk.toFixed(3)} largestTargetGap=${d.largestTargetGap.toFixed(3)} naiveSpan=${d.naiveSpan.toFixed(3)} spanOccupancy=${d.spanOccupancy.toFixed(3)} -> genuinely bad or over-penalized: ${c.shapeScore >= 0.65 && c.meanRawInk >= 0.8 ? 'LOOKS GOOD — likely over-penalized' : 'plausibly weak'}`,
    );
  }

  const spanPassDespiteFailure = candidates.filter((c) => c.physicalPass && (!c.letterCompleteness.complete || !c.sequence.sequenceValid) && c.targetSpanPass);
  console.log('');
  console.log(`physical=true, (completeness=false OR sequence=false), targetSpan=PASS: ${spanPassDespiteFailure.length}/${candidates.length}`);
  for (const c of spanPassDespiteFailure) {
    console.log(`  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: completeness=${c.letterCompleteness.complete} missingLetters=${JSON.stringify(c.letterCompleteness.missingLetters)} sequenceValid=${c.sequence.sequenceValid} targetSpan=${c.decomposition.targetSpan.toFixed(3)}`);
  }

  return { popACount: popA.length, popBCount: popB.length, popCCount: popC.length, popDCount: popD.length, gateACount: gateA.length, gateBExistingCount: gateBExisting.length, spanOnlyRejectedCount: spanOnlyRejected.length, spanPassDespiteFailureCount: spanPassDespiteFailure.length };
}

async function main() {
  const started = Date.now();
  const scenarios = runAdversarialBattery();

  console.log('');
  const candidates: CorpusCandidate[] = [];
  for (let caseIndex = 0; caseIndex < MULTI_LETTER_CASES.length; caseIndex += 1) {
    const testCase = MULTI_LETTER_CASES[caseIndex]!;
    console.log(`[target-span] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const caseCandidates = await runCase(caseIndex, testCase);
    candidates.push(...caseCandidates);
    console.log(`[target-span] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> ${caseCandidates.length} candidates`);
  }

  try {
    const prior = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'letter-sequence-integrity-diagnostic-results.json'), 'utf8'));
    const priorWords = prior.cases.flatMap((c: { candidates: { word: string }[] }) => c.candidates.map((x) => x.word));
    const newWords = candidates.map((c) => c.word);
    const sameCount = priorWords.length === newWords.length;
    const sameWords = sameCount && priorWords.every((w: string, i: number) => w === newWords[i]);
    console.log('');
    console.log(`[target-span] consistency check vs prior corpus: count ${newWords.length} vs ${priorWords.length} (${sameCount ? 'MATCH' : 'MISMATCH'}), word sequence ${sameWords ? 'MATCH' : 'MISMATCH'}`);
  } catch (err) {
    console.log(`[target-span] consistency check skipped: ${err instanceof Error ? err.message : err}`);
  }

  const summary = analyzeCorpus(candidates);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'target-span-decomposition-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), scenarios, candidates, summary }, null, 2), 'utf8');

  console.log('');
  console.log(`[target-span] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[target-span] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
