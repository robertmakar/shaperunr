/**
 * DEVELOPMENT ONLY. Runs the jump-allowance calibration diagnostic:
 * (1) the 14 synthetic scenarios A-N (Step 5), and
 * (2) all 5 jumpAllow models against the exact same deterministic
 *     78-candidate corpus, with boundary classification per candidate.
 *
 * Regenerates the same deterministic candidates (proven byte-identical
 * across repeated runs) since fresh route geometry is needed for the
 * jump-classification decomposition, never persisted before.
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate.
 *
 * Run with: npx tsx src/diagnostics/jump-allowance-calibration-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import {
  computeWholeRouteOrder,
  extractWholeRouteProgressSequence,
  evaluatePhysicalWordTraversal,
  PHYSICAL_TRAVERSAL_DEFAULTS,
} from './whole-route-order-diagnostic';
import {
  classifyProgressJumps,
  extractBoundariesFor,
  evaluateAllJumpModels,
  combineProgressFit,
  combineOrder,
  type JumpAllowModelKey,
} from './jump-allowance-calibration-diagnostic';
import { extractLetterRouteSpans, computeTransitionRecord, type TransitionRecord } from './inter-letter-continuity-diagnostic';
import { evaluateContinuity, SHADOW_CONTINUITY_DEFAULTS } from './shadow-product-gate-evaluator';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { scorePolylines } from '../scoring/shape-match';
import { buildWalkableWordShape } from '../generation/walkable-target';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const MODEL_KEYS: JumpAllowModelKey[] = ['A_current', 'B_perLetterCount', 'C_targetGeometry', 'D_boundaryExempt', 'E_hybrid'];

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

function reportModelsFor(label: string, route: Vec2[], target: Vec2[], word: string) {
  const boundaries = extractBoundariesFor(word, 'smooth');
  const samples = extractWholeRouteProgressSequence(route, target);
  const progress = samples.map((s) => s.progress);
  const real = computeWholeRouteOrder(route, target);
  const models = evaluateAllJumpModels(progress, boundaries, boundaries.length);
  const line = MODEL_KEYS.map((key) => {
    const m = models[key];
    const progressFit = combineProgressFit(m.monotonicFit, m.jumpFit, m.revisitFit);
    const order = combineOrder(real.dtwFit, progressFit, real.directionFit);
    return `${key}:order=${order.toFixed(3)}(jumpFit=${m.jumpFit.toFixed(2)})`;
  }).join(' ');
  console.log(`${label}: real.order=${real.order.toFixed(4)} | ${line}`);
}

function runSyntheticAdversarialScenarios() {
  console.log('=== ADVERSARIAL SYNTHETIC SCENARIOS I-N ===');
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const target = robzShape.points;
  const perfectRoute = densify(target, 6);

  // I. Skip from letter 1 (R) directly toward letter 3 (B), never visiting O.
  const rEnd = robzShape.letters[0]!.points[robzShape.letters[0]!.points.length - 1]!;
  const bMid = robzShape.letters[2]!.points[Math.floor(robzShape.letters[2]!.points.length / 2)]!;
  const bRoute = densify(robzShape.letters[2]!.points, 6);
  const iRoute = [...densify(robzShape.letters[0]!.points, 6), rEnd, bMid, ...bRoute];
  reportModelsFor('I. Skip R directly to B (never visiting O)', iRoute, target, 'ROBZ');

  // J. Correct sequence R->O->B->Z, but with a large legitimate street-network detour mid-route.
  const jRoute = perfectRoute.map((p, i) => (i > perfectRoute.length * 0.4 && i < perfectRoute.length * 0.5 ? { x: p.x + 0.5, y: p.y + 0.5 } : p));
  reportModelsFor('J. Correct sequence with one large legitimate mid-route detour', jRoute, target, 'ROBZ');

  // K. Wrong sequence: R -> B -> O -> Z.
  const kRoute = [...densify(robzShape.letters[0]!.points, 4), ...densify(robzShape.letters[2]!.points, 4), ...densify(robzShape.letters[1]!.points, 4), ...densify(robzShape.letters[3]!.points, 4)];
  reportModelsFor('K. Wrong sequence R->B->O->Z', kRoute, target, 'ROBZ');

  // L. Correct sequence with one unusually large legitimate inter-letter transition (big scale jump between B and Z).
  const lRoute = [...densify(robzShape.letters[0]!.points, 4), ...densify(robzShape.letters[1]!.points, 4), ...densify(robzShape.letters[2]!.points, 4), { x: robzShape.letters[3]!.points[0]!.x + 3, y: robzShape.letters[3]!.points[0]!.y + 3 }, ...densify(robzShape.letters[3]!.points, 4)];
  reportModelsFor('L. Correct sequence, one unusually large legitimate transition', lRoute, target, 'ROBZ');

  // M. Correct sequence with unusually dense sampling concentrated around one letter (O).
  const mRoute = [...densify(robzShape.letters[0]!.points, 3), ...densify(robzShape.letters[1]!.points, 20), ...densify(robzShape.letters[2]!.points, 3), ...densify(robzShape.letters[3]!.points, 3)];
  reportModelsFor('M. Correct sequence, unusually dense sampling around O', mRoute, target, 'ROBZ');

  // N. Incorrect sequence whose jumps happen to fall within a relaxed allowance (small letters visited out of order with SMALL jumps between them).
  const nRoute = [...densify(robzShape.letters[1]!.points, 4), ...densify(robzShape.letters[0]!.points, 4), ...densify(robzShape.letters[3]!.points, 4), ...densify(robzShape.letters[2]!.points, 4)];
  reportModelsFor('N. Incorrect sequence O->R->Z->B (small local jumps, wrong order)', nRoute, target, 'ROBZ');
}

type CandidateReport = {
  candidateRank: number;
  word: string;
  realOrder: number;
  realJumpFit: number;
  jumpClassificationCounts: Record<string, number>;
  models: Record<JumpAllowModelKey, { jumpFit: number; order: number; skipAmount: number }>;
  shapeScore: number;
  meanRawInk: number;
  broadOrderPass: boolean;
  continuityValid: boolean;
};

type CaseReport = { word: string; locationName: string; targetDistanceMeters: number; graphFeasibleCount: number; candidates: CandidateReport[] };

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
  if (pathPoints.length < 2) return null;

  const boundaries = extractBoundariesFor(word, geometryVariant);
  const samples = extractWholeRouteProgressSequence(pathPoints, item.target);
  const progress = samples.map((s) => s.progress);
  const real = computeWholeRouteOrder(pathPoints, item.target);
  const jumps = classifyProgressJumps(samples, boundaries, 4 / 79);
  const jumpClassificationCounts: Record<string, number> = { A_expected_transition: 0, B_within_letter: 0, C_potentially_incorrect: 0 };
  for (const j of jumps) jumpClassificationCounts[j.classification] = (jumpClassificationCounts[j.classification] ?? 0) + 1;

  const modelResults = evaluateAllJumpModels(progress, boundaries, boundaries.length);
  const models = {} as CandidateReport['models'];
  for (const key of MODEL_KEYS) {
    const m = modelResults[key];
    const progressFit = combineProgressFit(m.monotonicFit, m.jumpFit, m.revisitFit);
    const order = combineOrder(real.dtwFit, progressFit, real.directionFit);
    models[key] = { jumpFit: m.jumpFit, order, skipAmount: m.skipAmount };
  }

  const scored = scorePolylines(pathPoints, item.target);
  const physical = evaluatePhysicalWordTraversal(word, item.target, pathPoints, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
  const meanRawInk = physical.letters.length ? physical.letters.reduce((s, l) => s + l.rawInkCoverage, 0) / physical.letters.length : 0;

  const { spans, sampledRoute } = extractLetterRouteSpans(word, item.target, pathPoints, geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  const continuity = evaluateContinuity(transitions, SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio);

  return {
    candidateRank: item.variantRank ?? -1,
    word,
    realOrder: real.order,
    realJumpFit: real.jumpFit,
    jumpClassificationCounts,
    models,
    shapeScore: scored.score,
    meanRawInk,
    broadOrderPass: physical.lettersInBroadOrder,
    continuityValid: continuity.continuityValid,
  };
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

async function main() {
  const started = Date.now();
  runSyntheticAdversarialScenarios();

  console.log('');
  const cases: CaseReport[] = [];
  for (const testCase of MULTI_LETTER_CASES) {
    console.log(`[jump-allowance] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[jump-allowance] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'jump-allowance-calibration-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[jump-allowance] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[jump-allowance] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
