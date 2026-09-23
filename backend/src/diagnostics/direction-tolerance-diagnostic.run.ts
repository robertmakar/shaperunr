/**
 * DEVELOPMENT ONLY. Runs the shadow direction-tolerance evaluator (see
 * direction-tolerance-diagnostic.ts) against real ROBZ/CAIRO requests plus
 * single-letter controls, in-process (direct pipeline calls, no HTTP,
 * sequential by construction — no isolation issues, no change to any
 * production request timeout). Read-only: computes shadow directionFit at
 * several far-cutoff multipliers and angle scales alongside the existing,
 * unmodified TargetIdentity/scoreOrderedPath results — never changes which
 * candidates are feasible/routed/accepted, never changes the route
 * returned to the user.
 *
 * Run with: npx tsx src/diagnostics/direction-tolerance-diagnostic.run.ts --prefix backend
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';

import {
  ANGLE_SCALES_DEGREES,
  classifyDirectionBound,
  computeDirectionSegmentStats,
  computeDirectionShadowOrder,
  computeShadowDirectionFit,
  FAR_CUTOFF_MULTIPLIERS,
  type DirectionBoundClassification,
} from './direction-tolerance-diagnostic';
import {
  runExperimentalPipelineMultiVariant,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from '../generation/graph-constrained-pipeline';
import { analyzeTargetIdentity, TARGET_IDENTITY } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { classifyDirection, extractLetterOrderInputs } from './order-score-diagnostic';
import { scoreOrderedPath } from '@/lib/shape-order';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK: Coordinate = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA: Coordinate = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CASES: Array<{ word: string; locationName: string; start: Coordinate; targetDistanceMeters: number; role: 'multi-letter' | 'control' }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'multi-letter' },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'multi-letter' },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000, role: 'multi-letter' },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000, role: 'multi-letter' },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'multi-letter' },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'multi-letter' },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000, role: 'multi-letter' },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000, role: 'multi-letter' },
  { word: 'I', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'control' },
  { word: 'I', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'control' },
  { word: 'O', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000, role: 'control' },
  { word: 'O', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000, role: 'control' },
  { word: 'R', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'control' },
  { word: 'R', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'control' },
  { word: 'Z', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, role: 'control' },
  { word: 'Z', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000, role: 'control' },
];

// The "most informative combined cases" per task Section 5, tested only because the isolated sweeps (run inline per letter as the full FAR_CUTOFF_MULTIPLIERS / ANGLE_SCALES_DEGREES arrays) justify it.
const COMBINED_CASES: Array<{ label: string; farCutoffMultiplier: number; angleScaleDegrees: number }> = [
  { label: 'current', farCutoffMultiplier: 1, angleScaleDegrees: 90 },
  { label: '1.5x_120deg', farCutoffMultiplier: 1.5, angleScaleDegrees: 120 },
  { label: '2x_120deg', farCutoffMultiplier: 2, angleScaleDegrees: 120 },
  { label: '2x_135deg', farCutoffMultiplier: 2, angleScaleDegrees: 135 },
  { label: '3x_180deg', farCutoffMultiplier: 3, angleScaleDegrees: 180 },
];

type LetterRecord = {
  letter: string;
  index: number;
  direction: string;
  dtwFitProduction: number;
  progressFitProduction: number;
  directionFitProduction: number;
  orderProduction: number;
  meanAngularErrorDegrees: number | null;
  medianAngularErrorDegrees: number | null;
  maxAngularErrorDegrees: number | null;
  usableSegmentLength: number;
  totalRouteSegmentLength: number;
  farCutoffSegmentLength: number;
  farCutoffFraction: number;
  usableSegmentCount: number;
  farCutoffSegmentCount: number;
  degenerateSegmentCount: number;
  cutoffSweep: Record<string, { directionFit: number; order: number }>;
  angleSweep: Record<string, { directionFit: number; order: number }>;
  combinedSweep: Record<string, { directionFit: number; order: number }>;
  classification: DirectionBoundClassification;
};

type CandidateRecord = {
  candidateRank: number;
  geometryVariant: string;
  currentOccupiedSpan: number;
  letters: LetterRecord[];
};

type CaseReport = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  role: 'multi-letter' | 'control';
  status: string;
  graphFeasibleCount: number;
  candidates: CandidateRecord[];
};

function buildCandidateRecord(word: string, item: FeasibilityRecord): CandidateRecord | null {
  if (item.pathPoints.length < 2 || item.target.length < 2) {
    return null;
  }
  const geometryVariant = item.geometryVariant ?? 'smooth';
  const identity = analyzeTargetIdentity({ route: item.pathPoints, target: item.target, word, geometryVariant });
  const orderInputs = extractLetterOrderInputs(word, item.target, item.pathPoints, geometryVariant);

  const letters: LetterRecord[] = orderInputs.map((input, index) => {
    const real =
      input.letterTarget.length >= 2 && input.letterRoute.length >= 2
        ? scoreOrderedPath(input.letterRoute, input.sampledTarget, input.letterTarget, { orderDistanceScale: input.orderDistanceScale, coverageThreshold: input.coverageThreshold })
        : { dtwFit: 0, progressFit: 0, directionFit: 0, order: 0, dtwMeanDistanceMeters: Infinity, warpFit: 0, monotonicFit: 0, jumpFit: 0, revisitFit: 0 };
    const segmentStats = computeDirectionSegmentStats(input.letterRoute, input.letterTarget, input.coverageThreshold);

    const cutoffSweep: Record<string, { directionFit: number; order: number }> = {};
    for (const multiplier of FAR_CUTOFF_MULTIPLIERS) {
      const result = computeDirectionShadowOrder(input.letterRoute, input.letterTarget, input.coverageThreshold, real.dtwFit, real.progressFit, multiplier, 90);
      cutoffSweep[String(multiplier)] = { directionFit: result.shadowDirectionFit, order: result.shadowOrder };
    }
    const angleSweep: Record<string, { directionFit: number; order: number }> = {};
    for (const angle of ANGLE_SCALES_DEGREES) {
      const result = computeDirectionShadowOrder(input.letterRoute, input.letterTarget, input.coverageThreshold, real.dtwFit, real.progressFit, 1, angle);
      angleSweep[String(angle)] = { directionFit: result.shadowDirectionFit, order: result.shadowOrder };
    }
    const combinedSweep: Record<string, { directionFit: number; order: number }> = {};
    for (const combined of COMBINED_CASES) {
      const result = computeDirectionShadowOrder(input.letterRoute, input.letterTarget, input.coverageThreshold, real.dtwFit, real.progressFit, combined.farCutoffMultiplier, combined.angleScaleDegrees);
      combinedSweep[combined.label] = { directionFit: result.shadowDirectionFit, order: result.shadowOrder };
    }

    const cutoffRelaxed = computeShadowDirectionFit(input.letterRoute, input.letterTarget, input.coverageThreshold, 3, 90);
    const angleRelaxed = computeShadowDirectionFit(input.letterRoute, input.letterTarget, input.coverageThreshold, 1, 180);

    return {
      letter: input.letter,
      index,
      direction: classifyDirection(real.monotonicFit, input.letterRoute.length),
      dtwFitProduction: real.dtwFit,
      progressFitProduction: real.progressFit,
      directionFitProduction: real.directionFit,
      orderProduction: real.order,
      meanAngularErrorDegrees: segmentStats.meanAngularErrorDegrees,
      medianAngularErrorDegrees: segmentStats.medianAngularErrorDegrees,
      maxAngularErrorDegrees: segmentStats.maxAngularErrorDegrees,
      usableSegmentLength: segmentStats.usableSegmentLength,
      totalRouteSegmentLength: segmentStats.totalRouteSegmentLength,
      farCutoffSegmentLength: segmentStats.farCutoffSegmentLength,
      farCutoffFraction: segmentStats.farCutoffFraction,
      usableSegmentCount: segmentStats.usableSegmentCount,
      farCutoffSegmentCount: segmentStats.farCutoffSegmentCount,
      degenerateSegmentCount: segmentStats.degenerateSegmentCount,
      cutoffSweep,
      angleSweep,
      combinedSweep,
      classification: classifyDirectionBound(real.directionFit, cutoffRelaxed, angleRelaxed),
    };
  });

  return {
    candidateRank: item.variantRank ?? -1,
    geometryVariant,
    currentOccupiedSpan: identity.targetSpan,
    letters,
  };
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseReport> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const feasibility = report.diagnostics.feasibility ?? [];
  const feasible = feasibility.filter((item) => item.feasible);

  const candidates = feasible
    .map((item) => buildCandidateRecord(testCase.word, item))
    .filter((record): record is CandidateRecord => record !== null);

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    role: testCase.role,
    status: report.status,
    graphFeasibleCount: feasible.length,
    candidates,
  };
}

async function main() {
  const started = Date.now();
  const cases: CaseReport[] = [];
  for (const testCase of CASES) {
    console.log(`[direction-tolerance] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m (${testCase.role})...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[direction-tolerance] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> feasible=${result.graphFeasibleCount}`);
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'direction-tolerance-diagnostic-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[direction-tolerance] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[direction-tolerance] json: ${jsonPath}`);
  console.log(`[direction-tolerance] minLetterOrder threshold reference: ${TARGET_IDENTITY.minLetterOrder}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
