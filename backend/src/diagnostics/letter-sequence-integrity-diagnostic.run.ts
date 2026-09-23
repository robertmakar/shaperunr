/**
 * DEVELOPMENT ONLY. Runs the letter visitation & sequence integrity
 * diagnostic: (1) the 14 adversarial scenarios A-N reused from the prior
 * two order-metric tasks, now evaluated for sequence integrity instead of
 * (or alongside) whole-route order; (2) a full pass over the exact same
 * deterministic 78-candidate corpus.
 *
 * Regenerates the same deterministic candidates (proven byte-identical
 * across repeated runs) since fresh route geometry is needed.
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate.
 *
 * Run with: npx tsx src/diagnostics/letter-sequence-integrity-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
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
} from './letter-sequence-integrity-diagnostic';
import { computeWholeRouteOrder, evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './whole-route-order-diagnostic';
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

function reportSequence(label: string, word: string, route: Vec2[], target: Vec2[]) {
  const { assignments } = assignRouteSamplesToLetters(word, target, route, 'smooth');
  const blocks = deriveVisitationBlocks(assignments);
  const observed = deriveObservedSequence(blocks);
  const intended = wordLetters(word, 'smooth');
  const integrity = evaluateSequenceIntegrity(observed, intended);
  const order = computeWholeRouteOrder(route, target);
  console.log(`${label}: intended=${intended.join('')} observed=${observed.join('->')} sequenceValid=${integrity.sequenceValid} missing=${JSON.stringify(integrity.missingLetters)} reordered=${JSON.stringify(integrity.reorderedPairs)} hasRevisit=${integrity.hasRevisit} | order=${order.order.toFixed(3)} jumpFit=${order.jumpFit.toFixed(3)}`);
}

function runAdversarialScenarios() {
  console.log('=== ADVERSARIAL SCENARIOS A-N: SEQUENCE INTEGRITY ===');
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const target = robzShape.points;
  const perfectRoute = densify(target, 6);
  const [r, o, b, z] = robzShape.letters.map((l) => densify(l.points, 6));

  reportSequence('A. Perfect traversal', 'ROBZ', perfectRoute, target);

  const detourRoute = perfectRoute.map((p, i) => ({ x: p.x + Math.sin(i * 0.7) * 0.02, y: p.y + Math.cos(i * 0.5) * 0.02 }));
  reportSequence('B. Realistic street detours', 'ROBZ', detourRoute, target);

  const manhattanRoute: Vec2[] = [];
  for (let i = 0; i < perfectRoute.length - 1; i += 1) {
    manhattanRoute.push(perfectRoute[i]!, { x: perfectRoute[i + 1]!.x, y: perfectRoute[i]!.y });
  }
  manhattanRoute.push(perfectRoute[perfectRoute.length - 1]!);
  reportSequence('C. Manhattan right-angle turns', 'ROBZ', manhattanRoute, target);

  const zMid = robzShape.letters[3]!.points[Math.floor(robzShape.letters[3]!.points.length / 2)]!;
  const peekIndex = Math.floor(perfectRoute.length * 0.25);
  const peekRoute = [...perfectRoute];
  peekRoute.splice(peekIndex, 0, zMid, perfectRoute[peekIndex]!);
  reportSequence('D. Temporary spatial peek toward Z during R', 'ROBZ', peekRoute, target);

  reportSequence('E. Genuinely reversed sequence', 'ROBZ', [...perfectRoute].reverse(), target);

  const crossingRoute = [...perfectRoute.slice(0, Math.floor(perfectRoute.length * 0.6)), perfectRoute[Math.floor(perfectRoute.length * 0.2)]!, ...perfectRoute.slice(Math.floor(perfectRoute.length * 0.6))];
  reportSequence('F. Legitimate crossing/self-intersection', 'ROBZ', crossingRoute, target);

  const unevenRoute: Vec2[] = [];
  for (let i = 0; i < perfectRoute.length; i += 1) {
    unevenRoute.push(perfectRoute[i]!);
    if (i < perfectRoute.length * 0.3) unevenRoute.push(perfectRoute[i]!);
  }
  reportSequence('G. Uneven sampling density', 'ROBZ', unevenRoute, target);

  const oShape = buildWalkableWordShape('O', { letterVariant: 'smooth' });
  const oPerfect = densify(oShape.points, 6);
  const oManhattan: Vec2[] = [];
  for (let i = 0; i < oPerfect.length - 1; i += 1) oManhattan.push(oPerfect[i]!, { x: oPerfect[i + 1]!.x, y: oPerfect[i]!.y });
  oManhattan.push(oPerfect[oPerfect.length - 1]!);
  reportSequence('H. Curved letter (O) with right-angle approximation', 'O', oManhattan, oShape.points);

  const iRoute = [...r!, r![r!.length - 1]!, b![Math.floor(b!.length / 2)]!, ...b!];
  reportSequence('I. Skip an entire letter (R directly to B, never O)', 'ROBZ', iRoute, target);

  const jRoute = perfectRoute.map((p, i) => (i > perfectRoute.length * 0.4 && i < perfectRoute.length * 0.5 ? { x: p.x + 0.5, y: p.y + 0.5 } : p));
  reportSequence('J. Correct sequence + large legitimate detour', 'ROBZ', jRoute, target);

  const kRoute = [...r!, ...b!, ...o!, ...z!];
  reportSequence('K. Wrong sequence R->B->O->Z', 'ROBZ', kRoute, target);

  const lRoute = [...r!, ...o!, ...b!, { x: z![0]!.x + 3, y: z![0]!.y + 3 }, ...z!];
  reportSequence('L. Correct sequence + unusually large transition', 'ROBZ', lRoute, target);

  const mRoute = [...densify(robzShape.letters[0]!.points, 3), ...densify(robzShape.letters[1]!.points, 20), ...densify(robzShape.letters[2]!.points, 3), ...densify(robzShape.letters[3]!.points, 3)];
  reportSequence('M. Uneven sampling concentrated around one letter', 'ROBZ', mRoute, target);

  const nRoute = [...o!, ...r!, ...z!, ...b!];
  reportSequence('N. Wrong sequence with small local jumps (O->R->Z->B)', 'ROBZ', nRoute, target);
}

type CandidateReport = {
  candidateRank: number;
  word: string;
  intendedSequence: string[];
  observedSequence: string[];
  sequenceValid: boolean;
  missingLetters: string[];
  reorderedPairs: Array<{ earlier: string; later: string }>;
  hasRevisit: boolean;
  visitationConfidence: ReturnType<typeof computeVisitationConfidence>;
  wholeRouteOrder: number;
  jumpFit: number;
  broadOrderPass: boolean;
  continuityValid: boolean;
  meanRawInk: number;
  currentWordTraversal: boolean;
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

  const { assignments, boundaries } = assignRouteSamplesToLetters(word, item.target, pathPoints, geometryVariant);
  const blocks = deriveVisitationBlocks(assignments);
  const observedSequence = deriveObservedSequence(blocks);
  const intendedSequence = wordLetters(word, geometryVariant);
  const integrity = evaluateSequenceIntegrity(observedSequence, intendedSequence);
  const visitationConfidence = computeVisitationConfidence(boundaries, blocks);

  const order = computeWholeRouteOrder(pathPoints, item.target);
  const identity = analyzeTargetIdentity({ route: pathPoints, target: item.target, word, geometryVariant });
  const scored = scorePolylines(pathPoints, item.target);
  const physical = evaluatePhysicalWordTraversal(word, item.target, pathPoints, geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
  const meanRawInk = physical.letters.length ? physical.letters.reduce((s, l) => s + l.rawInkCoverage, 0) / physical.letters.length : 0;

  const { spans, sampledRoute } = extractLetterRouteSpans(word, item.target, pathPoints, geometryVariant);
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  const continuity = evaluateContinuity(transitions, SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio);

  void scored;
  return {
    candidateRank: item.variantRank ?? -1,
    word,
    intendedSequence,
    observedSequence,
    sequenceValid: integrity.sequenceValid,
    missingLetters: integrity.missingLetters,
    reorderedPairs: integrity.reorderedPairs,
    hasRevisit: integrity.hasRevisit,
    visitationConfidence,
    wholeRouteOrder: order.order,
    jumpFit: order.jumpFit,
    broadOrderPass: physical.lettersInBroadOrder,
    continuityValid: continuity.continuityValid,
    meanRawInk,
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
  runAdversarialScenarios();

  console.log('');
  const cases: CaseReport[] = [];
  for (const testCase of MULTI_LETTER_CASES) {
    console.log(`[letter-sequence] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[letter-sequence] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'letter-sequence-integrity-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[letter-sequence] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[letter-sequence] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
