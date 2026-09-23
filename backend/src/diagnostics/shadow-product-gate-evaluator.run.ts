/**
 * DEVELOPMENT ONLY. Runs the shadow product-gate comparison (current gate
 * vs Shadow A vs Shadow B) against the exact real 78-candidate multi-
 * letter corpus, plus a small end-to-end check on L/O/R/ROBZ/CAIRO.
 *
 * Regenerates the exact same 78 checkpoint-v1 candidates deterministically
 * (proven byte-identical across repeated runs on identical input in an
 * earlier self-test) — this is required because this task needs several
 * fields (order, largestGap, lengthRatio, connected, full transition
 * geometry) never all persisted together by any prior task; it is not new
 * or different data.
 *
 * Uses the REAL, unmodified experimentalProductRejectionReasons() for the
 * "current gate" baseline (byte-identical reuse, not reimplementation),
 * and the new evaluateShadowGateA/evaluateShadowGateB for the shadow
 * comparisons. Never modifies production.
 *
 * Run with: npx tsx src/diagnostics/shadow-product-gate-evaluator.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';
import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters, offsetCoordinate } from '@/lib/shape-projection';

import { evaluateShadowGateA, evaluateShadowGateB, SHADOW_CONTINUITY_DEFAULTS } from './shadow-product-gate-evaluator';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { extractLetterRouteSpans, computeTransitionRecord, type TransitionRecord } from './inter-letter-continuity-diagnostic';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { scorePolylines, shapeScoreBreakdown } from '../scoring/shape-match';
import { experimentalProductRejectionReasons } from '../generation/experimental-product';
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

function buildRouteForGate(word: string, pathPoints: Vec2[], target: readonly Vec2[], geometryVariant: 'smooth' | 'angular' | 'hybrid'): GeneratedRoute {
  const anchor: Coordinate = { latitude: 30.0, longitude: 31.0 };
  const toGeo = (p: Vec2) => offsetCoordinate(anchor, p.x, p.y);
  const shapeGeo = pathPoints.map(toGeo);
  const targetGeo = target.map(toGeo);
  const scored = scorePolylines(pathPoints, target);
  const identity = analyzeTargetIdentity({ route: pathPoints, target, word, geometryVariant });
  return {
    id: 'shadow-gate-check',
    source: 'valhalla',
    developmentOnly: true,
    coordinates: shapeGeo,
    targetCoordinates: targetGeo,
    shapeCoordinates: shapeGeo,
    connectorCoordinates: [],
    distanceMeters: 0,
    shapeScore: scored.score,
    coverage: scored.coverage,
    scoreBreakdown: shapeScoreBreakdown(scored),
    metadata: {
      rotationDegrees: 0,
      scale: 1,
      placement: 'start-anchored',
      offsetAcrossMeters: 0,
      method: 'graph_constrained',
      connectedFromStart: true,
      connected: true,
      backtrackRatio: scored.details.backtrackRatio,
      score: scored,
      startSnapDistanceMeters: 0,
      lengthError: 0,
      distanceError: 0,
      detourRatio: 0,
      largestGap: identity.largestTargetGap,
      geometryVariant,
    },
  };
}

type CandidateReport = {
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
  physical: ReturnType<typeof evaluatePhysicalWordTraversal>;
  transitions: TransitionRecord[];
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateReport[];
};

/** Shared analysis for any already-computed route (checkpoint-v1 for multi-letter words, or the existing production beam route for single-letter words — see analyzeCandidateProduction) against the current gate and both shadow gates. */
function analyzeRoute(word: string, pathPoints: Vec2[], target: readonly Vec2[], geometryVariant: 'smooth' | 'angular' | 'hybrid', candidateRank: number): CandidateReport | null {
  if (pathPoints.length < 2 || target.length < 2) return null;

  const identity = analyzeTargetIdentity({ route: pathPoints, target, word, geometryVariant });
  const scored = scorePolylines(pathPoints, target);
  const physical = evaluatePhysicalWordTraversal(word, target, pathPoints, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);

  const { spans, sampledRoute } = extractLetterRouteSpans(word, target, pathPoints, geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));

  const routeForGate = buildRouteForGate(word, pathPoints, target, geometryVariant);
  const currentGateReasons = experimentalProductRejectionReasons(routeForGate, { word });

  const gateInput = {
    word,
    connected: true,
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
  const shadowA = evaluateShadowGateA(gateInput);
  const shadowB = evaluateShadowGateB(gateInput, SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio);

  return {
    candidateRank,
    geometryVariant,
    word,
    shapeScore: scored.score,
    coverage: scored.coverage,
    order: scored.breakdown.order,
    backtrack: scored.details.backtrackRatio,
    largestGap: identity.largestTargetGap,
    targetSpan: identity.targetSpan,
    lengthRatio: identity.lengthRatioProjected,
    currentWordTraversal: identity.traversesMostOfWord,
    currentGatePasses: currentGateReasons.length === 0,
    currentGateReasons,
    shadowAPasses: shadowA.passes,
    shadowAReasons: shadowA.reasons,
    shadowBPasses: shadowB.passes,
    shadowBReasons: shadowB.reasons,
    physical,
    transitions,
  };
}

