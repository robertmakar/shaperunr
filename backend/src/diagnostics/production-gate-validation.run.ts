/**
 * DEVELOPMENT ONLY. Validates the newly-implemented production layered
 * gate (backend/src/generation/experimental-product.ts) against the exact
 * deterministic 78-candidate corpus used throughout the diagnostic
 * investigation that designed it.
 *
 * For every candidate this calls the REAL, now-modified
 * `experimentalProductRejectionReasons` / `meetsExperimentalProductThreshold`
 * directly (not a diagnostic reproduction) to get the NEW gate's decision.
 * The OLD gate's decision (for the before/after comparison the task
 * requires) is reconstructed from `baseRejectionReasons` +
 * `EXPERIMENTAL_PRODUCT.minTargetSpan`/`.minOrder` + the real
 * `identity.traversesMostOfWord` — this is the SAME `shadow-product-gate-
 * evaluator.ts` reproduction that was proven, in three prior tasks'
 * self-tests, to exactly match the real (pre-change) production function
 * on every shared condition. It is used here ONLY because the literal old
 * function no longer exists in the codebase after this task's change.
 *
 * Confirms the production implementation reproduces the diagnostic-
 * predicted 9/78 result. If it does not, this script reports the exact
 * discrepancy rather than silently accepting a different number.
 *
 * Run with: npx tsx src/diagnostics/production-gate-validation.run.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import { experimentalProductRejectionReasons, meetsExperimentalProductThreshold, EXPERIMENTAL_PRODUCT, computeSupportingOrder } from '../generation/experimental-product';
import { baseRejectionReasons, type ShadowGateInput } from './shadow-product-gate-evaluator';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { extractLetterRouteSpans, computeTransitionRecord, type TransitionRecord } from './inter-letter-continuity-diagnostic';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import { runExperimentalPipelineMultiVariant, type ExperimentalPipelineReport, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { scorePolylines } from '../scoring/shape-match';
import type { GeneratedRoute } from '../types';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

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

type CandidateResult = {
  caseIndex: number;
  candidateRank: number;
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  oldGatePasses: boolean;
  oldGateReasons: string[];
  newGatePasses: boolean;
  newGateReasons: string[];
  shapeScore: number;
  coverage: number;
  backtrack: number;
  largestGap: number;
  lengthRatio: number;
  targetSpan: number;
  rawOrder: number;
  recalibratedOrderB: number | null;
};

function analyzeCandidate(word: string, locationName: string, targetDistanceMeters: number, caseIndex: number, item: FeasibilityRecord, start: { latitude: number; longitude: number }): CandidateResult | null {
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

  // The REAL GeneratedRoute this candidate corresponds to — exactly what
  // the production endpoint would evaluate, built the same way every prior
  // task in this investigation built it for cross-referencing.
  const realRoute: GeneratedRoute = best.route;
  const context = { word, targetDistance: targetDistanceMeters };

  const newReasons = experimentalProductRejectionReasons(realRoute, context);
  const newPasses = meetsExperimentalProductThreshold(realRoute, context);

  // Old-gate reconstruction via the proven shadow reproduction.
  const pathPoints = coordinatesToLocalMeters(start, realRoute.shapeCoordinates ?? realRoute.coordinates);
  const scored = scorePolylines(pathPoints, item.target);
  const identity = analyzeTargetIdentity({ route: pathPoints, target: item.target, word, geometryVariant });
  const physical = evaluatePhysicalWordTraversal(word, item.target, pathPoints, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
  const { spans, sampledRoute } = extractLetterRouteSpans(word, item.target, pathPoints, geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));

  const shadowInput: ShadowGateInput = {
    word,
    connected: realRoute.metadata.connected ?? true,
    shapeScore: scored.score,
    coverage: scored.coverage,
    order: scored.breakdown.order,
    backtrack: scored.details.backtrackRatio,
    largestGap: identity.largestTargetGap,
    targetSpan: identity.targetSpan,
    lengthRatio: identity.lengthRatioProjected,
    currentWordTraversal: identity.traversesMostOfWord,
    physical,
    transitions,
  };
  const oldReasons: string[] = [...baseRejectionReasons(shadowInput)];
  if (identity.targetSpan < EXPERIMENTAL_PRODUCT.minTargetSpan) oldReasons.push('targetSpan');
  if (word.replace(/[^A-Za-z]/g, '').length > 1 && !identity.traversesMostOfWord) oldReasons.push('wordTraversal');
  const oldPasses = oldReasons.length === 0;

  const recalibratedOrderB = computeSupportingOrder(realRoute, context);

  return {
    caseIndex,
    candidateRank: item.variantRank ?? -1,
    word,
    locationName,
    targetDistanceMeters,
    oldGatePasses: oldPasses,
    oldGateReasons: oldReasons,
    newGatePasses: newPasses,
    newGateReasons: newReasons,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    largestGap: identity.largestTargetGap,
    lengthRatio: identity.lengthRatioProjected,
    targetSpan: identity.targetSpan,
    rawOrder: scored.breakdown.order,
    recalibratedOrderB,
  };
}

async function runCase(caseIndex: number, testCase: (typeof MULTI_LETTER_CASES)[number]): Promise<CandidateResult[]> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);
  return feasible
    .map((item) => analyzeCandidate(testCase.word, testCase.locationName, testCase.targetDistanceMeters, caseIndex, item, testCase.start))
    .filter((record): record is CandidateResult => record !== null);
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

async function main() {
  const started = Date.now();
  const candidates: CandidateResult[] = [];
  for (let caseIndex = 0; caseIndex < MULTI_LETTER_CASES.length; caseIndex += 1) {
    const testCase = MULTI_LETTER_CASES[caseIndex]!;
    console.log(`[production-gate-validation] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const caseCandidates = await runCase(caseIndex, testCase);
    candidates.push(...caseCandidates);
    console.log(`[production-gate-validation] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> ${caseCandidates.length} candidates`);
  }

  console.log('');
  console.log(`=== PRODUCTION GATE VALIDATION (n=${candidates.length}) ===`);
  const oldPassCount = candidates.filter((c) => c.oldGatePasses).length;
  const newPassCount = candidates.filter((c) => c.newGatePasses).length;
  const oldFailNewPass = candidates.filter((c) => !c.oldGatePasses && c.newGatePasses);
  const oldPassNewFail = candidates.filter((c) => c.oldGatePasses && !c.newGatePasses);
  console.log(`Old gate PASS: ${oldPassCount}/${candidates.length}`);
  console.log(`New gate PASS: ${newPassCount}/${candidates.length}`);
  console.log(`Old FAIL -> New PASS: ${oldFailNewPass.length}/${candidates.length}`);
  console.log(`Old PASS -> New FAIL (regressions): ${oldPassNewFail.length}/${candidates.length}`);

  console.log('');
  console.log('--- Old FAIL -> New PASS candidates ---');
  for (const c of oldFailNewPass) {
    console.log(`  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: oldReasons=${JSON.stringify(c.oldGateReasons)} shapeScore=${c.shapeScore.toFixed(3)} coverage=${c.coverage.toFixed(3)} backtrack=${c.backtrack.toFixed(3)} targetSpan=${c.targetSpan.toFixed(3)} rawOrder=${c.rawOrder.toFixed(3)}`);
  }
  if (oldPassNewFail.length > 0) {
    console.log('');
    console.log('--- REGRESSIONS: Old PASS -> New FAIL (should be empty) ---');
    for (const c of oldPassNewFail) {
      console.log(`  ${c.word} [case ${c.caseIndex} rank ${c.candidateRank}]: newReasons=${JSON.stringify(c.newGateReasons)}`);
    }
  }

  console.log('');
  console.log('--- New gate rejection reason breakdown (new FAILs) ---');
  const newFail = candidates.filter((c) => !c.newGatePasses);
  const reasonCounts: Record<string, number> = {};
  for (const c of newFail) for (const r of c.newGateReasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  console.log(JSON.stringify(reasonCounts, null, 2));

  console.log('');
  console.log('--- Order / targetSpan distributions (diagnostics only, not gated) ---');
  console.log(`mean rawOrder: ${mean(candidates.map((c) => c.rawOrder)).toFixed(4)}`);
  console.log(`mean recalibratedOrderB: ${mean(candidates.map((c) => c.recalibratedOrderB ?? 0)).toFixed(4)}`);
  console.log(`mean targetSpan: ${mean(candidates.map((c) => c.targetSpan)).toFixed(4)}`);

  console.log('');
  const expectedNine = newPassCount === 9;
  const expectedZeroRegressions = oldPassNewFail.length === 0;
  const expectedNineTransitions = oldFailNewPass.length === 9;
  console.log(`Expected ~9/78 accepted: ${expectedNine ? 'CONFIRMED' : `DISCREPANCY — got ${newPassCount}, investigate before proceeding`}`);
  console.log(`Expected 0 regressions: ${expectedZeroRegressions ? 'CONFIRMED' : `DISCREPANCY — got ${oldPassNewFail.length}, investigate before proceeding`}`);
  console.log(`Expected 9/9 old-fail-to-new-pass: ${expectedNineTransitions ? 'CONFIRMED' : `DISCREPANCY — got ${oldFailNewPass.length}, investigate before proceeding`}`);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'production-gate-validation-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), candidates, summary: { oldPassCount, newPassCount, oldFailNewPassCount: oldFailNewPass.length, oldPassNewFailCount: oldPassNewFail.length } }, null, 2), 'utf8');

  console.log('');
  console.log(`[production-gate-validation] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[production-gate-validation] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
