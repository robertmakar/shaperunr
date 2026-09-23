/**
 * DEVELOPMENT ONLY. Runs the letter-transition feasibility diagnostic (see
 * letter-transition-diagnostic.ts) against the same real 8-config corpus
 * used throughout this investigation, in-process, sequential. For every
 * adjacent letter pair in every graph-feasible candidate: runs a plain
 * graph-connectivity search (ignoring shape cost) between the two
 * letters' corridors, checks whether the beam's own real selected route
 * (dedupMode='current', i.e. byte-identical to production) actually
 * achieves that transition, and classifies the result. For transitions
 * classified CONNECTED_BUT_BEAM_BLOCKED, also records the full per-edge
 * cost breakdown of the independently-found connecting path.
 *
 * Run with: npx tsx src/diagnostics/letter-transition-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, projectPointOnPolyline, type Vec2 } from '@/lib/geometry';

import { explodeDirected, indexOutgoing, type LetterCorridor } from './beam-search-trace';
import { traceGraphConstrainedShapeDedup } from './beam-dedup-diversity';
import {
  analyzeTransitionPath,
  beamAchievesTransition,
  classifyTransition,
  corridorEntryExitNodes,
  findShortestConnectingPath,
  type EdgeCostBreakdown,
  type TransitionClassification,
} from './letter-transition-diagnostic';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, isClosedTarget, regionsForKind, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { coverageThresholdMeters } from '../generation/target-identity';
import { extractLetterOrderInputs } from './order-score-diagnostic';

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

type Vec2Like = { x: number; y: number };
function reconstructGraph(graphLines: readonly Vec2Like[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type TransitionRecord = {
  fromLetter: string;
  toLetter: string;
  hasData: boolean;
  classification: TransitionClassification;
  pathFound: boolean;
  totalLengthMeters: number | null;
  requiredBackwardProgress: number | null;
  maxPerpendicularDistanceMeters: number | null;
  requiresCorridorEscape45m: boolean | null;
  requiresCorridorEscape70m: boolean | null;
  totalCost: number | null;
  costBreakdownSum: EdgeCostBreakdown | null;
  edgeCount: number | null;
};

type CandidateReport = {
  candidateRank: number;
  geometryVariant: string;
  transitions: TransitionRecord[];
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  graphFeasibleCount: number;
  candidates: CandidateReport[];
};

function analyzeCandidate(word: string, item: FeasibilityRecord): CandidateReport | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) return null;
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const graph = reconstructGraph(item.graphLines);
  const kind = shapeKindFromWord(word);
  const multiLetter = word.length > 1;

  const { result } = traceGraphConstrainedShapeDedup({ target: item.target, graph, kind, multiLetter }, { dedupMode: 'current' });

  const targetLength = polylineLength(item.target);
  const loop = kind === 'O' || isClosedTarget(item.target);
  const regions = multiLetter && kind === 'generic' ? [{ id: 'shape', startProgress: 0, endProgress: 1 }] : regionsForKind(kind, item.target);
  const coverageThreshold = coverageThresholdMeters(item.target);
  const directed = explodeDirected(graph, item.target, targetLength, kind, loop, regions, coverageThreshold);
  const outgoing = indexOutgoing(directed);

  const orderInputs = extractLetterOrderInputs(word, item.target, item.pathPoints, geometryVariant);
  const corridors: LetterCorridor[] = orderInputs.map((input, index) => ({ letter: input.letter, index, target: input.letterTarget, thresholdMeters: input.coverageThreshold }));

  const transitions: TransitionRecord[] = [];
  for (let index = 0; index + 1 < corridors.length; index += 1) {
    const corridorA = corridors[index]!;
    const corridorB = corridors[index + 1]!;
    const fromNodes = corridorEntryExitNodes(directed, corridorA);
    const toNodes = corridorEntryExitNodes(directed, corridorB);
    const hasData = fromNodes.size > 0 && toNodes.size > 0;
    const path = hasData ? findShortestConnectingPath(directed, outgoing, fromNodes, toNodes) : null;
    const startingProgress = projectPointOnPolyline(corridorA.target[corridorA.target.length - 1]!, item.target).progress;
    const analysis = path ? analyzeTransitionPath(path, directed, targetLength, loop, kind, regions, startingProgress) : null;
    const beamAchieves = beamAchievesTransition(result.pathPoints, corridorA, corridorB);
    const classification = classifyTransition(analysis, beamAchieves, hasData);

    transitions.push({
      fromLetter: corridorA.letter,
      toLetter: corridorB.letter,
      hasData,
      classification,
      pathFound: path != null,
      totalLengthMeters: analysis?.totalLengthMeters ?? null,
      requiredBackwardProgress: analysis?.requiredBackwardProgress ?? null,
      maxPerpendicularDistanceMeters: analysis?.maxPerpendicularDistanceMeters ?? null,
      requiresCorridorEscape45m: analysis?.requiresCorridorEscape45m ?? null,
      requiresCorridorEscape70m: analysis?.requiresCorridorEscape70m ?? null,
      totalCost: analysis?.totalCost ?? null,
      costBreakdownSum: analysis?.costBreakdownSum ?? null,
      edgeCount: analysis?.edgeIds.length ?? null,
    });
  }

  return { candidateRank: item.variantRank ?? -1, geometryVariant, transitions };
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
    console.log(`[letter-transition] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[letter-transition] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'letter-transition-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[letter-transition] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[letter-transition] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
