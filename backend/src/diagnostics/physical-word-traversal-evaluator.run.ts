/**
 * DEVELOPMENT ONLY. Runs the shadow physical-word-traversal evaluator
 * (see physical-word-traversal-evaluator.ts) against the EXACT SAME
 * 78-candidate checkpoint-v1 corpus already computed by three prior
 * diagnostic tasks — reusing their persisted JSON output rather than
 * regenerating any routes (index-alignment across the three files was
 * verified directly before writing this script: identical case/candidate
 * counts and candidateRank sequences at every position):
 *
 *   word-traversal-diagnostic-results.json         -> current traversesMostOfWord per candidate
 *   evaluator-synthesis-diagnostic-results.json     -> per-letter rawInk/coverage/medianGlobalProgress/
 *                                                       order/meaningfullyVisited/dtwFit/progressFit/
 *                                                       directionFit/monotonicFit/jumpFit/revisitFit
 *   checkpoint-v1-benchmark-results.json            -> candidate-level shapeScore/targetSpan/distanceRatio/backtrack
 *
 * The shadow evaluator itself is the REAL, unmodified
 * evaluatePhysicalWordTraversalFromLetters() — this script only feeds it
 * already-computed per-letter data, exactly as evaluatePhysicalWordTraversal()
 * would if called on a live route (proven via the self-test's parity
 * check F).
 *
 * Pure observation — never modifies production, checkpoint-v1, scoring,
 * or the product gate.
 *
 * Run with: npx tsx src/diagnostics/physical-word-traversal-evaluator.run.ts --prefix backend
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluatePhysicalWordTraversalFromLetters,
  PHYSICAL_TRAVERSAL_DEFAULTS,
  type PhysicalLetterInput,
  type PhysicalTraversalThresholds,
} from './physical-word-traversal-evaluator';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const wordTraversalData = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'word-traversal-diagnostic-results.json'), 'utf8'));
const synthesisData = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'evaluator-synthesis-diagnostic-results.json'), 'utf8'));
const benchmarkData = JSON.parse(readFileSync(resolve(DIAGNOSTIC_DIR, 'checkpoint-v1-benchmark-results.json'), 'utf8'));

type StrokeFidelity = { dtwFit: number; progressFit: number; directionFit: number; monotonicFit: number; jumpFit: number; revisitFit: number; order: number; meaningfullyVisited: boolean };

type CandidateRecord = {
  caseIndex: number;
  candidateIndex: number;
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  candidateRank: number;
  currentWordTraversal: boolean;
  shadowResult: ReturnType<typeof evaluatePhysicalWordTraversalFromLetters>;
  strokeFidelity: StrokeFidelity[];
  shapeScore: number | null;
  targetSpan: number;
  distanceRatio: number;
  backtrack: number | null;
  coverage: number | null;
};

function buildCandidateRecords(thresholds: PhysicalTraversalThresholds = PHYSICAL_TRAVERSAL_DEFAULTS): CandidateRecord[] {
  const records: CandidateRecord[] = [];
  for (let i = 0; i < wordTraversalData.cases.length; i += 1) {
    const wtCase = wordTraversalData.cases[i];
    const synthCase = synthesisData.cases[i];
    const benchCase = benchmarkData.cases[i];
    for (let j = 0; j < wtCase.candidates.length; j += 1) {
      const wtCand = wtCase.candidates[j];
      const synthCand = synthCase.candidates[j];
      const benchCand = benchCase.candidates[j];
      const letterInputs: PhysicalLetterInput[] = synthCand.checkpointV1.map((l: any) => ({
        index: l.index,
        letter: l.letter,
        rawInkCoverage: l.rawInk,
        coverage: l.coverage,
        medianProgress: l.medianGlobalProgress,
      }));
      const shadowResult = evaluatePhysicalWordTraversalFromLetters(letterInputs, thresholds);
      const strokeFidelity: StrokeFidelity[] = synthCand.checkpointV1.map((l: any) => ({
        dtwFit: l.dtwFit,
        progressFit: l.progressFit,
        directionFit: l.directionFit,
        monotonicFit: l.monotonicFit,
        jumpFit: l.jumpFit,
        revisitFit: l.revisitFit,
        order: l.order,
        meaningfullyVisited: l.meaningfullyVisited,
      }));
      records.push({
        caseIndex: i,
        candidateIndex: j,
        word: wtCase.word,
        locationName: wtCase.locationName,
        targetDistanceMeters: wtCase.targetDistanceMeters,
        candidateRank: wtCand.candidateRank,
        currentWordTraversal: wtCand.checkpointV1.traversesMostOfWord,
        shadowResult,
        strokeFidelity,
        shapeScore: benchCand.checkpointV1.routeQuality.shapeScore,
        targetSpan: benchCand.checkpointV1.routeQuality.targetSpan,
        distanceRatio: benchCand.checkpointV1.routeQuality.distanceRatio,
        backtrack: benchCand.checkpointV1.routeQuality.backtrack,
        coverage: benchCand.checkpointV1.routeQuality.coverage,
      });
    }
  }
  return records;
}

function main() {
  const records = buildCandidateRecords();

  const jsonPath = resolve(DIAGNOSTIC_DIR, 'physical-word-traversal-evaluator-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), thresholds: PHYSICAL_TRAVERSAL_DEFAULTS, records }, null, 2), 'utf8');

  console.log(`[physical-word-traversal-evaluator] total candidates: ${records.length}`);
  console.log(`[physical-word-traversal-evaluator] json: ${jsonPath}`);
}

main();

export { buildCandidateRecords };
