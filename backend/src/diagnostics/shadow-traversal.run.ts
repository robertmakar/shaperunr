/**
 * DEVELOPMENT ONLY. Runs the shadow traversal evaluators (see
 * shadow-traversal.ts) against real ROBZ/CAIRO requests, in-process (direct
 * pipeline calls, no HTTP, sequential by construction — no isolation issues).
 * Read-only: computes alternative diagnostic traversal definitions alongside
 * the existing, unmodified TargetIdentity result — never changes which
 * candidates are feasible/routed/accepted, never changes the route returned
 * to the user.
 *
 * Run with: npx tsx src/diagnostics/shadow-traversal.run.ts --prefix backend
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
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { buildTraversalTrace, letterBoundariesFromWordShape, type LetterBoundarySet } from './multi-letter-trace';
import { buildShadowDecisionRecord, type DecisionCategory, type ShadowDecisionRecord } from './shadow-traversal';

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
  candidates: ShadowDecisionRecord[];
};

function buildRecord(word: string, item: FeasibilityRecord, boundarySet: LetterBoundarySet): ShadowDecisionRecord | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) {
    return null;
  }
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const identity = analyzeTargetIdentity({ route: item.pathPoints, target: item.target, word, geometryVariant });
  scorePolylines(item.pathPoints, item.target); // kept for parity with letter-occupancy.run.ts's candidate inspection; not used by the shadow evaluators themselves
  const inkResult = computeInkOnlyOccupancy({
    route: item.pathPoints,
    target: item.target,
    boundarySet,
    letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited),
  });
  const trace = buildTraversalTrace({
    pathPoints: item.pathPoints,
    target: item.target,
    boundaries: boundarySet.boundaries,
    expectedLetters: word.split(''),
    actualWordTraversal: identity.traversesMostOfWord,
  });
  return buildShadowDecisionRecord({
    word,
    geometryVariant,
    candidateRank: item.variantRank ?? -1,
    identity,
    inkResult,
    trace,
  });
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

  const candidates = feasible
    .map((item) => buildRecord(testCase.word, item, boundarySet))
    .filter((record): record is ShadowDecisionRecord => record !== null);

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

function formatRecord(record: ShadowDecisionRecord): string {
  const thresholdSummary = record.completionByThreshold.map((entry) => `${entry.threshold}:${entry.lettersCompleted}/${entry.expectedLetters}`).join(' ');
  return (
    `  rank=${record.candidateRank} [${record.geometryVariant}] currentWordTraversal=${record.currentWordTraversal} inkAwareTraversal=${record.inkAwareTraversal} inkOnlyOccupancy=${record.inkOnlyOccupancy.toFixed(3)}` +
    `\n    letters: ${record.letters.map((l) => `${l.letter} ink=${l.rawInkOccupancy.toFixed(2)} cov=${l.existingCoverage.toFixed(2)} ord=${l.existingOrder.toFixed(2)}${l.existingMeaningfullyVisited ? '*' : ''}`).join(' ')}` +
    `\n    completionByThreshold: ${thresholdSummary}` +
    `\n    allLettersCovered=${record.allLettersCovered} allLettersCoveredAndOrdered=${record.allLettersCoveredAndOrdered} visitedLettersInOrder=${record.visitedLettersInOrder} firstMissingLetter=${record.firstMissingLetter ?? 'none'}` +
    `\n    decisionCategory=${record.decisionCategory}`
  );
}

function buildTextReport(cases: CaseReport[]): string {
  const lines: string[] = [
    'Shadow traversal evaluator diagnostics (DEVELOPMENT ONLY) — observation only, no algorithm/gate change.',
    '"*" after a letter = existingMeaningfullyVisited=true (the existing, unmodified per-letter gate).',
    '',
  ];
  const globalCategoryCounts = new Map<DecisionCategory, number>();
  let globalTotal = 0;

  for (const caseReport of cases) {
    lines.push(`=== ${caseReport.word} — ${caseReport.locationName} ${caseReport.targetDistanceMeters}m (status=${caseReport.status}, graphFeasible=${caseReport.graphFeasibleCount}) ===`);
    if (caseReport.candidates.length === 0) {
      lines.push('(no graph-feasible candidates)');
      lines.push('');
      continue;
    }
    const sorted = [...caseReport.candidates].sort((a, b) => b.inkOnlyOccupancy - a.inkOnlyOccupancy);
    for (const record of sorted) {
      lines.push(formatRecord(record));
      globalTotal += 1;
      globalCategoryCounts.set(record.decisionCategory, (globalCategoryCounts.get(record.decisionCategory) ?? 0) + 1);
    }
    lines.push('');
  }

  lines.push('=== Global decision matrix (all cases pooled) ===');
  lines.push(`total candidates=${globalTotal}`);
  for (const category of ['current_passes', 'ink_aware_passes', 'covered_and_ordered', 'covered_not_ordered', 'missing_letter', 'neither'] as DecisionCategory[]) {
    lines.push(`  ${category}: ${globalCategoryCounts.get(category) ?? 0}`);
  }
  return lines.join('\n');
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of CASES) {
    console.log(`[shadow-traversal] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[shadow-traversal] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'shadow-traversal-results.json');
  const textPath = resolve(DIAGNOSTIC_DIR, 'shadow-traversal-summary.txt');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');
  writeFileSync(textPath, buildTextReport(cases), 'utf8');

  console.log('');
  console.log(`[shadow-traversal] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[shadow-traversal] json: ${jsonPath}`);
  console.log(`[shadow-traversal] summary: ${textPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
