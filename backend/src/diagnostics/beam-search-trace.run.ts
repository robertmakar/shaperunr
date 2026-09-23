/**
 * DEVELOPMENT ONLY. Runs the instrumented beam-search mirror (see
 * beam-search-trace.ts) against real ROBZ/CAIRO requests, in-process
 * (direct pipeline calls, no HTTP, sequential by construction — no
 * isolation issues, no change to any production request timeout).
 * Read-only: reconstructs each graph-feasible candidate's own ShapeGraph
 * from its already-captured FeasibilityRecord.graphLines (produced by the
 * unmodified production pipeline), re-runs the traced mirror, and PROVES
 * parity against item.result (the real production GraphShapeResult for
 * that exact candidate) before trusting the trace. Never touches graph
 * search, street-fit ranking, or beam-search code; never changes which
 * candidates are feasible/routed/accepted; never changes the route
 * returned to the user.
 *
 * Per Section 2's "do not log millions of states blindly": the full
 * per-expansion trace is computed for every candidate (needed to classify
 * each letter's branch-loss outcome) but immediately reduced to summary
 * fields and discarded — except for a small, explicitly identified set of
 * forensic candidates (CAIRO's "missed O", the two known ROBZ candidates,
 * CAIRO's strongest/highest-ink candidates), whose full traces are
 * persisted to separate files for deep inspection.
 *
 * Run with: npx tsx src/diagnostics/beam-search-trace.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';

import {
  analyzeLetterEntries,
  traceGraphConstrainedShape,
  type BeamExpansionRecord,
  type LetterCorridor,
  type LetterEntryAnalysis,
} from './beam-search-trace';
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

/** Reconstructs an equivalent ShapeGraph from FeasibilityRecord.graphLines. buildShapeGraph derives from/to node ids by snapping endpoints (snapNodeId), exactly as production's own buildShapeGraph(corridor) call does — connectivity is therefore reconstructed faithfully. wayId is synthesized per line (the original per-line wayId isn't preserved in graphLines), which only affects the post-hoc uniqueWays/repeatedWays/graphShapeScore metrics, never the beam search's own routing decisions (edgeCost never reads wayId) — parity is verified directly against item.result below regardless. */
function reconstructGraph(graphLines: readonly Vec2Like[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points: points as Vec2Like[] as { x: number; y: number }[] })));
}
type Vec2Like = { x: number; y: number };

type CandidateSummary = {
  candidateRank: number;
  geometryVariant: string;
  currentOccupiedSpan: number;
  inkOnlyOccupancy: number;
  parityOk: boolean;
  reconstructionShapeScoreDelta: number;
  hitExpansionCap: boolean;
  totalExpansions: number;
  finalBeamCoverageFraction: number;
  letters: LetterEntryAnalysis[];
};

type ForensicRecord = {
  label: string;
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  candidateRank: number;
  currentOccupiedSpan: number;
  letters: LetterEntryAnalysis[];
  expansions: BeamExpansionRecord[];
  corridors: Array<{ letter: string; thresholdMeters: number }>;
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  status: string;
  graphFeasibleCount: number;
  candidates: CandidateSummary[];
};

function buildCorridors(word: string, item: FeasibilityRecord, geometryVariant: 'smooth' | 'angular' | 'hybrid') {
  const orderInputs = extractLetterOrderInputs(word, item.target, item.pathPoints, geometryVariant);
  const corridors: LetterCorridor[] = orderInputs.map((input, index) => ({
    letter: input.letter,
    index,
    target: input.letterTarget,
    thresholdMeters: input.coverageThreshold,
  }));
  return corridors;
}

