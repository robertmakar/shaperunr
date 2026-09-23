/**
 * DEVELOPMENT ONLY. Runs the ink-only-occupancy diagnostic (see
 * letter-occupancy.ts) against real ROBZ/CAIRO requests, in-process (direct
 * pipeline calls, no HTTP, sequential by construction). Read-only: computes
 * a diagnostic metric alongside the existing, unmodified TargetIdentity
 * result — never changes which candidates are feasible/routed/accepted.
 *
 * Run with: npx tsx src/diagnostics/letter-occupancy.run.ts --prefix backend
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
import { buildWalkableWordShape } from '../generation/walkable-target';
import { scorePolylines } from '../scoring/shape-match';
import { computeInkOnlyOccupancy, type CandidateOccupancyRecord } from './letter-occupancy';
import { letterBoundariesFromWordShape, type LetterBoundarySet } from './multi-letter-trace';

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

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  status: string;
  graphFeasibleCount: number;
  boundarySet: LetterBoundarySet;
  candidates: CandidateOccupancyRecord[];
};

function buildOccupancyRecord(
  word: string,
  item: FeasibilityRecord,
  boundarySet: LetterBoundarySet,
): CandidateOccupancyRecord {
  const identity =
    item.pathPoints.length >= 2 && item.target.length >= 2
      ? analyzeTargetIdentity({ route: item.pathPoints, target: item.target, word, geometryVariant: item.geometryVariant ?? 'smooth' })
      : null;
  const scored = item.pathPoints.length >= 2 ? scorePolylines(item.pathPoints, item.target) : null;
  const ink = computeInkOnlyOccupancy({
    route: item.pathPoints,
    target: item.target,
    boundarySet,
    letterMeaningfullyVisited: identity?.letters.map((letter) => letter.meaningfullyVisited),
  });

  return {
    word,
    geometryVariant: item.geometryVariant ?? 'smooth',
    candidateRank: item.variantRank ?? -1,
    shapeScore: scored?.score ?? null,
    coverage: scored?.coverage ?? null,
    order: scored?.breakdown.order ?? null,
    backtracking: scored?.details.backtrackRatio ?? null,
    currentOccupiedSpan: identity?.targetSpan ?? 0,
    currentSpanOccupancy: identity?.spanOccupancy ?? 0,
    inkOnlyOccupancy: ink.inkOnlyOccupancy,
    letters: ink.perLetterOccupancy,
    completedLetterCount: identity?.lettersVisited ?? 0,
    expectedLetterCount: identity?.letters.length ?? boundarySet.boundaries.length,
    completionRatio: identity?.wordTraversal ?? 0,
    lettersVisitedInOrder: identity?.lettersVisitedInOrder ?? false,
    wordTraversal: identity?.traversesMostOfWord ?? false,
  };
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const wordShape = buildWalkableWordShape(testCase.word, { letterVariant: 'smooth' });
  const boundarySet = letterBoundariesFromWordShape(wordShape);
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const candidates = feasible.map((item) => buildOccupancyRecord(testCase.word, item, boundarySet));

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    status: report.status,
    graphFeasibleCount: feasible.length,
    boundarySet,
    candidates,
  };
}

function formatRecord(record: CandidateOccupancyRecord): string {
  return (
    `  rank=${record.candidateRank} [${record.geometryVariant}] shapeScore=${record.shapeScore?.toFixed(3) ?? 'n/a'} coverage=${record.coverage?.toFixed(3) ?? 'n/a'} order=${record.order?.toFixed(3) ?? 'n/a'} backtrack=${record.backtracking?.toFixed(3) ?? 'n/a'}` +
    `\n    currentOccupiedSpan=${record.currentOccupiedSpan.toFixed(3)} currentSpanOccupancy=${record.currentSpanOccupancy.toFixed(3)} inkOnlyOccupancy=${record.inkOnlyOccupancy.toFixed(3)}` +
    `\n    letters: ${record.letters.map((letter) => `${letter.letter}=${letter.occupancy.toFixed(2)}${letter.completed ? '*' : ''}`).join(' ')}` +
    `\n    completedLetterCount=${record.completedLetterCount}/${record.expectedLetterCount} completionRatio=${record.completionRatio.toFixed(3)} lettersVisitedInOrder=${record.lettersVisitedInOrder} wordTraversal=${record.wordTraversal}`
  );
}

function buildTextReport(cases: CaseReport[]): string {
  const lines: string[] = [
    'Ink-only occupancy diagnostics (DEVELOPMENT ONLY) — observation only, no algorithm/gate change.',
    '"*" after a letter\'s occupancy = meaningfullyVisited=true (reused from the existing TargetIdentity per-letter check).',
    '',
  ];
  for (const caseReport of cases) {
    lines.push(`=== ${caseReport.word} — ${caseReport.locationName} ${caseReport.targetDistanceMeters}m (status=${caseReport.status}, graphFeasible=${caseReport.graphFeasibleCount}) ===`);
    lines.push(
      `letter boundaries: ${caseReport.boundarySet.boundaries.map((b) => `${b.letter}[${b.projectedStartProgress.toFixed(2)}-${b.projectedEndProgress.toFixed(2)}]`).join(' ')}  interLetterGap=${((caseReport.boundarySet.interLetterGapLength / caseReport.boundarySet.totalFlattenedLength) * 100).toFixed(1)}%`,
    );
    if (caseReport.candidates.length === 0) {
      lines.push('(no graph-feasible candidates)');
      lines.push('');
      continue;
    }
    // Sort by currentOccupiedSpan desc so the "most span" candidates surface first, matching the task's own highlighted example.
    const sorted = [...caseReport.candidates].sort((a, b) => b.currentOccupiedSpan - a.currentOccupiedSpan);
    for (const record of sorted) {
      lines.push(formatRecord(record));
    }
    const meanInk = caseReport.candidates.reduce((sum, r) => sum + r.inkOnlyOccupancy, 0) / caseReport.candidates.length;
    const meanCurrent = caseReport.candidates.reduce((sum, r) => sum + r.currentOccupiedSpan, 0) / caseReport.candidates.length;
    lines.push(`  mean across feasible candidates: currentOccupiedSpan=${meanCurrent.toFixed(3)} inkOnlyOccupancy=${meanInk.toFixed(3)}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of CASES) {
    console.log(`[letter-occupancy] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[letter-occupancy] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'letter-occupancy-results.json');
  const textPath = resolve(DIAGNOSTIC_DIR, 'letter-occupancy-summary.txt');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');
  writeFileSync(textPath, buildTextReport(cases), 'utf8');

  console.log('');
  console.log(`[letter-occupancy] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[letter-occupancy] json: ${jsonPath}`);
  console.log(`[letter-occupancy] summary: ${textPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
