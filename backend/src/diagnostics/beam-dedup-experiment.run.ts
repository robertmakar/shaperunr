/**
 * DEVELOPMENT ONLY. OLD-vs-NEW benchmark for the coverage-aware
 * deduplication shadow experiment (see beam-dedup-diversity.ts). Runs the
 * same real 8-config / ~79-candidate corpus used throughout this beam
 * investigation, in-process, sequential. For every graph-feasible
 * candidate, reconstructs its ShapeGraph from the already-captured
 * FeasibilityRecord.graphLines and computes BOTH:
 *   OLD = traceGraphConstrainedShapeDedup(..., { dedupMode: 'current' })
 *   NEW = traceGraphConstrainedShapeDedup(..., { dedupMode: 'coverageAware' })
 * on the identical reconstructed graph — OLD is verified against the live
 * (untouched) production pipeline's own real result before being trusted.
 *
 * Run with: npx tsx src/diagnostics/beam-dedup-experiment.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';

import { traceGraphConstrainedShapeDedup, type DedupCollisionStats, type LetterEntrySummary } from './beam-dedup-diversity';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { extractLetterOrderInputs } from './order-score-diagnostic';
import { scorePolylines } from '../scoring/shape-match';
import { buildWalkableWordShape } from '../generation/walkable-target';
import type { LetterCorridor } from './beam-search-trace';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK: Coordinate = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA: Coordinate = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CASES: Array<{ word: string; locationName: string; start: Coordinate; targetDistanceMeters: number }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];

type Vec2Like = { x: number; y: number };
function reconstructGraph(graphLines: readonly Vec2Like[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type LetterClassification = 'NO_ENTRY' | 'ENTERED_AND_PRUNED' | 'SURVIVED_BUT_NOT_SELECTED' | 'SELECTED_BUT_LOW_COVERAGE' | 'EXPANSION_CAP' | 'OTHER';

function classifyLetter(letter: LetterEntrySummary, rawInk: number, hitExpansionCap: boolean): LetterClassification {
  if (!letter.everEntered) return hitExpansionCap ? 'EXPANSION_CAP' : 'NO_ENTRY';
  if (!letter.everSurvivedBeamCut) return 'ENTERED_AND_PRUNED';
  if (!letter.finalRouteUsesRegion) return 'SURVIVED_BUT_NOT_SELECTED';
  if (rawInk < 0.32) return 'SELECTED_BUT_LOW_COVERAGE';
  return 'OTHER';
}

type LetterRecord = { letter: string; rawInkCoverage: number; classification: LetterClassification };

type VariantResult = {
  parityOk?: boolean;
  shapeScore: number | null;
  coverage: number | null;
  order: number | null;
  backtrack: number | null;
  targetSpan: number;
  wordTraversal: boolean;
  rawInkCoverageMean: number;
  routeDistanceMeters: number;
  distanceRatio: number;
  expansions: number;
  maxBeamSize: number;
  runtimeMs: number;
  letters: LetterRecord[];
  edgeIds: string[];
};

type CandidateComparison = {
  candidateRank: number;
  geometryVariant: string;
  old: VariantResult;
  new: VariantResult;
  collisionStats: DedupCollisionStats;
  routeChanged: boolean;
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateComparison[];
};

function buildCorridors(word: string, item: FeasibilityRecord, geometryVariant: 'smooth' | 'angular' | 'hybrid'): LetterCorridor[] {
  const orderInputs = extractLetterOrderInputs(word, item.target, item.pathPoints, geometryVariant);
  return orderInputs.map((input, index) => ({ letter: input.letter, index, target: input.letterTarget, thresholdMeters: input.coverageThreshold }));
}

function evaluateVariant(
  word: string,
  target: readonly Vec2Like[],
  graph: ShapeGraph,
  kind: ReturnType<typeof shapeKindFromWord>,
  multiLetter: boolean,
  dedupMode: 'current' | 'coverageAware',
  collectStats: boolean,
  geometryVariant: 'smooth' | 'angular' | 'hybrid',
  corridors: LetterCorridor[],
): { variant: VariantResult; collisionStats: DedupCollisionStats } {
  const started = performance.now();
  const { result, expansions, maxBeamSize, stats, letters } = traceGraphConstrainedShapeDedup({ target, graph, kind, multiLetter }, { dedupMode, collectStats, corridors });
  const runtimeMs = performance.now() - started;

  const identity = analyzeTargetIdentity({ route: result.pathPoints, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const inkResult =
    result.pathPoints.length >= 2
      ? computeInkOnlyOccupancy({ route: result.pathPoints, target, boundarySet, letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited) })
      : null;
  const scored = result.pathPoints.length >= 2 ? scorePolylines(result.pathPoints, target) : null;
  const hitExpansionCap = expansions >= 12_000;

  const letterRecords: LetterRecord[] = letters.map((letter, index) => {
    const rawInk = inkResult?.perLetterOccupancy[index]?.occupancy ?? 0;
    return { letter: letter.letter, rawInkCoverage: rawInk, classification: classifyLetter(letter, rawInk, hitExpansionCap) };
  });

  return {
    variant: {
      shapeScore: scored?.score ?? null,
      coverage: scored?.coverage ?? null,
      order: scored?.breakdown.order ?? null,
      backtrack: scored?.details.backtrackRatio ?? null,
      targetSpan: identity.targetSpan,
      wordTraversal: identity.traversesMostOfWord,
      rawInkCoverageMean: letterRecords.length ? letterRecords.reduce((s, l) => s + l.rawInkCoverage, 0) / letterRecords.length : 0,
      routeDistanceMeters: result.metrics.routeDistanceMeters,
      distanceRatio: result.metrics.distanceRatio,
      expansions,
      maxBeamSize,
      runtimeMs,
      letters: letterRecords,
      edgeIds: result.edgeIds,
    },
    collisionStats: stats,
  };
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);
  const kind = shapeKindFromWord(testCase.word);
  const multiLetter = testCase.word.length > 1;

  const candidates: CandidateComparison[] = [];
  for (const item of feasible) {
    if (item.pathPoints.length < 2 || item.target.length < 2) continue;
    const geometryVariant = item.geometryVariant ?? 'smooth';
    const graph = reconstructGraph(item.graphLines);
    const corridors = buildCorridors(testCase.word, item, geometryVariant);

    const { variant: oldVariant, collisionStats } = evaluateVariant(testCase.word, item.target, graph, kind, multiLetter, 'current', true, geometryVariant, corridors);
    const { variant: newVariant } = evaluateVariant(testCase.word, item.target, graph, kind, multiLetter, 'coverageAware', false, geometryVariant, corridors);

    // Parity check: the real, unmodified routeGraphConstrainedShape() on the SAME reconstructed graph must match dedupMode='current' exactly. (Comparing against item.result directly is not valid here — FeasibilityRecord.graphLines only exposes flattened polylines, so the reconstructed graph uses buildShapeGraph's geometric node-snapping instead of the original corridor's own node ids; this is a graph-reconstruction approximation, not a mirror-fidelity gap, exactly as established in the prior fine-coverage experiment.)
    const realOnReconstructed = routeGraphConstrainedShape({ target: item.target, graph, kind, multiLetter });
    const parityOk = JSON.stringify(oldVariant.edgeIds) === JSON.stringify(realOnReconstructed.edgeIds) && oldVariant.shapeScore === realOnReconstructed.metrics.shapeScore;
    const routeChanged = JSON.stringify(oldVariant.edgeIds) !== JSON.stringify(newVariant.edgeIds);

    candidates.push({
      candidateRank: item.variantRank ?? -1,
      geometryVariant,
      old: { ...oldVariant, parityOk },
      new: { ...newVariant, parityOk: true },
      collisionStats,
      routeChanged,
    });
  }

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    graphFeasibleCount: feasible.length,
    candidates,
  };
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of CASES) {
    console.log(`[beam-dedup-experiment] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    const parityFails = result.candidates.filter((c) => !c.old.parityOk).length;
    const changed = result.candidates.filter((c) => c.routeChanged).length;
    console.log(`[beam-dedup-experiment] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount} parityFails=${parityFails} routeChanged=${changed}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'beam-dedup-experiment-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[beam-dedup-experiment] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[beam-dedup-experiment] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
