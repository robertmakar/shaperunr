/**
 * DEVELOPMENT ONLY. Runs the crossing-penalty shadow experiment (see
 * crossing-penalty-experiment.ts) across all 6 CROSSING_VARIANTS against
 * the same real 8-config corpus used throughout this investigation,
 * in-process, sequential. For every candidate: runs the beam search once
 * per variant (each verified to only ever differ in the crossing cost
 * term), computes route-quality metrics, and — reusing the graph-
 * connectivity search from letter-transition-diagnostic.ts, which is
 * shape-cost-agnostic and therefore identical across all 6 variants —
 * classifies every adjacent-letter transition per variant by checking
 * whether that variant's own selected route actually achieves it.
 *
 * Run with: npx tsx src/diagnostics/crossing-penalty-experiment.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, projectPointOnPolyline } from '@/lib/geometry';

import { explodeDirected, indexOutgoing, type LetterCorridor } from './beam-search-trace';
import { CROSSING_VARIANTS, traceGraphConstrainedShapeCrossing } from './crossing-penalty-experiment';
import {
  analyzeTransitionPath,
  beamAchievesTransition,
  classifyTransition,
  corridorEntryExitNodes,
  findShortestConnectingPath,
  type TransitionClassification,
} from './letter-transition-diagnostic';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, isClosedTarget, regionsForKind, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { extractLetterOrderInputs } from './order-score-diagnostic';
import { scorePolylines } from '../scoring/shape-match';
import { analyzeTargetIdentity, coverageThresholdMeters } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CASES: Array<{ word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];

const VARIANT_KEYS = Object.keys(CROSSING_VARIANTS);

type Vec2Like = { x: number; y: number };
function reconstructGraph(graphLines: readonly Vec2Like[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type TransitionByVariant = { fromLetter: string; toLetter: string; classifications: Record<string, TransitionClassification> };

type VariantResult = {
  shapeScore: number | null;
  coverage: number | null;
  order: number | null;
  backtrack: number | null;
  targetSpan: number;
  distanceRatio: number;
  routeDistanceMeters: number;
  wordTraversal: boolean;
  rawInkCoverageMean: number;
  expansions: number;
  runtimeMs: number;
  edgeIds: string[];
};

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  variants: Record<string, VariantResult>;
  transitions: TransitionByVariant[];
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateReport[];
};

function computeVariantResult(word: string, target: readonly Vec2Like[], graph: ShapeGraph, kind: ReturnType<typeof shapeKindFromWord>, multiLetter: boolean, geometryVariant: 'smooth' | 'angular' | 'hybrid', variantKey: string): { variant: VariantResult; pathPoints: Vec2Like[] } {
  const started = performance.now();
  const { result, expansions } = traceGraphConstrainedShapeCrossing({ target, graph, kind, multiLetter }, { params: CROSSING_VARIANTS[variantKey]! });
  const runtimeMs = performance.now() - started;

  const identity = analyzeTargetIdentity({ route: result.pathPoints, target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const inkResult =
    result.pathPoints.length >= 2
      ? computeInkOnlyOccupancy({ route: result.pathPoints, target, boundarySet, letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited) })
      : null;
  const scored = result.pathPoints.length >= 2 ? scorePolylines(result.pathPoints, target) : null;
  const rawInkMean = inkResult && inkResult.perLetterOccupancy.length ? inkResult.perLetterOccupancy.reduce((s, l) => s + l.occupancy, 0) / inkResult.perLetterOccupancy.length : 0;

  return {
    variant: {
      shapeScore: scored?.score ?? null,
      coverage: scored?.coverage ?? null,
      order: scored?.breakdown.order ?? null,
      backtrack: scored?.details.backtrackRatio ?? null,
      targetSpan: identity.targetSpan,
      distanceRatio: result.metrics.distanceRatio,
      routeDistanceMeters: result.metrics.routeDistanceMeters,
      wordTraversal: identity.traversesMostOfWord,
      rawInkCoverageMean: rawInkMean,
      expansions,
      runtimeMs,
      edgeIds: result.edgeIds,
    },
    pathPoints: result.pathPoints,
  };
}

function analyzeCandidate(word: string, item: FeasibilityRecord): CandidateReport | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) return null;
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const graph = reconstructGraph(item.graphLines);
  const kind = shapeKindFromWord(word);
  const multiLetter = word.length > 1;

  const variants: Record<string, VariantResult> = {};
  const pathPointsByVariant: Record<string, Vec2Like[]> = {};
  for (const variantKey of VARIANT_KEYS) {
    const { variant, pathPoints } = computeVariantResult(word, item.target, graph, kind, multiLetter, geometryVariant, variantKey);
    variants[variantKey] = variant;
    pathPointsByVariant[variantKey] = pathPoints;
  }

  // Shape-cost-agnostic connectivity search — computed ONCE (identical across all 6 variants).
  const targetLength = polylineLength(item.target);
  const loop = kind === 'O' || isClosedTarget(item.target);
  const regions = multiLetter && kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, item.target);
  const directed = explodeDirected(graph, item.target, targetLength, kind, loop, regions, coverageThresholdMeters(item.target));
  const outgoing = indexOutgoing(directed);
  const orderInputs = extractLetterOrderInputs(word, item.target, item.pathPoints, geometryVariant);
  const corridors: LetterCorridor[] = orderInputs.map((input, index) => ({ letter: input.letter, index, target: input.letterTarget, thresholdMeters: input.coverageThreshold }));

  const transitions: TransitionByVariant[] = [];
  for (let index = 0; index + 1 < corridors.length; index += 1) {
    const corridorA = corridors[index]!;
    const corridorB = corridors[index + 1]!;
    const fromNodes = corridorEntryExitNodes(directed, corridorA);
    const toNodes = corridorEntryExitNodes(directed, corridorB);
    const hasData = fromNodes.size > 0 && toNodes.size > 0;
    const path = hasData ? findShortestConnectingPath(directed, outgoing, fromNodes, toNodes) : null;
    const startingProgress = projectPointOnPolyline(corridorA.target[corridorA.target.length - 1]!, item.target).progress;
    const analysis = path ? analyzeTransitionPath(path, directed, targetLength, loop, kind, regions, startingProgress) : null;

    const classifications: Record<string, TransitionClassification> = {};
    for (const variantKey of VARIANT_KEYS) {
      const beamAchieves = beamAchievesTransition(pathPointsByVariant[variantKey]!, corridorA, corridorB);
      classifications[variantKey] = classifyTransition(analysis, beamAchieves, hasData);
    }
    transitions.push({ fromLetter: corridorA.letter, toLetter: corridorB.letter, classifications });
  }

  return { candidateRank: item.variantRank ?? -1, geometryVariant, variants, transitions };
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const candidates = feasible
    .map((item) => analyzeCandidate(testCase.word, item))
    .filter((record): record is CandidateReport => record !== null);

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
    console.log(`[crossing-penalty] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[crossing-penalty] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'crossing-penalty-experiment-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), variants: CROSSING_VARIANTS, cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[crossing-penalty] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[crossing-penalty] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
