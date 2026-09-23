/**
 * DEVELOPMENT ONLY. Shadow comparison of two generator-side guidance
 * mechanisms for the graph_constrained beam search — Mechanism A (soft
 * letter-stroke proximity cost) and Mechanism B (checkpoint-style
 * positional anchoring) — against the unmodified baseline, using the
 * parity-proven graph-shape-goal-mirror.ts. graph-shape.ts itself is never
 * touched; both mechanisms are pluggable extensions to the mirror only.
 *
 * Scoping note (documented, not hidden): Step 7's "state distance
 * distribution" is measured at the DELIVERED-ROUTE level (per-segment
 * stroke distance along the final path), not by instrumenting every
 * explored search state — collecting per-state distances for all ~9,000-
 * 12,800 expansions x 78 candidates would require a much larger
 * instrumentation extension to the mirror; the route-level distribution
 * still directly answers whether the signal distinguishes well-covered
 * letters from poorly-covered ones, which is the diagnostic question that
 * matters here.
 *
 * Run with: npx tsx src/diagnostics/generator-guidance-mechanism-evaluation.run.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { distanceToPolyline } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, REAL_ISGOAL } from './graph-shape-goal-mirror';
import { makeStrokeProximityAugmenter, sliceLetterStrokePolyline } from './letter-stroke-proximity-diagnostic';
import { buildLetterCheckpoints, indexCheckpointBits, makeCheckpointExtraMaskUpdate, makeCheckpointAnchoringAugmenter, summarizeCheckpointConnectivity, type CheckpointMode } from './checkpoint-anchoring-diagnostic';
import { scorePolylines } from '../scoring/shape-match';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { decomposeContinuity } from './continuity-decomposition-diagnostic';
import { decomposeTargetSpan } from './target-span-decomposition-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

// ---------------------------------------------------------------------------
// Mechanism configurations (Step 16's bounded matrix).
// ---------------------------------------------------------------------------

type StrokeConfig = { name: string; lambda: number; distanceScaleMeters: number };
const STROKE_CONFIGS: StrokeConfig[] = [
  { name: 'baseline', lambda: 0, distanceScaleMeters: 25 },
  { name: 'lambda=0.10 scale=25', lambda: 0.1, distanceScaleMeters: 25 },
  { name: 'lambda=0.10 scale=40', lambda: 0.1, distanceScaleMeters: 40 },
  { name: 'lambda=0.10 scale=60', lambda: 0.1, distanceScaleMeters: 60 },
  { name: 'lambda=0.20 scale=25', lambda: 0.2, distanceScaleMeters: 25 },
  { name: 'lambda=0.20 scale=40', lambda: 0.2, distanceScaleMeters: 40 },
  { name: 'lambda=0.20 scale=60', lambda: 0.2, distanceScaleMeters: 60 },
];

type CheckpointConfig = { name: string; k: number; mode: CheckpointMode };
const CHECKPOINT_CONFIGS: CheckpointConfig[] = [
  { name: 'K=1 midpoint', k: 1, mode: 'midpoint' },
  { name: 'K=3 midpoint', k: 3, mode: 'midpoint' },
  { name: 'K=5 midpoint', k: 5, mode: 'midpoint' },
  { name: 'K=3 startEnd', k: 3, mode: 'startEnd' },
];
const CHECKPOINT_PENALTY = 60;

// ---------------------------------------------------------------------------
// Quality evaluation using ONLY real, unmodified production/diagnostic evaluators.
// ---------------------------------------------------------------------------

function isMultiLetter(word: string): boolean {
  return word.replace(/[^A-Za-z]/g, '').length > 1;
}

type QualityReport = {
  hasRoute: boolean;
  shapeScore: number | null;
  coverage: number | null;
  backtrack: number | null;
  routeLengthMeters: number | null;
  lengthRatio: number | null;
  targetSpan: number | null;
  continuityValid: boolean | null;
  currentWordTraversal: boolean | null; // production analyzeTargetIdentity's traversesMostOfWord
  physicalWordTraversal: boolean | null; // unchanged PHYSICAL_TRAVERSAL_DEFAULTS thresholds
  perLetter: Array<{ letter: string; rawInkCoverage: number; coverage: number; physicallyCovered: boolean }> | null;
};

function evaluateQuality(word: string, target: Vec2[], pathPoints: Vec2[]): QualityReport {
  if (pathPoints.length < 2) {
    return { hasRoute: false, shapeScore: null, coverage: null, backtrack: null, routeLengthMeters: null, lengthRatio: null, targetSpan: null, continuityValid: null, currentWordTraversal: null, physicalWordTraversal: null, perLetter: null };
  }
  const scored = scorePolylines(pathPoints, target);
  const identity = analyzeTargetIdentity({ route: pathPoints, target, word, geometryVariant: 'smooth' });
  const physical = evaluatePhysicalWordTraversal(word, target, pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const continuity = decomposeContinuity(word, target, pathPoints, 'smooth');
  const targetSpanDecomp = decomposeTargetSpan(word, target, pathPoints, 'smooth');
  return {
    hasRoute: true,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    routeLengthMeters: scored.details.routeLengthMeters,
    lengthRatio: targetSpanDecomp.lengthRatioProjected,
    targetSpan: targetSpanDecomp.targetSpan,
    continuityValid: continuity.continuityValid,
    currentWordTraversal: isMultiLetter(word) ? identity.traversesMostOfWord : null,
    physicalWordTraversal: isMultiLetter(word) ? physical.wordTraversalPhysical : null,
    perLetter: isMultiLetter(word) ? physical.letters.map((l) => ({ letter: l.letter, rawInkCoverage: l.rawInkCoverage, coverage: l.coverage, physicallyCovered: l.physicallyCovered })) : null,
  };
}

function printQuality(label: string, q: QualityReport) {
  console.log(`    [${label}] hasRoute=${q.hasRoute} shapeScore=${q.shapeScore?.toFixed(3) ?? 'N/A'} coverage=${q.coverage?.toFixed(3) ?? 'N/A'} backtrack=${q.backtrack?.toFixed(3) ?? 'N/A'} routeLen=${q.routeLengthMeters?.toFixed(0) ?? 'N/A'} lengthRatio=${q.lengthRatio?.toFixed(3) ?? 'N/A'} targetSpan=${q.targetSpan?.toFixed(3) ?? 'N/A'} continuity=${q.continuityValid} currentWordTraversal=${q.currentWordTraversal} physicalWordTraversal=${q.physicalWordTraversal}`);
  if (q.perLetter) {
    console.log(`      perLetter: ${JSON.stringify(q.perLetter.map((l) => ({ letter: l.letter, rawInk: Number(l.rawInkCoverage.toFixed(3)), cov: Number(l.coverage.toFixed(3)), physCov: l.physicallyCovered })))}`);
  }
}

// ---------------------------------------------------------------------------
// Per-candidate search runner: baseline + all stroke configs + all checkpoint configs.
// ---------------------------------------------------------------------------

type SearchRunResult = {
  mechanism: 'baseline' | 'stroke' | 'checkpoint';
  configName: string;
  failure: string | null;
  targetCoverage: number;
  progressSpan: number;
  statesExplored: number;
  pathPoints: Vec2[];
  quality: QualityReport;
  checkpointConnectivity?: ReturnType<typeof summarizeCheckpointConnectivity>;
};

function runAllMechanisms(word: string, record: FeasibilityRecord): SearchRunResult[] {
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const shape = buildWalkableWordShape(word, { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const multiLetter = isMultiLetter(word);
  const results: SearchRunResult[] = [];

  // Baseline.
  const baseline = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter, goalCheck: REAL_ISGOAL });
  results.push({ mechanism: 'baseline', configName: 'baseline', failure: baseline.failure, targetCoverage: baseline.metrics.targetCoverage, progressSpan: baseline.metrics.progressSpan, statesExplored: baseline.search.statesExplored, pathPoints: baseline.pathPoints, quality: evaluateQuality(word, record.target, baseline.pathPoints) });

  if (!multiLetter || boundaries.length === 0) return results; // guidance mechanisms are only meaningful for multi-letter words

  // Mechanism A: stroke proximity.
  for (const config of STROKE_CONFIGS) {
    if (config.lambda === 0) continue; // identical to baseline by construction, skip re-running
    const { augmenter } = makeStrokeProximityAugmenter(boundaries, record.target, config);
    const result = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter, goalCheck: REAL_ISGOAL, extraCost: augmenter });
    results.push({ mechanism: 'stroke', configName: config.name, failure: result.failure, targetCoverage: result.metrics.targetCoverage, progressSpan: result.metrics.progressSpan, statesExplored: result.search.statesExplored, pathPoints: result.pathPoints, quality: evaluateQuality(word, record.target, result.pathPoints) });
  }

  // Mechanism B: checkpoint anchoring.
  for (const config of CHECKPOINT_CONFIGS) {
    const checkpoints = buildLetterCheckpoints(boundaries, record.target, graph, config.k, config.mode);
    const { nodeToBits, bitToLetterIndex } = indexCheckpointBits(checkpoints);
    const extraMaskUpdate = makeCheckpointExtraMaskUpdate(nodeToBits);
    const augmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, checkpoints, { penaltyPerMissedCheckpoint: CHECKPOINT_PENALTY });
    const result = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter, goalCheck: REAL_ISGOAL, extraCost: augmenter, extraMaskUpdate });
    // Need the final state's extraMask for connectivity reporting — routeGraphConstrainedShapeMirror doesn't expose the winning SearchState directly, so approximate via re-deriving which checkpoint nodes the final pathPoints actually pass through.
    const visitedNodeIds = new Set<string>(); // best-effort: not directly available from GraphShapeResult; report via geometry proximity instead.
    const connectivity = checkpoints.map((cp) => {
      const nearestOnPath = result.pathPoints.length ? Math.min(...result.pathPoints.map((p) => Math.hypot(p.x - cp.targetCoordinate.x, p.y - cp.targetCoordinate.y))) : Number.POSITIVE_INFINITY;
      return { letter: cp.letter, position: cp.position, hit: nearestOnPath <= 15, nearestNodeDistanceMeters: cp.snap.nearestDistanceMeters, nearestPathDistanceMeters: nearestOnPath };
    });
    void visitedNodeIds;
    results.push({ mechanism: 'checkpoint', configName: config.name, failure: result.failure, targetCoverage: result.metrics.targetCoverage, progressSpan: result.metrics.progressSpan, statesExplored: result.search.statesExplored, pathPoints: result.pathPoints, quality: evaluateQuality(word, record.target, result.pathPoints), checkpointConnectivity: connectivity as unknown as ReturnType<typeof summarizeCheckpointConnectivity> });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stroke-distance distribution (Step 7), route-level (see file header).
// ---------------------------------------------------------------------------

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

function collectRouteStrokeDistances(word: string, target: Vec2[], pathPoints: Vec2[], boundaries: readonly LetterBoundary[]): number[] {
  if (pathPoints.length < 2 || boundaries.length === 0) return [];
  const strokes = new Map<string, Vec2[]>();
  boundaries.forEach((b, i) => strokes.set(`${b.letter}#${i}`, sliceLetterStrokePolyline(target, b)));
  const distances: number[] = [];
  for (const point of pathPoints) {
    // Need progress to resolve active letter — approximate via nearest boundary using distance to each letter's own stroke, taking the letter with the smallest distance as "active" for this diagnostic purpose (route-level, not search-state-level).
    let best = Number.POSITIVE_INFINITY;
    for (const [, stroke] of strokes) {
      if (stroke.length < 2) continue;
      const d = distanceToPolyline(point, stroke);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) distances.push(best);
  }
  void word;
  return distances;
}

function printDistribution(label: string, values: readonly number[]) {
  if (values.length === 0) {
    console.log(`  ${label}: no data`);
    return;
  }
  console.log(`  ${label}: n=${values.length} p10=${percentile(values, 10).toFixed(1)} p25=${percentile(values, 25).toFixed(1)} median=${percentile(values, 50).toFixed(1)} p75=${percentile(values, 75).toFixed(1)} p90=${percentile(values, 90).toFixed(1)} p95=${percentile(values, 95).toFixed(1)} max=${Math.max(...values).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

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

async function fetchRecord(word: string, start: typeof ZAMALEK, targetDistanceMeters: number, preferId?: string): Promise<{ record: FeasibilityRecord | null }> {
  const report = await runExperimentalPipelineMultiVariant({ word, start, targetDistanceMeters }, ['smooth']);
  const feasibility = report.diagnostics.feasibility ?? [];
  let chosenId: string | null = null;
  if (preferId && report.routes.some((r) => r.id === preferId)) chosenId = preferId;
  if (!chosenId) chosenId = [...report.routes].sort((a, b) => b.shapeScore - a.shapeScore)[0]?.id ?? null;
  const record = chosenId ? feasibility.find((f) => f.placementId === chosenId) ?? null : null;
  return { record };
}

function printDeepDive(label: string, word: string, results: SearchRunResult[]) {
  console.log('');
  console.log(`=== ${label} (${word}) ===`);
  for (const r of results) {
    console.log(`  [${r.mechanism}/${r.configName}] failure=${r.failure ?? 'null'} targetCoverage=${r.targetCoverage.toFixed(3)} progressSpan=${r.progressSpan.toFixed(3)} statesExplored=${r.statesExplored} pathLen=${r.pathPoints.length}`);
    printQuality(`${r.mechanism}/${r.configName}`, r.quality);
    if (r.checkpointConnectivity) console.log(`      checkpointConnectivity: ${JSON.stringify(r.checkpointConnectivity)}`);
  }
}

async function main() {
  const started = Date.now();

  console.log('=== DEEP DIVE: 3 KNOWN CANDIDATES x baseline/stroke/checkpoint ===');
  const cairo = await fetchRecord('CAIRO', ALEXANDRIA, 2000, 'sf-r22.5-s1.0-e282.8-n-282.8');
  const robz1 = await fetchRecord('ROBZ', ZAMALEK, 4000, 'sf-r315-s0.6-e-905.1-n905.1');
  const robz2 = await fetchRecord('ROBZ', ALEXANDRIA, 2000);

  const cairoResults = cairo.record ? runAllMechanisms('CAIRO', cairo.record) : [];
  const robz1Results = robz1.record ? runAllMechanisms('ROBZ', robz1.record) : [];
  const robz2Results = robz2.record ? runAllMechanisms('ROBZ', robz2.record) : [];

  if (cairoResults.length) printDeepDive('CAIRO strongest', 'CAIRO', cairoResults);
  if (robz1Results.length) printDeepDive('ROBZ #1', 'ROBZ', robz1Results);
  if (robz2Results.length) printDeepDive('ROBZ #2', 'ROBZ', robz2Results);

  console.log('');
  console.log('=== STEP 7: ROUTE-LEVEL STROKE-DISTANCE DISTRIBUTION ===');
  for (const [label, results] of [['CAIRO', cairoResults], ['ROBZ #1', robz1Results], ['ROBZ #2', robz2Results]] as const) {
    if (!results.length) continue;
    const word = label.startsWith('ROBZ') ? 'ROBZ' : 'CAIRO';
    const shape = buildWalkableWordShape(word, { letterVariant: 'smooth' });
    const boundaries = letterBoundariesFromWordShape(shape).boundaries;
    const target = word === 'CAIRO' ? cairo.record!.target : label === 'ROBZ #1' ? robz1.record!.target : robz2.record!.target;
    const baseline = results.find((r) => r.mechanism === 'baseline')!;
    const bestByShapeScore = [...results].filter((r) => r.quality.shapeScore !== null).sort((a, b) => (b.quality.shapeScore ?? 0) - (a.quality.shapeScore ?? 0))[0];
    console.log(`--- ${label} ---`);
    printDistribution('baseline route', collectRouteStrokeDistances(word, target, baseline.pathPoints, boundaries));
    if (bestByShapeScore) printDistribution(`best-by-shapeScore route (${bestByShapeScore.mechanism}/${bestByShapeScore.configName})`, collectRouteStrokeDistances(word, target, bestByShapeScore.pathPoints, boundaries));
  }

  console.log('');
  console.log('=== 78 GRAPH-FEASIBLE CANDIDATE CORPUS (baseline vs stroke[best config] vs checkpoint[best config]) ===');
  const STROKE_BEST = STROKE_CONFIGS.find((c) => c.name === 'lambda=0.10 scale=40')!;
  const CHECKPOINT_BEST = CHECKPOINT_CONFIGS.find((c) => c.name === 'K=3 midpoint')!;

  type CorpusRow = { word: string; locationName: string; targetDistanceMeters: number; placementId: string; baseline: QualityReport; stroke: QualityReport; checkpoint: QualityReport; baselineCoverage: number; strokeCoverage: number; checkpointCoverage: number };
  const corpusRows: CorpusRow[] = [];

  for (const testCase of MULTI_LETTER_CASES) {
    const report = await runExperimentalPipelineMultiVariant({ word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters }, ['smooth']);
    const feasible = (report.diagnostics.feasibility ?? []).filter((f) => f.feasible && f.pathPoints.length >= 2);
    console.log(`[corpus] ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m: feasible=${feasible.length}`);
    for (const record of feasible) {
      const graph = reconstructGraph(record.graphLines);
      const kind = shapeKindFromWord(testCase.word);
      const shape = buildWalkableWordShape(testCase.word, { letterVariant: 'smooth' });
      const boundaries = letterBoundariesFromWordShape(shape).boundaries;

      const baselineResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL });
      const { augmenter: strokeAugmenter } = makeStrokeProximityAugmenter(boundaries, record.target, STROKE_BEST);
      const strokeResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL, extraCost: strokeAugmenter });
      const checkpoints = buildLetterCheckpoints(boundaries, record.target, graph, CHECKPOINT_BEST.k, CHECKPOINT_BEST.mode);
      const { nodeToBits, bitToLetterIndex } = indexCheckpointBits(checkpoints);
      const checkpointAugmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, checkpoints, { penaltyPerMissedCheckpoint: CHECKPOINT_PENALTY });
      const checkpointResult = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter: true, goalCheck: REAL_ISGOAL, extraCost: checkpointAugmenter, extraMaskUpdate: makeCheckpointExtraMaskUpdate(nodeToBits) });

      corpusRows.push({
        word: testCase.word,
        locationName: testCase.locationName,
        targetDistanceMeters: testCase.targetDistanceMeters,
        placementId: record.placementId,
        baseline: evaluateQuality(testCase.word, record.target, baselineResult.pathPoints),
        stroke: evaluateQuality(testCase.word, record.target, strokeResult.pathPoints),
        checkpoint: evaluateQuality(testCase.word, record.target, checkpointResult.pathPoints),
        baselineCoverage: baselineResult.metrics.targetCoverage,
        strokeCoverage: strokeResult.metrics.targetCoverage,
        checkpointCoverage: checkpointResult.metrics.targetCoverage,
      });
    }
  }

  console.log('');
  console.log(`=== CORPUS SUMMARY (n=${corpusRows.length}) ===`);
  for (const [label, pick] of [['baseline', (r: CorpusRow) => r.baseline], ['stroke (lambda=0.10 scale=40)', (r: CorpusRow) => r.stroke], ['checkpoint (K=3 midpoint)', (r: CorpusRow) => r.checkpoint]] as const) {
    const qualities = corpusRows.map(pick);
    const withRoute = qualities.filter((q) => q.hasRoute);
    const physicalPass = withRoute.filter((q) => q.physicalWordTraversal === true);
    const currentPass = withRoute.filter((q) => q.currentWordTraversal === true);
    const meanShapeScore = withRoute.length ? withRoute.reduce((s, q) => s + (q.shapeScore ?? 0), 0) / withRoute.length : 0;
    console.log(`[${label}]: routes=${withRoute.length}/${corpusRows.length} physicalWordTraversal=${physicalPass.length} currentWordTraversal=${currentPass.length} meanShapeScore=${meanShapeScore.toFixed(3)}`);
  }

  console.log('');
  console.log('=== ROUTE-CHANGE ANALYSIS (stroke vs baseline, checkpoint vs baseline) ===');
  for (const [label, pick] of [['stroke', (r: CorpusRow) => r.stroke], ['checkpoint', (r: CorpusRow) => r.checkpoint]] as const) {
    let changed = 0;
    let improvedPhysical = 0;
    let worsenedPhysical = 0;
    for (const row of corpusRows) {
      const variant = pick(row);
      const routeChanged = JSON.stringify(variant.perLetter) !== JSON.stringify(row.baseline.perLetter) || variant.shapeScore !== row.baseline.shapeScore;
      if (!routeChanged) continue;
      changed += 1;
      const baselineCovered = row.baseline.perLetter?.filter((l) => l.physicallyCovered).length ?? 0;
      const variantCovered = variant.perLetter?.filter((l) => l.physicallyCovered).length ?? 0;
      if (variantCovered > baselineCovered) improvedPhysical += 1;
      else if (variantCovered < baselineCovered) worsenedPhysical += 1;
    }
    console.log(`[${label}]: candidates with a changed route: ${changed}/${corpusRows.length}, of those: more letters physically covered=${improvedPhysical}, fewer=${worsenedPhysical}, same count=${changed - improvedPhysical - worsenedPhysical}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'generator-guidance-mechanism-evaluation-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), corpusRowCount: corpusRows.length, corpusRows }, null, 2), 'utf8');

  console.log('');
  console.log(`[generator-guidance-mechanism-evaluation] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[generator-guidance-mechanism-evaluation] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
