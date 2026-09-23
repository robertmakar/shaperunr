/**
 * DEVELOPMENT ONLY. Runs the whole-route order diagnostic:
 * (1) the 8 controlled synthetic scenarios (Step 4/6), and
 * (2) a full decomposition + correlation + threshold-sensitivity pass
 *     over the exact same deterministic 78-candidate checkpoint-v1
 *     corpus used by every prior task in this investigation.
 *
 * Regenerates the same deterministic candidates (proven byte-identical
 * across repeated runs) since this task's decomposition needs fresh route
 * geometry (progress sequences, negative steps) never persisted before.
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate.
 *
 * Run with: npx tsx src/diagnostics/whole-route-order-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import {
  computeWholeRouteOrder,
  extractWholeRouteProgressSequence,
  findWholeRouteNegativeSteps,
  evaluatePhysicalWordTraversal,
  PHYSICAL_TRAVERSAL_DEFAULTS,
} from './whole-route-order-diagnostic';
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
import { analyzeTargetIdentity } from '../generation/target-identity';
import { scorePolylines } from '../scoring/shape-match';
import { buildWalkableWordShape } from '../generation/walkable-target';

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

// ---------------------------------------------------------------------------
// Step 4/6 — 8 controlled synthetic scenarios
// ---------------------------------------------------------------------------

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

function runSyntheticScenarios() {
  console.log('=== SYNTHETIC SCENARIOS A-H ===');
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const target = robzShape.points;

  // A. Perfect geometric traversal.
  const perfectRoute = densify(target, 6);
  const a = computeWholeRouteOrder(perfectRoute, target);
  console.log(`A. Perfect traversal: order=${a.order.toFixed(4)} dtw=${a.dtwFit.toFixed(4)} progress=${a.progressFit.toFixed(4)} direction=${a.directionFit.toFixed(4)}`);

  // B. Same with realistic small street-style detours (bounded random-like offset, deterministic).
  const detourRoute = perfectRoute.map((p, i) => ({ x: p.x + Math.sin(i * 0.7) * 0.02, y: p.y + Math.cos(i * 0.5) * 0.02 }));
  const b = computeWholeRouteOrder(detourRoute, target);
  console.log(`B. Realistic street detours: order=${b.order.toFixed(4)} dtw=${b.dtwFit.toFixed(4)} progress=${b.progressFit.toFixed(4)} direction=${b.directionFit.toFixed(4)}`);

  // C. Right-angle/Manhattan-style turns approximating the same path.
  const manhattanRoute: Vec2[] = [];
  for (let i = 0; i < perfectRoute.length - 1; i += 1) {
    const p = perfectRoute[i]!;
    const next = perfectRoute[i + 1]!;
    manhattanRoute.push(p, { x: next.x, y: p.y });
  }
  manhattanRoute.push(perfectRoute[perfectRoute.length - 1]!);
  const c = computeWholeRouteOrder(manhattanRoute, target);
  console.log(`C. Manhattan right-angle turns: order=${c.order.toFixed(4)} dtw=${c.dtwFit.toFixed(4)} progress=${c.progressFit.toFixed(4)} direction=${c.directionFit.toFixed(4)}`);

  // D. Correct sequence but a temporary spatial "peek" toward a later letter.
  const zLetter = robzShape.letters[3]!.points;
  const peekIndex = Math.floor(perfectRoute.length * 0.25);
  const peekRoute = [...perfectRoute];
  const peekTarget = zLetter[Math.floor(zLetter.length / 2)]!;
  peekRoute.splice(peekIndex, 0, peekTarget, perfectRoute[peekIndex]!);
  const d = computeWholeRouteOrder(peekRoute, target);
  console.log(`D. Temporary spatial peek toward a later letter (Z) during letter R: order=${d.order.toFixed(4)} dtw=${d.dtwFit.toFixed(4)} progress=${d.progressFit.toFixed(4)} direction=${d.directionFit.toFixed(4)}`);

  // E. Genuinely wrong sequence (full reverse).
  const reversedRoute = [...perfectRoute].reverse();
  const e = computeWholeRouteOrder(reversedRoute, target);
  console.log(`E. Genuinely wrong sequence (reversed): order=${e.order.toFixed(4)} dtw=${e.dtwFit.toFixed(4)} progress=${e.progressFit.toFixed(4)} direction=${e.directionFit.toFixed(4)}`);

  // F. Legitimate crossing/self-intersection (route loops back through an earlier point once, then continues forward).
  const crossingRoute = [...perfectRoute.slice(0, Math.floor(perfectRoute.length * 0.6)), perfectRoute[Math.floor(perfectRoute.length * 0.2)]!, ...perfectRoute.slice(Math.floor(perfectRoute.length * 0.6))];
  const f = computeWholeRouteOrder(crossingRoute, target);
  console.log(`F. Legitimate crossing/self-intersection: order=${f.order.toFixed(4)} dtw=${f.dtwFit.toFixed(4)} progress=${f.progressFit.toFixed(4)} direction=${f.directionFit.toFixed(4)}`);

  // G. Uneven sampling density (dense cluster early, sparse later) of the SAME underlying path.
  const unevenRoute: Vec2[] = [];
  for (let i = 0; i < perfectRoute.length; i += 1) {
    unevenRoute.push(perfectRoute[i]!);
    if (i < perfectRoute.length * 0.3) unevenRoute.push(perfectRoute[i]!); // duplicate-ish dense cluster early
  }
  const g = computeWholeRouteOrder(unevenRoute, target);
  console.log(`G. Uneven sampling density (same path, resamplePolyline normalizes to 80 either way): order=${g.order.toFixed(4)} dtw=${g.dtwFit.toFixed(4)} progress=${g.progressFit.toFixed(4)} direction=${g.directionFit.toFixed(4)} (compare to A: ${a.order.toFixed(4)})`);

  // H. A curved letter (O) represented using right-angle segments.
  const oShape = buildWalkableWordShape('O', { letterVariant: 'smooth' });
  const oTarget = oShape.points;
  const oPerfect = densify(oTarget, 6);
  const oManhattan: Vec2[] = [];
  for (let i = 0; i < oPerfect.length - 1; i += 1) {
    const p = oPerfect[i]!;
    const next = oPerfect[i + 1]!;
    oManhattan.push(p, { x: next.x, y: p.y });
  }
  oManhattan.push(oPerfect[oPerfect.length - 1]!);
  const hPerfect = computeWholeRouteOrder(oPerfect, oTarget);
  const hManhattan = computeWholeRouteOrder(oManhattan, oTarget);
  console.log(`H. Curved letter (O) — perfect: order=${hPerfect.order.toFixed(4)}; right-angle approximation: order=${hManhattan.order.toFixed(4)} dtw=${hManhattan.dtwFit.toFixed(4)} progress=${hManhattan.progressFit.toFixed(4)} direction=${hManhattan.directionFit.toFixed(4)}`);

  return { a, b, c, d, e, f, g, hPerfect, hManhattan };
}

// ---------------------------------------------------------------------------
// Full 78-candidate corpus: decomposition + correlation data
// ---------------------------------------------------------------------------

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  word: string;
  wholeRouteOrder: ReturnType<typeof computeWholeRouteOrder>;
  progressSampleCount: number;
  negativeStepCount: number;
  negativeStepMagnitudes: number[];
  shapeScore: number;
  coverage: number;
  physical: ReturnType<typeof evaluatePhysicalWordTraversal>;
  continuityValid: boolean;
  currentWordTraversal: boolean;
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateReport[];
};

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

  const wholeRouteOrder = computeWholeRouteOrder(pathPoints, item.target);
  const progressSamples = extractWholeRouteProgressSequence(pathPoints, item.target);
  const negativeSteps = findWholeRouteNegativeSteps(progressSamples);

  const identity = analyzeTargetIdentity({ route: pathPoints, target: item.target, word, geometryVariant });
  const scored = scorePolylines(pathPoints, item.target);
  const physical = evaluatePhysicalWordTraversal(word, item.target, pathPoints, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);

  const { spans, sampledRoute } = extractLetterRouteSpans(word, item.target, pathPoints, geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  const continuity = evaluateContinuity(transitions, SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio);

  return {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    word,
    wholeRouteOrder,
    progressSampleCount: progressSamples.length,
    negativeStepCount: negativeSteps.length,
    negativeStepMagnitudes: negativeSteps.map((n) => n.magnitude),
    shapeScore: scored.score,
    coverage: scored.coverage,
    physical,
    continuityValid: continuity.continuityValid,
    currentWordTraversal: identity.traversesMostOfWord,
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
  runSyntheticScenarios();

  console.log('');
  const cases: CaseReport[] = [];
  for (const testCase of MULTI_LETTER_CASES) {
    console.log(`[whole-route-order] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[whole-route-order] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'whole-route-order-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[whole-route-order] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[whole-route-order] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