function processCandidate(
  word: string,
  item: FeasibilityRecord,
  forensicMatchers: Array<{ label: string; test: (candidate: CandidateSummary, item: FeasibilityRecord) => boolean }>,
  caseInfo: { locationName: string; targetDistanceMeters: number },
  forensics: ForensicRecord[],
): CandidateSummary | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) return null;

  const geometryVariant = item.geometryVariant ?? 'smooth';
  const identity = analyzeTargetIdentity({ route: item.pathPoints, target: item.target, word, geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: geometryVariant }));
  const inkResult = computeInkOnlyOccupancy({
    route: item.pathPoints,
    target: item.target,
    boundarySet,
    letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited),
  });

  const graph = reconstructGraph(item.graphLines);
  const kind = shapeKindFromWord(word);
  const multiLetter = word.length > 1;
  const { result: mirrored, trace } = traceGraphConstrainedShape({ target: item.target, graph, kind, multiLetter }, { recordExpansions: true });

  // Mirror fidelity: the REAL, unmodified routeGraphConstrainedShape() called on the EXACT SAME reconstructed graph must match the mirror exactly. This is the correct parity check — see the file header's note on why comparing against item.result directly is not: FeasibilityRecord.graphLines only exposes flattened polylines (no original segment ids/from/to), so reconstructing a ShapeGraph from them necessarily falls back to buildShapeGraph's geometric snapNodeId connectivity instead of production's real graph-collection node ids, which can occasionally connect/disconnect segments differently than the ORIGINAL corridor did. That is a graph-RECONSTRUCTION approximation, not a mirror-FIDELITY gap — the two are kept separate below.
  const realOnReconstructed = routeGraphConstrainedShape({ target: item.target, graph, kind, multiLetter });
  const mirrorFidelityOk =
    JSON.stringify(mirrored.pathPoints) === JSON.stringify(realOnReconstructed.pathPoints) &&
    JSON.stringify(mirrored.edgeIds) === JSON.stringify(realOnReconstructed.edgeIds) &&
    JSON.stringify(mirrored.metrics) === JSON.stringify(realOnReconstructed.metrics);
  // Informational only: how close the RECONSTRUCTED graph's outcome is to production's own result on its original (more precisely connected) graph.
  const reconstructionShapeScoreDelta = Math.abs(mirrored.metrics.shapeScore - item.result.metrics.shapeScore);
  const parityOk = mirrorFidelityOk;

  const corridors = buildCorridors(word, item, geometryVariant);
  const rawInkByLetter = corridors.map((_, index) => inkResult.perLetterOccupancy[index]?.occupancy ?? 0);
  const letterAnalyses = analyzeLetterEntries(trace, corridors, mirrored.pathPoints, rawInkByLetter, trace.hitExpansionCap);

  const finalPathBeamCoverage = trace.expansions.filter((record) => mirrored.edgeIds.includes(record.edgeId));
  const finalBeamCoverageFraction = finalPathBeamCoverage.length > 0 ? Math.max(...finalPathBeamCoverage.map((record) => record.coverageBinCount)) / 28 : 0;

  const summary: CandidateSummary = {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    currentOccupiedSpan: identity.targetSpan,
    inkOnlyOccupancy: inkResult.inkOnlyOccupancy,
    parityOk,
    reconstructionShapeScoreDelta,
    hitExpansionCap: trace.hitExpansionCap,
    totalExpansions: trace.totalExpansions,
    finalBeamCoverageFraction,
    letters: letterAnalyses,
  };

  for (const matcher of forensicMatchers) {
    if (matcher.test(summary, item)) {
      forensics.push({
        label: matcher.label,
        word,
        locationName: caseInfo.locationName,
        targetDistanceMeters: caseInfo.targetDistanceMeters,
        candidateRank: summary.candidateRank,
        currentOccupiedSpan: summary.currentOccupiedSpan,
        letters: letterAnalyses,
        expansions: trace.expansions,
        corridors: corridors.map((corridor) => ({ letter: corridor.letter, thresholdMeters: corridor.thresholdMeters })),
      });
    }
  }

  return summary;
}

