/**
 * DEVELOPMENT ONLY. OLD-vs-NEW benchmark for the fine-coverage production
 * experiment (see graph-shape.ts's FINE_COVERAGE addition). Runs the SAME
 * real 78-candidate corpus used throughout the beam branch-loss diagnostic
 * chain, in-process, sequential. For every graph-feasible candidate,
 * reconstructs its ShapeGraph from the already-captured
 * FeasibilityRecord.graphLines (produced by the live, now-modified
 * pipeline) and computes BOTH:
 *   OLD = traceGraphConstrainedShape(..., { fineCoverageEnabled: false })
 *   NEW = traceGraphConstrainedShape(..., { fineCoverageEnabled: true  })
 * on the identical reconstructed graph — NEW is verified to match the
 * live pipeline's own real (modified) result exactly before being trusted.
 *
 * Run with: npx tsx src/diagnostics/fine-coverage-experiment.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';

import { analyzeLetterEntries, traceGraphConstrainedShape, type LetterCorridor, type LetterEntryAnalysis } from './beam-search-trace';
import type { GraphShapeResult } from '../generation/graph-shape';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { isFeasible } from '../generation/shape-discovery';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { extractLetterOrderInputs } from './order-score-diagnostic';
import { scorePolylines } from '../scoring/shape-match';
import { buildWalkableWordShape } from '../generation/walkable-target';

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

type VariantResult = {
  parityOk?: boolean;
  feasible: boolean;
  shapeScore: number | null;
  coverage: number | null;
  order: number | null;
  backtrack: number | null;
  targetSpan: number;
  spanOccupancy: number;
  wordTraversal: boolean;
  beamCoverage28: number;
  fineCoverageBinsCovered: number;
  fineCoverageTotalBins: number;
  rawInkCoverageMean: number;
  runtimeMs: number;
  letters: LetterEntryAnalysis[];
};

type CandidateComparison = {
  candidateRank: number;
  geometryVariant: string;
  old: VariantResult;
  new: VariantResult;
  pathChanged: boolean;
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateComparison[];
};

function evaluateVariant(
  word: string,
  target: readonly Vec2Like[],
  graph: ShapeGraph,
  kind: ReturnType<typeof shapeKindFromWord>,
  multiLetter: boolean,
  fineCoverageEnabled: boolean,
  geometryVariant: 'smooth' | 'angular' | 'hybrid',
  corridors: LetterCorridor[],
): { variant: VariantResult; result: GraphShapeResult } {
  const started = performance.now();
  const { result, trace } = traceGraphConstrainedShape({ target, graph, kind, multiLetter }, { recordExpansions: true, fineCoverageEnabled });
  const runtimeMs = performance.now() - started;

  const identity = analyzeTargetIdentity({ route: result.pathPoints, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const inkResult =
    result.pathPoints.length >= 2
      ? computeInkOnlyOccupancy({ route: result.pathPoints, target, boundarySet, letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited) })
      : null;
  const scored = result.pathPoints.length >= 2 ? scorePolylines(result.pathPoints, target) : null;
  const rawInkByLetter = corridors.map((_, index) => inkResult?.perLetterOccupancy[index]?.occupancy ?? 0);
  const letters = analyzeLetterEntries(trace, corridors, result.pathPoints, rawInkByLetter, trace.hitExpansionCap);

  // The SELECTED final path's own 28-bin coverage (SearchState.covered), read off the recorded expansion for the LAST edge on the final route — not graphShapeScore's separate 45m-radius targetCoverage metric.
  const finalEdgeRecords = trace.expansions.filter((record) => result.edgeIds.includes(record.edgeId));
  const beamCoverage28 = finalEdgeRecords.length > 0 ? Math.max(...finalEdgeRecords.map((record) => record.coverageBinCount)) / 28 : 0;

  return {
    variant: {
      feasible: isFeasible(result),
      shapeScore: scored?.score ?? null,
      coverage: scored?.coverage ?? null,
      order: scored?.breakdown.order ?? null,
      backtrack: scored?.details.backtrackRatio ?? null,
      targetSpan: identity.targetSpan,
      spanOccupancy: identity.spanOccupancy,
      wordTraversal: identity.traversesMostOfWord,
      beamCoverage28,
      fineCoverageBinsCovered: trace.finalFineCoverageBinsCovered,
      fineCoverageTotalBins: trace.finalFineCoverageTotalBins,
      rawInkCoverageMean: rawInkByLetter.length ? rawInkByLetter.reduce((s, v) => s + v, 0) / rawInkByLetter.length : 0,
      runtimeMs,
      letters,
    },
    result,
  };
}

function buildCorridors(word: string, item: FeasibilityRecord, geometryVariant: 'smooth' | 'angular' | 'hybrid'): LetterCorridor[] {
  const orderInputs = extractLetterOrderInputs(word, item.target, item.pathPoints, geometryVariant);
  return orderInputs.map((input, index) => ({ letter: input.letter, index, target: input.letterTarget, thresholdMeters: input.coverageThreshold }));
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

    const { variant: oldVariant, result: oldResult } = evaluateVariant(testCase.word, item.target, graph, kind, multiLetter, false, geometryVariant, corridors);
    const { variant: newVariant, result: newResult } = evaluateVariant(testCase.word, item.target, graph, kind, multiLetter, true, geometryVariant, corridors);

    // Verify NEW matches the live pipeline's own real (already-modified) result — proves the reconstructed graph + mirror reproduces production exactly, same as the previous diagnostic pass established.
    const parityOk = JSON.stringify(newResult.pathPoints) === JSON.stringify(item.result.pathPoints) && newResult.metrics.shapeScore === item.result.metrics.shapeScore;
    const pathChanged = JSON.stringify(oldResult.edgeIds) !== JSON.stringify(newResult.edgeIds);

    candidates.push({
      candidateRank: item.variantRank ?? -1,
      geometryVariant,
      old: { ...oldVariant, parityOk: true },
      new: { ...newVariant, parityOk },
      pathChanged,
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
    console.log(`[fine-coverage-experiment] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    const parityFails = result.candidates.filter((c) => !c.new.parityOk).length;
    const changed = result.candidates.filter((c) => c.pathChanged).length;
    console.log(`[fine-coverage-experiment] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount} parityFails=${parityFails} pathChanged=${changed}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'fine-coverage-experiment-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[fine-coverage-experiment] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[fine-coverage-experiment] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