function analyzeCandidate(word: string, item: FeasibilityRecord, start: { latitude: number; longitude: number }): CandidateReport | null {
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
  return analyzeRoute(word, pathPoints, item.target, geometryVariant, item.variantRank ?? -1);
}

/** Single-letter words: checkpoint-v1 is multi-letter-only by design (generateCheckpointRoutes returns eligible=false for these), so this evaluates the EXISTING production beam route (FeasibilityRecord.pathPoints, already the real routeGraphConstrainedShape() output the pipeline computed) instead — the relevant route for single-letter semantics is production's own, not checkpoint-v1's. */
function analyzeCandidateProduction(word: string, item: FeasibilityRecord): CandidateReport | null {
  const geometryVariant = item.geometryVariant ?? 'smooth';
  return analyzeRoute(word, item.pathPoints, item.target, geometryVariant, item.variantRank ?? -1);
}

async function runCase(testCase: (typeof MULTI_LETTER_CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);
  const candidates = feasible
    .map((item) => analyzeCandidate(testCase.word, item, testCase.start))
    .filter((record): record is CandidateReport => record !== null);
  return { word: testCase.word, locationName: testCase.locationName, targetDistanceMeters: testCase.targetDistanceMeters, graphFeasibleCount: feasible.length, candidates };
}

// --- Step 11: small end-to-end check on representative words ---
const END_TO_END_CASES: Array<{ word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number }> = [
  { word: 'L', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'O', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'R', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
];

async function runEndToEndCase(testCase: (typeof END_TO_END_CASES)[number]): Promise<{ word: string; graphFeasibleCount: number; currentGatePasses: number; shadowAPasses: number; shadowBPasses: number; total: number }> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);
  const isMultiLetter = testCase.word.replace(/[^A-Za-z]/g, '').length > 1;
  const candidates = feasible
    .map((item) => (isMultiLetter ? analyzeCandidate(testCase.word, item, testCase.start) : analyzeCandidateProduction(testCase.word, item)))
    .filter((record): record is CandidateReport => record !== null);
  return {
    word: testCase.word,
    graphFeasibleCount: feasible.length,
    currentGatePasses: candidates.filter((c) => c.currentGatePasses).length,
    shadowAPasses: candidates.filter((c) => c.shadowAPasses).length,
    shadowBPasses: candidates.filter((c) => c.shadowBPasses).length,
    total: candidates.length,
  };
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of MULTI_LETTER_CASES) {
    console.log(`[shadow-product-gate] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[shadow-product-gate] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  const endToEnd = [];
  for (const testCase of END_TO_END_CASES) {
    console.log(`[shadow-product-gate] end-to-end ${testCase.word}...`);
    const result = await runEndToEndCase(testCase);
    endToEnd.push(result);
    console.log(`[shadow-product-gate] end-to-end done ${testCase.word} -> ${JSON.stringify(result)}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'shadow-product-gate-evaluator-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), continuityDefaults: SHADOW_CONTINUITY_DEFAULTS, physicalDefaults: PHYSICAL_TRAVERSAL_DEFAULTS, cases, endToEnd }, null, 2), 'utf8');

  console.log('');
  console.log(`[shadow-product-gate] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[shadow-product-gate] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