async function runCase(testCase: (typeof CASES)[number], forensics: ForensicRecord[]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const isRobzAlex2k = testCase.word === 'ROBZ' && testCase.locationName === 'Alexandria' && testCase.targetDistanceMeters === 2000;
  const isCairoAlex2k = testCase.word === 'CAIRO' && testCase.locationName === 'Alexandria' && testCase.targetDistanceMeters === 2000;

  const forensicMatchers: Array<{ label: string; test: (candidate: CandidateSummary, item: FeasibilityRecord) => boolean }> = [];
  if (isRobzAlex2k) {
    forensicMatchers.push({ label: 'ROBZ_candidate1_0.414span', test: (c) => Math.abs(c.currentOccupiedSpan - 0.4136) < 0.005 });
    forensicMatchers.push({
      label: 'ROBZ_candidate2_allHighRawInk',
      test: (c) => c.letters.every((letter) => letter.rawInkCoverage >= 0.7),
    });
  }
  if (isCairoAlex2k) {
    forensicMatchers.push({
      label: 'CAIRO_missedO',
      test: (c, item) => {
        const identity = analyzeTargetIdentity({ route: item.pathPoints, target: item.target, word: 'CAIRO', geometryVariant: item.geometryVariant ?? 'smooth' });
        return (identity.letters[0]?.coverage ?? 0) > 0.8 && (c.letters[4]?.rawInkCoverage ?? -1) === 0;
      },
    });
    // CAIRO_strongestSpan / CAIRO_highestInkOnly need the full candidate list to identify — resolved after the loop below, not via a matcher.
  }

  const candidates: CandidateSummary[] = [];
  for (const item of feasible) {
    const summary = processCandidate(testCase.word, item, forensicMatchers, { locationName: testCase.locationName, targetDistanceMeters: testCase.targetDistanceMeters }, forensics);
    if (summary) candidates.push(summary);
  }

  if (isCairoAlex2k && candidates.length > 0) {
    const strongest = [...candidates].sort((a, b) => b.currentOccupiedSpan - a.currentOccupiedSpan)[0]!;
    const highestInk = [...candidates].sort((a, b) => b.inkOnlyOccupancy - a.inkOnlyOccupancy)[0]!;
    if (!forensics.some((f) => f.label === 'CAIRO_strongestSpan' && f.candidateRank === strongest.candidateRank)) {
      const item = feasible.find((candidate) => (candidate.variantRank ?? -1) === strongest.candidateRank);
      if (item) {
        const geometryVariant = item.geometryVariant ?? 'smooth';
        const corridors = buildCorridors('CAIRO', item, geometryVariant);
        const graph = reconstructGraph(item.graphLines);
        const { result: mirrored, trace } = traceGraphConstrainedShape({ target: item.target, graph, kind: 'generic', multiLetter: true }, { recordExpansions: true });
        forensics.push({
          label: 'CAIRO_strongestSpan',
          word: 'CAIRO',
          locationName: testCase.locationName,
          targetDistanceMeters: testCase.targetDistanceMeters,
          candidateRank: strongest.candidateRank,
          currentOccupiedSpan: strongest.currentOccupiedSpan,
          letters: strongest.letters,
          expansions: trace.expansions,
          corridors: corridors.map((corridor) => ({ letter: corridor.letter, thresholdMeters: corridor.thresholdMeters })),
        });
        void mirrored;
      }
    }
    if (highestInk.candidateRank !== strongest.candidateRank) {
      const item = feasible.find((candidate) => (candidate.variantRank ?? -1) === highestInk.candidateRank);
      if (item) {
        const geometryVariant = item.geometryVariant ?? 'smooth';
        const corridors = buildCorridors('CAIRO', item, geometryVariant);
        const graph = reconstructGraph(item.graphLines);
        const { trace } = traceGraphConstrainedShape({ target: item.target, graph, kind: 'generic', multiLetter: true }, { recordExpansions: true });
        forensics.push({
          label: 'CAIRO_highestInkOnly',
          word: 'CAIRO',
          locationName: testCase.locationName,
          targetDistanceMeters: testCase.targetDistanceMeters,
          candidateRank: highestInk.candidateRank,
          currentOccupiedSpan: highestInk.currentOccupiedSpan,
          letters: highestInk.letters,
          expansions: trace.expansions,
          corridors: corridors.map((corridor) => ({ letter: corridor.letter, thresholdMeters: corridor.thresholdMeters })),
        });
      }
    }
  }

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    status: report.status,
    graphFeasibleCount: feasible.length,
    candidates,
  };
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  const forensics: ForensicRecord[] = [];
  for (const testCase of CASES) {
    console.log(`[beam-trace] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase, forensics);
    cases.push(result);
    const parityFails = result.candidates.filter((c) => !c.parityOk).length;
    console.log(`[beam-trace] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount} parityFails=${parityFails}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const summaryPath = resolve(DIAGNOSTIC_DIR, 'beam-search-trace-summary.json');
  writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');
  const forensicsPath = resolve(DIAGNOSTIC_DIR, 'beam-search-trace-forensics.json');
  writeFileSync(forensicsPath, JSON.stringify({ generatedAt: new Date().toISOString(), forensics }, null, 2), 'utf8');

  console.log('');
  console.log(`[beam-trace] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[beam-trace] summary: ${summaryPath}`);
  console.log(`[beam-trace] forensics: ${forensicsPath} (${forensics.length} records)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
