/**
 * DEVELOPMENT ONLY. Native-candidate corpus audit — diagnostic only, never
 * called from the live route-generation/scoring/gate path, never wired
 * into anything, changes nothing.
 *
 * The 78-candidate diagnostic corpus used throughout the investigation
 * substituted checkpoint-v1 reconstructed routes onto graph-feasible
 * placements — checkpoint-v1 is confirmed unreachable from
 * routes/generate-routes-experimental.ts. This script instead measures the
 * PIPELINE'S OWN NATIVE `graph_constrained` candidates — exactly
 * report.routes from runExperimentalPipelineMultiVariant, the same array
 * toExperimentalUserResponse() filters for the live response — using the
 * REAL, unmodified production gate function
 * (experimentalProductRejectionReasons) for the authoritative accept/
 * reject decision, and the REAL, unmodified production diagnostics builder
 * (buildExperimentalViabilityDiagnostics) for the upstream funnel counts.
 *
 * Per-candidate completeness/sequence/continuity/targetSpan values are
 * computed by mirroring experimental-product.ts's OWN geometry conversion
 * exactly (same origin/shape selection, same coordinatesToLocalMeters
 * call) and calling the SAME diagnostic decomposition wrappers already
 * validated in prior tasks (decomposeContinuity, decomposeTargetSpan,
 * evaluateLetterCompleteness, evaluateSequenceIntegrity,
 * computeRecalibratedOrderModels) — nothing here reimplements any metric;
 * everything is either read directly off the real GeneratedRoute or
 * computed by an already-validated, unmodified diagnostic function.
 *
 * Run with: npx tsx src/diagnostics/native-candidate-corpus-audit.run.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import { experimentalProductRejectionReasons, meetsExperimentalProductThreshold, computeSupportingOrder, EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';
import { runExperimentalPipelineMultiVariant, type ExperimentalPipelineReport } from '../generation/graph-constrained-pipeline';
import { buildExperimentalViabilityDiagnostics } from '../generation/experimental-diagnostics';
import {
  assignRouteSamplesToLetters,
  deriveVisitationBlocks,
  deriveObservedSequence,
  evaluateSequenceIntegrity,
  computeVisitationConfidence,
  wordLetters,
} from './letter-sequence-integrity-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { evaluateLetterCompleteness, evaluatePhysicalLayer } from './shadow-layered-gate-diagnostic';
import { decomposeContinuity } from './continuity-decomposition-diagnostic';
import { decomposeTargetSpan } from './target-span-decomposition-diagnostic';
import { computeRecalibratedOrderModels } from './recalibrated-order-diagnostic';
import type { GeneratedRoute } from '../types';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const WORDS = ['R', 'O', 'B', 'Z', 'L', 'ROBZ', 'CAIRO'];
const LOCATIONS: Array<{ name: string; start: typeof ZAMALEK }> = [
  { name: 'Alexandria', start: ALEXANDRIA },
  { name: 'Zamalek', start: ZAMALEK },
];
const DISTANCES = [2000, 4000];

type RequestCase = { word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number };

const CASES: RequestCase[] = [];
for (const word of WORDS) {
  for (const location of LOCATIONS) {
    for (const targetDistanceMeters of DISTANCES) {
      CASES.push({ word, locationName: location.name, start: location.start, targetDistanceMeters });
    }
  }
}

// ---------------------------------------------------------------------------
// Geometry mirror — IDENTICAL to experimental-product.ts's private
// localGeometryFor(), duplicated here only because that function is not
// exported (it is a gate-internal helper); this reproduction is read-only
// and does not change or re-derive anything the gate itself doesn't do.
// ---------------------------------------------------------------------------
function localGeometryFor(route: GeneratedRoute): { route: Vec2[]; target: Vec2[]; geometryVariant: LetterShapeVariant } | null {
  const shape = route.shapeCoordinates ?? route.coordinates;
  if (shape.length < 2 || route.targetCoordinates.length < 2) return null;
  const origin = route.targetCoordinates[0] ?? shape[0] ?? { latitude: 0, longitude: 0 };
  return {
    route: coordinatesToLocalMeters(origin, shape),
    target: coordinatesToLocalMeters(origin, route.targetCoordinates),
    geometryVariant: route.metadata.geometryVariant ?? 'smooth',
  };
}

type CandidateRecord = {
  id: string;
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  rotationDegrees: number;
  scale: number;
  shapeScore: number;
  coverage: number;
  backtrack: number;
  largestGap: number | null;
  lengthRatio: number | null;
  connected: boolean;
  continuityValid: boolean | null;
  continuityWorstRatio: number | null;
  completenessPass: boolean | null;
  sequenceValid: boolean | null;
  observedSequence: string[] | null;
  missingLetters: string[] | null;
  reorderedPairs: Array<{ earlier: string; later: string }> | null;
  hasRevisit: boolean | null;
  rawOrder: number;
  recalibratedOrderB: number | null;
  targetSpan: number | null;
  wordTraversal: number | null;
  routeLengthMeters: number;
  physicalPass: boolean;
  gatePasses: boolean;
  gateReasons: string[];
  metricsAvailable: boolean;
  metricsUnavailableReason: string | null;
};

function isMultiLetter(word: string): boolean {
  return word.replace(/[^A-Za-z]/g, '').length > 1;
}

function analyzeCandidate(route: GeneratedRoute, testCase: RequestCase): CandidateRecord {
  const context = { word: testCase.word, targetDistance: testCase.targetDistanceMeters };
  const gateReasons = experimentalProductRejectionReasons(route, context);
  const gatePasses = meetsExperimentalProductThreshold(route, context);
  const recalibratedOrderB = computeSupportingOrder(route, context);

  const geometry = localGeometryFor(route);
  const base: Omit<CandidateRecord, 'metricsAvailable' | 'metricsUnavailableReason' | 'continuityValid' | 'continuityWorstRatio' | 'completenessPass' | 'sequenceValid' | 'observedSequence' | 'missingLetters' | 'reorderedPairs' | 'hasRevisit' | 'targetSpan' | 'wordTraversal' | 'physicalPass'> = {
    id: route.id,
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    rotationDegrees: route.metadata.rotationDegrees,
    scale: route.metadata.scale,
    shapeScore: route.shapeScore,
    coverage: route.coverage,
    backtrack: route.metadata.backtrackRatio,
    largestGap: route.metadata.largestGap ?? null,
    lengthRatio: null,
    connected: route.metadata.connected ?? (route.shapeCoordinates?.length ?? 0) >= 2,
    rawOrder: route.scoreBreakdown.order,
    recalibratedOrderB,
    routeLengthMeters: route.metadata.shapeRouteDistanceMeters ?? route.distanceMeters,
    gatePasses,
    gateReasons,
  };

  if (!geometry) {
    return {
      ...base,
      lengthRatio: null,
      continuityValid: null,
      continuityWorstRatio: null,
      completenessPass: null,
      sequenceValid: null,
      observedSequence: null,
      missingLetters: null,
      reorderedPairs: null,
      hasRevisit: null,
      targetSpan: null,
      wordTraversal: null,
      physicalPass: gatePasses,
      metricsAvailable: false,
      metricsUnavailableReason: 'insufficient shape/target coordinates for local-meters conversion (< 2 points)',
    };
  }

  const continuity = decomposeContinuity(testCase.word, geometry.target, geometry.route, geometry.geometryVariant);
  const targetSpanDecomp = decomposeTargetSpan(testCase.word, geometry.target, geometry.route, geometry.geometryVariant, testCase.targetDistanceMeters);
  const physicalLayer = evaluatePhysicalLayer({
    connected: base.connected,
    shapeScore: route.shapeScore,
    coverage: route.coverage,
    backtrack: route.metadata.backtrackRatio,
    largestGap: targetSpanDecomp.largestTargetGap,
    lengthRatio: targetSpanDecomp.lengthRatioProjected,
    continuityValid: continuity.continuityValid,
  });

  let completenessPass: boolean | null = null;
  let sequenceValid: boolean | null = null;
  let observedSequence: string[] | null = null;
  let missingLetters: string[] | null = null;
  let reorderedPairs: Array<{ earlier: string; later: string }> | null = null;
  let hasRevisit: boolean | null = null;

  if (isMultiLetter(testCase.word)) {
    const { assignments, boundaries } = assignRouteSamplesToLetters(testCase.word, geometry.target, geometry.route, geometry.geometryVariant);
    const blocks = deriveVisitationBlocks(assignments);
    const observed = deriveObservedSequence(blocks);
    const intended = wordLetters(testCase.word, geometry.geometryVariant);
    const integrity = evaluateSequenceIntegrity(observed, intended);
    const visitation = computeVisitationConfidence(boundaries, blocks);
    const physical = evaluatePhysicalWordTraversal(testCase.word, geometry.target, geometry.route, geometry.geometryVariant, PHYSICAL_TRAVERSAL_DEFAULTS);
    const completeness = evaluateLetterCompleteness(physical, visitation);
    completenessPass = completeness.complete;
    sequenceValid = integrity.sequenceValid;
    observedSequence = observed;
    missingLetters = completeness.missingLetters;
    reorderedPairs = integrity.reorderedPairs;
    hasRevisit = integrity.hasRevisit;
  }

  return {
    ...base,
    lengthRatio: targetSpanDecomp.lengthRatioProjected,
    continuityValid: continuity.continuityValid,
    continuityWorstRatio: continuity.worstRatio,
    completenessPass,
    sequenceValid,
    observedSequence,
    missingLetters,
    reorderedPairs,
    hasRevisit,
    targetSpan: targetSpanDecomp.targetSpan,
    wordTraversal: targetSpanDecomp.wordTraversal,
    physicalPass: physicalLayer.passes,
    metricsAvailable: true,
    metricsUnavailableReason: null,
    largestGap: targetSpanDecomp.largestTargetGap,
  };
}

type CaseSummary = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  nativeCandidateCount: number;
  routedBeforeProduct: number;
  graphFeasible: number;
  placementsEvaluated: number;
  productAccepted: number;
  candidates: CandidateRecord[];
};

async function runCase(testCase: RequestCase): Promise<CaseSummary> {
  const report: ExperimentalPipelineReport = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const request = { word: testCase.word, latitude: testCase.start.latitude, longitude: testCase.start.longitude, targetDistance: testCase.targetDistanceMeters };
  const diagnostics = buildExperimentalViabilityDiagnostics(request, report);

  const candidates = report.routes.map((route) => analyzeCandidate(route, testCase));

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    nativeCandidateCount: report.routes.length,
    routedBeforeProduct: diagnostics.stages.routedBeforeProduct,
    graphFeasible: diagnostics.stages.graphFeasible,
    placementsEvaluated: diagnostics.stages.placementsEvaluated,
    productAccepted: diagnostics.stages.productAccepted,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Aggregate analysis
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
function distribution(values: readonly number[]): { min: number; median: number; mean: number; max: number; n: number } {
  if (values.length === 0) return { min: 0, median: 0, mean: 0, max: 0, n: 0 };
  return { min: Math.min(...values), median: median(values), mean: mean(values), max: Math.max(...values), n: values.length };
}

function printFunnelAndBreakdown(allCandidates: CandidateRecord[], allCases: CaseSummary[]) {
  console.log('');
  console.log('=== NATIVE CORPUS SUMMARY ===');
  console.log(`Total requests: ${allCases.length}`);
  console.log(`Total native candidates (report.routes across all requests): ${allCandidates.length}`);
  const sumRoutedBeforeProduct = allCases.reduce((s, c) => s + c.routedBeforeProduct, 0);
  const sumGraphFeasible = allCases.reduce((s, c) => s + c.graphFeasible, 0);
  const sumPlacementsEvaluated = allCases.reduce((s, c) => s + c.placementsEvaluated, 0);
  const sumProductAccepted = allCases.reduce((s, c) => s + c.productAccepted, 0);
  console.log(`Sum placementsEvaluated: ${sumPlacementsEvaluated}`);
  console.log(`Sum graphFeasible: ${sumGraphFeasible}`);
  console.log(`Sum routedBeforeProduct (== native candidates, post-dedup, pre-gate): ${sumRoutedBeforeProduct}`);
  console.log(`Sum productAccepted (per pipeline's own diagnostics, single-variant path): ${sumProductAccepted}`);

  console.log('');
  console.log('=== GATE FUNNEL (over candidates with metricsAvailable=true) ===');
  const withMetrics = allCandidates.filter((c) => c.metricsAvailable);
  const withoutMetrics = allCandidates.filter((c) => !c.metricsAvailable);
  console.log(`Candidates with full metrics available: ${withMetrics.length}/${allCandidates.length} (${withoutMetrics.length} unavailable: ${JSON.stringify([...new Set(withoutMetrics.map((c) => c.metricsUnavailableReason))])})`);

  const physicalPass = withMetrics.filter((c) => c.physicalPass);
  const physicalAndCompleteness = physicalPass.filter((c) => c.completenessPass !== false);
  const physicalAndCompletenessAndSequence = physicalAndCompleteness.filter((c) => c.sequenceValid !== false);
  const accepted = withMetrics.filter((c) => c.gatePasses);
  console.log(`Generated (native, post-dedup): ${withMetrics.length}`);
  console.log(`Physical pass: ${physicalPass.length}`);
  console.log(`+ completeness (or single-letter, N/A treated as pass): ${physicalAndCompleteness.length}`);
  console.log(`+ sequence (or single-letter, N/A treated as pass): ${physicalAndCompletenessAndSequence.length}`);
  console.log(`Accepted (real gate function): ${accepted.length}`);

  console.log('');
  console.log('=== REJECTION REASON BREAKDOWN (real gate reasons, multiple per candidate) ===');
  const reasonCounts: Record<string, number> = {};
  for (const c of allCandidates) for (const r of c.gateReasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  console.log(JSON.stringify(reasonCounts, null, 2));

  console.log('');
  console.log('=== GENERATOR vs SEMANTIC vs MIXED FAILURE CLASSIFICATION ===');
  const rejected = withMetrics.filter((c) => !c.gatePasses);
  const physicalReasons = new Set(['connected', 'shapeScore', 'coverage', 'backtrack', 'largestGap', 'lengthRatio', 'continuity']);
  const semanticReasons = new Set(['completeness', 'sequenceIntegrity']);
  let generatorOnly = 0, semanticOnly = 0, mixed = 0;
  for (const c of rejected) {
    const hasPhysical = c.gateReasons.some((r) => physicalReasons.has(r));
    const hasSemantic = c.gateReasons.some((r) => semanticReasons.has(r));
    if (hasPhysical && hasSemantic) mixed += 1;
    else if (hasPhysical) generatorOnly += 1;
    else if (hasSemantic) semanticOnly += 1;
  }
  console.log(`Rejected total: ${rejected.length}`);
  console.log(`Generator/physical-only failure: ${generatorOnly}`);
  console.log(`Semantic-only failure (physical passed): ${semanticOnly}`);
  console.log(`Mixed (both physical and semantic failed): ${mixed}`);

  console.log('');
  console.log('=== ACCEPTED vs REJECTED DISTRIBUTIONS ===');
  const acceptedC = withMetrics.filter((c) => c.gatePasses);
  const rejectedC = withMetrics.filter((c) => !c.gatePasses);
  const metricsToReport: Array<[string, (c: CandidateRecord) => number | null]> = [
    ['shapeScore', (c) => c.shapeScore],
    ['coverage', (c) => c.coverage],
    ['backtrack', (c) => c.backtrack],
    ['largestGap', (c) => c.largestGap],
    ['lengthRatio', (c) => c.lengthRatio],
    ['continuityWorstRatio', (c) => c.continuityWorstRatio],
    ['rawOrder', (c) => c.rawOrder],
    ['recalibratedOrderB', (c) => c.recalibratedOrderB],
    ['targetSpan', (c) => c.targetSpan],
  ];
  for (const [label, getter] of metricsToReport) {
    const acceptedValues = acceptedC.map(getter).filter((v): v is number => v !== null && Number.isFinite(v));
    const rejectedValues = rejectedC.map(getter).filter((v): v is number => v !== null && Number.isFinite(v));
    const a = distribution(acceptedValues);
    const r = distribution(rejectedValues);
    console.log(`${label}: ACCEPTED n=${a.n} min=${a.min.toFixed(3)} median=${a.median.toFixed(3)} mean=${a.mean.toFixed(3)} max=${a.max.toFixed(3)} | REJECTED n=${r.n} min=${r.min.toFixed(3)} median=${r.median.toFixed(3)} mean=${r.mean.toFixed(3)} max=${r.max.toFixed(3)}`);
  }
  const acceptedCompleteness = acceptedC.filter((c) => c.completenessPass !== null);
  const rejectedCompleteness = rejectedC.filter((c) => c.completenessPass !== null);
  console.log(`completeness: ACCEPTED pass-rate=${acceptedCompleteness.length ? (acceptedCompleteness.filter((c) => c.completenessPass).length / acceptedCompleteness.length * 100).toFixed(1) : 'N/A'}% (n=${acceptedCompleteness.length}) | REJECTED pass-rate=${rejectedCompleteness.length ? (rejectedCompleteness.filter((c) => c.completenessPass).length / rejectedCompleteness.length * 100).toFixed(1) : 'N/A'}% (n=${rejectedCompleteness.length})`);
  const acceptedSeq = acceptedC.filter((c) => c.sequenceValid !== null);
  const rejectedSeq = rejectedC.filter((c) => c.sequenceValid !== null);
  console.log(`sequenceValid: ACCEPTED pass-rate=${acceptedSeq.length ? (acceptedSeq.filter((c) => c.sequenceValid).length / acceptedSeq.length * 100).toFixed(1) : 'N/A'}% (n=${acceptedSeq.length}) | REJECTED pass-rate=${rejectedSeq.length ? (rejectedSeq.filter((c) => c.sequenceValid).length / rejectedSeq.length * 100).toFixed(1) : 'N/A'}% (n=${rejectedSeq.length})`);

  console.log('');
  console.log('=== TOP 10 REJECTED CANDIDATES BY SHAPESCORE ===');
  const topRejected = [...rejectedC].sort((a, b) => b.shapeScore - a.shapeScore).slice(0, 10);
  for (const c of topRejected) {
    console.log(
      `  ${c.word} ${c.locationName} ${c.targetDistanceMeters}m [${c.id}]: shapeScore=${c.shapeScore.toFixed(3)} coverage=${c.coverage.toFixed(3)} physicalPass=${c.physicalPass} completeness=${c.completenessPass} sequenceValid=${c.sequenceValid} continuity=${c.continuityValid}(ratio=${c.continuityWorstRatio?.toFixed(2) ?? 'null'}) rawOrder=${c.rawOrder.toFixed(3)} recalibB=${c.recalibratedOrderB?.toFixed(3) ?? 'null'} targetSpan=${c.targetSpan?.toFixed(3) ?? 'null'} reasons=${JSON.stringify(c.gateReasons)} observed=${c.observedSequence?.join('->') ?? 'N/A'} missing=${JSON.stringify(c.missingLetters)}`,
    );
  }

  console.log('');
  console.log('=== ACCEPTED CANDIDATES (all) ===');
  for (const c of acceptedC) {
    console.log(
      `  ${c.word} ${c.locationName} ${c.targetDistanceMeters}m [${c.id}]: shapeScore=${c.shapeScore.toFixed(3)} completeness=${c.completenessPass} sequenceValid=${c.sequenceValid} continuity=${c.continuityValid} lengthRatio=${c.lengthRatio?.toFixed(3) ?? 'null'} rawOrder=${c.rawOrder.toFixed(3)} targetSpan=${c.targetSpan?.toFixed(3) ?? 'null'} routeLengthMeters=${c.routeLengthMeters.toFixed(0)}`,
    );
  }

  console.log('');
  console.log('=== CANDIDATE DIVERSITY PER REQUEST ===');
  for (const c of allCases) {
    const shapeScores = c.candidates.map((x) => x.shapeScore);
    const lengths = c.candidates.map((x) => x.routeLengthMeters);
    const rotations = new Set(c.candidates.map((x) => x.rotationDegrees));
    const scales = new Set(c.candidates.map((x) => x.scale));
    console.log(
      `${c.word} ${c.locationName} ${c.targetDistanceMeters}m: placementsEvaluated=${c.placementsEvaluated} graphFeasible=${c.graphFeasible} routedBeforeProduct/native=${c.routedBeforeProduct} accepted=${c.productAccepted} shapeScoreRange=[${shapeScores.length ? Math.min(...shapeScores).toFixed(3) : 'N/A'},${shapeScores.length ? Math.max(...shapeScores).toFixed(3) : 'N/A'}] lengthRange=[${lengths.length ? Math.min(...lengths).toFixed(0) : 'N/A'},${lengths.length ? Math.max(...lengths).toFixed(0) : 'N/A'}] uniqueRotations=${rotations.size} uniqueScales=${scales.size}`,
    );
  }
}

async function main() {
  const started = Date.now();
  console.log(`=== NATIVE CANDIDATE CORPUS AUDIT: ${CASES.length} requests ===`);
  const cases: CaseSummary[] = [];
  for (const testCase of CASES) {
    console.log(`[native-corpus] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    cases.push(result);
    console.log(`[native-corpus] done ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m -> native=${result.nativeCandidateCount} accepted=${result.productAccepted}`);
  }

  const allCandidates = cases.flatMap((c) => c.candidates);
  printFunnelAndBreakdown(allCandidates, cases);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'native-candidate-corpus-audit-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2), 'utf8');

  console.log('');
  console.log(`[native-corpus] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[native-corpus] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
