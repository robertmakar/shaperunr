/**
 * DEVELOPMENT ONLY. Runs the multi-letter traversal diagnostics (see
 * multi-letter-trace.ts) against real ROBZ/CAIRO requests, in-process
 * (direct pipeline calls — no HTTP, no server needed, and therefore no
 * timeout/overlap concerns at all, which is why this doesn't need the
 * benchmark runner's isolation machinery). Sequential by construction (a
 * plain `for` loop with `await` inside).
 *
 * Does not change any search/scoring/gate behavior — reads
 * report.diagnostics.feasibility (already computed, already stored) and
 * reuses existing scoring (scorePolylines, analyzeTargetIdentity) purely
 * for observation.
 *
 * Run with: npx tsx src/diagnostics/multi-letter-trace.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';

import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { scorePolylines } from '../scoring/shape-match';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  buildTraversalTrace,
  letterBoundariesFromWordShape,
  type CandidateTraversalRecord,
  type LetterBoundarySet,
} from './multi-letter-trace';

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

/** Bounded sample of graph-rejected candidates to trace alongside every feasible one — never all ~90+ of them. */
const REJECTED_SAMPLE_SIZE = 10;

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  elapsedMs: number;
  status: string;
  placementsEvaluated: number;
  graphFeasibleCount: number;
  routedCount: number;
  acceptedCount: number;
  /** Empirical confirmation of what regions the actual graph search used for this word (read from a live GraphShapeResult, not inferred from source). */
  regionsUsedByGraphSearch: Array<{ id: string; startProgress: number; endProgress: number }> | null;
  letterBoundaries: LetterBoundarySet;
  candidates: CandidateTraversalRecord[];
};

function buildCandidateRecord(
  word: string,
  expectedLetters: string[],
  item: FeasibilityRecord,
  boundaries: LetterBoundarySet,
  routedIds: Set<string>,
): CandidateTraversalRecord {
  const identity =
    item.pathPoints.length >= 2 && item.target.length >= 2
      ? analyzeTargetIdentity({ route: item.pathPoints, target: item.target, word })
      : null;
  const scored = item.pathPoints.length >= 2 ? scorePolylines(item.pathPoints, item.target) : null;
  const trace = buildTraversalTrace({
    pathPoints: item.pathPoints,
    target: item.target,
    boundaries: boundaries.boundaries,
    expectedLetters,
    actualWordTraversal: identity?.traversesMostOfWord ?? null,
  });
  return {
    word,
    geometryVariant: item.geometryVariant ?? 'smooth',
    candidateRank: item.variantRank ?? -1,
    graphFeasible: item.feasible,
    routed: routedIds.has(item.placementId),
    expectedLetters,
    lettersVisited: trace.lettersVisited,
    lettersVisitedInOrder: trace.lettersVisitedInOrder,
    firstMissingLetter: trace.firstMissingLetter,
    maxLetterIndexReached: trace.maxLetterIndexReached,
    targetProgressStart: identity?.startProgress ?? null,
    targetProgressEnd: identity?.endProgress ?? null,
    wordTraversal: identity?.traversesMostOfWord ?? null,
    orderScore: scored?.breakdown.order ?? null,
    coverage: scored?.coverage ?? null,
    targetSpan: identity?.targetSpan ?? null,
    backtracking: scored?.details.backtrackRatio ?? null,
    rawLetterSequence: trace.rawLetterSequence,
    collapsedLetterSequence: trace.collapsedLetterSequence,
    failureMode: trace.failureMode,
  };
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );

  const wordShape = buildWalkableWordShape(testCase.word, { letterVariant: 'smooth' });
  const expectedLetters = wordShape.letters.map((letter) => letter.char);
  const boundaries = letterBoundariesFromWordShape(wordShape);

  const feasibility = report.diagnostics.feasibility ?? [];
  const routedIds = new Set((report.diagnostics.routeLengthSamples ?? []).map((sample) => sample.placementId));
  const feasible = feasibility.filter((item) => item.feasible);
  const rejected = feasibility.filter((item) => !item.feasible).slice(0, REJECTED_SAMPLE_SIZE);

  const regionsUsedByGraphSearch = feasibility[0]?.result?.regions
    ? feasibility[0].result.regions.map((region) => ({
        id: region.id,
        startProgress: region.startProgress,
        endProgress: region.endProgress,
      }))
    : null;

  const candidates = [...feasible, ...rejected].map((item) =>
    buildCandidateRecord(testCase.word, expectedLetters, item, boundaries, routedIds),
  );

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    elapsedMs: report.elapsedMs,
    status: report.status,
    placementsEvaluated: report.diagnostics.placementsEvaluated,
    graphFeasibleCount: feasible.length,
    routedCount: routedIds.size,
    acceptedCount: report.routes.length,
    regionsUsedByGraphSearch,
    letterBoundaries: boundaries,
    candidates,
  };
}

function formatCandidate(candidate: CandidateTraversalRecord): string {
  return (
    `  [${candidate.geometryVariant}] rank=${candidate.candidateRank} feasible=${candidate.graphFeasible} routed=${candidate.routed} ` +
    `\n    sequence: ${candidate.collapsedLetterSequence.join(' -> ') || '(none)'}` +
    `\n    lettersVisited=${candidate.lettersVisited.join('') || '-'} inOrder=${candidate.lettersVisitedInOrder} firstMissing=${candidate.firstMissingLetter ?? 'none'} maxIndex=${candidate.maxLetterIndexReached}/${candidate.expectedLetters.length - 1}` +
    `\n    wordTraversal=${candidate.wordTraversal} targetSpan=${candidate.targetSpan?.toFixed(3) ?? 'n/a'} order=${candidate.orderScore?.toFixed(3) ?? 'n/a'} coverage=${candidate.coverage?.toFixed(3) ?? 'n/a'} backtrack=${candidate.backtracking?.toFixed(3) ?? 'n/a'}` +
    `\n    failureMode=${candidate.failureMode}`
  );
}

function buildTextReport(cases: CaseReport[]): string {
  const lines: string[] = ['Multi-letter traversal diagnostics (DEVELOPMENT ONLY) — observation only, no algorithm change.', ''];
  for (const caseReport of cases) {
    lines.push(`=== ${caseReport.word} — ${caseReport.locationName} ${caseReport.targetDistanceMeters}m ===`);
    lines.push(
      `status=${caseReport.status} placementsEvaluated=${caseReport.placementsEvaluated} graphFeasible=${caseReport.graphFeasibleCount} routed=${caseReport.routedCount} accepted=${caseReport.acceptedCount} elapsed=${caseReport.elapsedMs}ms`,
    );
    lines.push(
      `graph-search regions actually used: ${caseReport.regionsUsedByGraphSearch ? JSON.stringify(caseReport.regionsUsedByGraphSearch) : '(no feasibility-pool candidates to inspect)'}`,
    );
    lines.push(
      `letter boundaries (projected): ${caseReport.letterBoundaries.boundaries.map((b) => `${b.letter}[${b.projectedStartProgress.toFixed(2)}-${b.projectedEndProgress.toFixed(2)}]`).join(' ')}`,
    );
    lines.push(
      `inter-letter gap: totalFlattened=${caseReport.letterBoundaries.totalFlattenedLength.toFixed(3)} totalLetterInk=${caseReport.letterBoundaries.totalLetterLength.toFixed(3)} gap=${caseReport.letterBoundaries.interLetterGapLength.toFixed(3)} (${((caseReport.letterBoundaries.interLetterGapLength / caseReport.letterBoundaries.totalFlattenedLength) * 100).toFixed(1)}% of target length)`,
    );

    const feasibleCandidates = caseReport.candidates.filter((candidate) => candidate.graphFeasible);
    const failureCounts = new Map<string, number>();
    for (const candidate of caseReport.candidates) {
      failureCounts.set(candidate.failureMode, (failureCounts.get(candidate.failureMode) ?? 0) + 1);
    }
    lines.push(`failure mode counts (feasible + sampled rejected, n=${caseReport.candidates.length}): ${[...failureCounts.entries()].map(([mode, count]) => `${mode}=${count}`).join(', ')}`);

    if (feasibleCandidates.length > 0) {
      const furthest = [...feasibleCandidates].sort((a, b) => b.maxLetterIndexReached - a.maxLetterIndexReached)[0]!;
      const highestSpan = [...feasibleCandidates].sort((a, b) => (b.targetSpan ?? -1) - (a.targetSpan ?? -1))[0]!;
      const highestOrder = [...feasibleCandidates].sort((a, b) => (b.orderScore ?? -1) - (a.orderScore ?? -1))[0]!;
      const wrongOrderExample = feasibleCandidates.find((candidate) => candidate.lettersVisited.length >= 2 && !candidate.lettersVisitedInOrder) ?? null;
      const firstLetterOnlyExample = feasibleCandidates.find((candidate) => candidate.lettersVisited.length === 1) ?? null;

      lines.push('-- furthest through the word --');
      lines.push(formatCandidate(furthest));
      lines.push('-- highest targetSpan --');
      lines.push(formatCandidate(highestSpan));
      lines.push('-- highest order score --');
      lines.push(formatCandidate(highestOrder));
      lines.push(wrongOrderExample ? '-- reaches multiple letters but fails ordering --' : '-- (no multi-letter-but-wrong-order example among feasible candidates) --');
      if (wrongOrderExample) lines.push(formatCandidate(wrongOrderExample));
      lines.push(firstLetterOnlyExample ? '-- reaches only the first letter --' : '-- (no first-letter-only example among feasible candidates) --');
      if (firstLetterOnlyExample) lines.push(formatCandidate(firstLetterOnlyExample));
    } else {
      lines.push('(no graph-feasible candidates for this case)');
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of CASES) {
    console.log(`[multi-letter-trace] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    // Sequential by construction — same reasoning as the shared-budget benchmark runner, though this doesn't go over HTTP at all.
    const result = await runCase(testCase);
    cases.push(result);
    console.log(
      `[multi-letter-trace] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount} routed=${result.routedCount} accepted=${result.acceptedCount} (${result.elapsedMs}ms)`,
    );
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'multi-letter-trace-results.json');
  const textPath = resolve(DIAGNOSTIC_DIR, 'multi-letter-trace-summary.txt');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');
  writeFileSync(textPath, buildTextReport(cases), 'utf8');

  console.log('');
  console.log(`[multi-letter-trace] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[multi-letter-trace] json: ${jsonPath}`);
  console.log(`[multi-letter-trace] summary: ${textPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
