/**
 * DEVELOPMENT ONLY. Evaluates diagnostic-only per-letter goal-constraint
 * variants for the graph_constrained beam search, using
 * graph-shape-goal-mirror.ts (a parity-proven mirror of
 * routeGraphConstrainedShape) — never modifies graph-shape.ts.
 *
 * Three parts:
 *  (1) deep-dive TRUE REPLAY on the 3 known candidates (CAIRO strong-but-
 *      incomplete, highest-shapeScore ROBZ, accepted Z control) across a
 *      full threshold sweep of Variant A/C (min bin fraction) and
 *      Variant B (min bin hit count);
 *  (2) special-case tests: narrow letter (I in CAIRO, already covered by
 *      (1)), repeated letter (synthetic MIM, no live routing needed),
 *      loop shape (synthetic O, no live routing needed);
 *  (3) a smaller representative variant subset replayed across the FULL
 *      28-request native corpus from the prior task, comparing old
 *      (real/default goal) vs new (per-letter goal) funnel and quality —
 *      scoped down from every threshold to 3 representative configs
 *      because true replay requires re-fetching each request's corridor
 *      via the real network-dependent pipeline (~380s for 28 requests),
 *      while the mirror search itself is fast local computation once the
 *      corridor is available — see this file's header for the exact cost
 *      breakdown reported in Part 9 of the task.
 *
 * Pure observation — never modifies production. graph-shape.ts itself is
 * never touched; only graph-shape-goal-mirror.ts (a separate, parity-
 * proven diagnostic file) is exercised.
 *
 * Run with: npx tsx src/diagnostics/beam-search-goal-variant-evaluation.run.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

import { runExperimentalPipelineMultiVariant, type ExperimentalPipelineReport, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, REAL_ISGOAL, computeLetterBinRanges, type GoalCheckFn, type LetterBinRange } from './graph-shape-goal-mirror';
import { makeMinFractionGoal, makeMinHitCountGoal, findUnsatisfiableLetters, snapshotPerLetterCoverage } from './per-letter-goal-diagnostic';
import { scorePolylines } from '../scoring/shape-match';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { evaluateLetterCompleteness, evaluatePhysicalLayer } from './shadow-layered-gate-diagnostic';
import {
  assignRouteSamplesToLetters,
  deriveVisitationBlocks,
  deriveObservedSequence,
  evaluateSequenceIntegrity,
  computeVisitationConfidence,
  wordLetters,
} from './letter-sequence-integrity-diagnostic';
import { decomposeContinuity } from './continuity-decomposition-diagnostic';
import { decomposeTargetSpan } from './target-span-decomposition-diagnostic';
import { computeRecalibratedOrderModels } from './recalibrated-order-diagnostic';
import { EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

// ---------------------------------------------------------------------------
// Goal variants under test.
// ---------------------------------------------------------------------------

type Variant = { name: string; goalCheck: GoalCheckFn };

function withPerLetterConstraint(name: string, perLetterCheck: (state: Parameters<GoalCheckFn>[0]['state'], letterBins: readonly LetterBinRange[]) => boolean): Variant {
  return {
    name,
    goalCheck: (ctx) => {
      if (!REAL_ISGOAL(ctx)) return false;
      if (ctx.letterBins.length === 0) return true; // single-letter / no letter data: unchanged behavior
      return perLetterCheck(ctx.state, ctx.letterBins);
    },
  };
}

const FULL_SWEEP_VARIANTS: Variant[] = [
  { name: 'baseline (real goal, no per-letter constraint)', goalCheck: REAL_ISGOAL },
  withPerLetterConstraint('Variant A/C fraction X=0.20', makeMinFractionGoal(0.2)),
  withPerLetterConstraint('Variant A/C fraction X=0.30', makeMinFractionGoal(0.3)),
  withPerLetterConstraint('Variant A/C fraction X=0.40', makeMinFractionGoal(0.4)),
  withPerLetterConstraint('Variant A/C fraction X=0.50', makeMinFractionGoal(0.5)),
  withPerLetterConstraint('Variant B hits N=1', makeMinHitCountGoal(1)),
  withPerLetterConstraint('Variant B hits N=2', makeMinHitCountGoal(2)),
  withPerLetterConstraint('Variant B hits N=3', makeMinHitCountGoal(3)),
];

// Scoped down for the full 28-request corpus — see file header for why.
const CORPUS_VARIANTS: Variant[] = [
  { name: 'baseline (real goal)', goalCheck: REAL_ISGOAL },
  withPerLetterConstraint('Variant A/C fraction X=0.30', makeMinFractionGoal(0.3)),
  withPerLetterConstraint('Variant A/C fraction X=0.40', makeMinFractionGoal(0.4)),
  withPerLetterConstraint('Variant B hits N=2', makeMinHitCountGoal(2)),
];

// ---------------------------------------------------------------------------
// Quality evaluation on a mirror-produced route (real, validated functions).
// ---------------------------------------------------------------------------

function isMultiLetter(word: string): boolean {
  return word.replace(/[^A-Za-z]/g, '').length > 1;
}

type QualitySnapshot = {
  hasRoute: boolean;
  failure: string | null;
  targetCoverage: number;
  progressSpan: number;
  statesExplored: number;
  shapeScore: number | null;
  coverage: number | null;
  backtrack: number | null;
  lengthRatio: number | null;
  continuityValid: boolean | null;
  completenessPass: boolean | null;
  sequenceValid: boolean | null;
  rawOrder: number | null;
  recalibratedOrderB: number | null;
  perLetterCoverage: ReturnType<typeof snapshotPerLetterCoverage> | null;
};

function evaluateQuality(word: string, target: Vec2[], pathPoints: Vec2[], statesExplored: number, failure: string | null, targetCoverage: number, progressSpan: number, letterBins: LetterBinRange[], finalCovered: number | null): QualitySnapshot {
  if (pathPoints.length < 2) {
    return { hasRoute: false, failure, targetCoverage, progressSpan, statesExplored, shapeScore: null, coverage: null, backtrack: null, lengthRatio: null, continuityValid: null, completenessPass: null, sequenceValid: null, rawOrder: null, recalibratedOrderB: null, perLetterCoverage: null };
  }
  const scored = scorePolylines(pathPoints, target);
  const continuity = decomposeContinuity(word, target, pathPoints, 'smooth');
  const targetSpanDecomp = decomposeTargetSpan(word, target, pathPoints, 'smooth');
  let completenessPass: boolean | null = null;
  let sequenceValid: boolean | null = null;
  if (isMultiLetter(word)) {
    const { assignments, boundaries } = assignRouteSamplesToLetters(word, target, pathPoints, 'smooth');
    const blocks = deriveVisitationBlocks(assignments);
    const observed = deriveObservedSequence(blocks);
    const intended = wordLetters(word, 'smooth');
    const integrity = evaluateSequenceIntegrity(observed, intended);
    const visitation = computeVisitationConfidence(boundaries, blocks);
    const physical = evaluatePhysicalWordTraversal(word, target, pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
    const completeness = evaluateLetterCompleteness(physical, visitation);
    completenessPass = completeness.complete;
    sequenceValid = integrity.sequenceValid;
  }
  const recalibrated = computeRecalibratedOrderModels(pathPoints, target, word, 'smooth');
  return {
    hasRoute: true,
    failure,
    targetCoverage,
    progressSpan,
    statesExplored,
    shapeScore: scored.score,
    coverage: scored.coverage,
    backtrack: scored.details.backtrackRatio,
    lengthRatio: targetSpanDecomp.lengthRatioProjected,
    continuityValid: continuity.continuityValid,
    completenessPass,
    sequenceValid,
    rawOrder: scored.breakdown.order,
    recalibratedOrderB: recalibrated.B_perLetterCount.order,
    perLetterCoverage: finalCovered !== null ? snapshotPerLetterCoverage(finalCovered, letterBins) : null,
  };
}

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

function runVariantsOn(word: string, record: FeasibilityRecord, variants: readonly Variant[]) {
  const graph = reconstructGraph(record.graphLines);
  const kind = shapeKindFromWord(word);
  const shape = buildWalkableWordShape(word, { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const letterBins = computeLetterBinRanges(boundaries);
  const multiLetter = isMultiLetter(word);

  return variants.map((variant) => {
    const result = routeGraphConstrainedShapeMirror({ target: record.target, graph, kind, multiLetter, goalCheck: variant.goalCheck, letterBins });
    // We don't have direct access to the winning SearchState's `covered` bitmask from GraphShapeResult (it only exposes the final metrics/pathPoints) — reconstruct an equivalent snapshot by re-deriving letter coverage from the RETURNED pathPoints via the same per-letter measurement used in the prior task, for reporting purposes only.
    const quality = evaluateQuality(word, record.target, result.pathPoints, result.search.statesExplored, result.failure, result.metrics.targetCoverage, result.metrics.progressSpan, letterBins, null);
    return { variantName: variant.name, result, quality };
  });
}

async function fetchCandidate(word: string, locationName: string, start: typeof ZAMALEK, targetDistanceMeters: number, preferId?: string): Promise<{ report: ExperimentalPipelineReport; record: FeasibilityRecord | null; routeId: string | null }> {
  const report = await runExperimentalPipelineMultiVariant({ word, start, targetDistanceMeters }, ['smooth']);
  const feasibility = report.diagnostics.feasibility ?? [];
  let chosenId: string | null = null;
  if (preferId && report.routes.some((r) => r.id === preferId)) chosenId = preferId;
  if (!chosenId) chosenId = [...report.routes].sort((a, b) => b.shapeScore - a.shapeScore)[0]?.id ?? null;
  const record = chosenId ? feasibility.find((f) => f.placementId === chosenId) ?? null : null;
  return { report, record, routeId: chosenId };
}

function printVariantResults(label: string, word: string, runs: ReturnType<typeof runVariantsOn>) {
  console.log(`--- ${label} (${word}) ---`);
  for (const run of runs) {
    const q = run.quality;
    console.log(
      `  [${run.variantName}] failure=${run.result.failure ?? 'null'} targetCoverage=${run.result.metrics.targetCoverage.toFixed(3)} progressSpan=${run.result.metrics.progressSpan.toFixed(3)} statesExplored=${run.result.search.statesExplored} pathLen=${run.result.pathPoints.length} ` +
        `| shapeScore=${q.shapeScore?.toFixed(3) ?? 'N/A'} completeness=${q.completenessPass} sequenceValid=${q.sequenceValid} continuity=${q.continuityValid} lengthRatio=${q.lengthRatio?.toFixed(3) ?? 'N/A'} rawOrder=${q.rawOrder?.toFixed(3) ?? 'N/A'} recalibB=${q.recalibratedOrderB?.toFixed(3) ?? 'N/A'}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Part 2 — special cases needing no live routing (synthetic graphs).
// ---------------------------------------------------------------------------

function densify(points: readonly Vec2[], factor: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let s = 0; s < factor; s += 1) {
      const t = s / factor;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}
function buildDenseConnectedGraph(target: Vec2[]): ShapeGraph {
  const segments: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
  const steps = 16;
  for (let i = 0; i < steps; i += 1) {
    const a = target[Math.floor((i / steps) * (target.length - 1))]!;
    const b = target[Math.floor(((i + 1) / steps) * (target.length - 1))]!;
    segments.push({ id: `main${i}`, wayId: `wayMain${i}`, points: [{ ...a }, { ...b }] });
    segments.push({ id: `spur${i}`, wayId: `waySpur${i}`, points: [{ ...a }, { x: a.x + 4, y: a.y + 4 }] });
  }
  return buildShapeGraph(segments);
}
const SYNTH_SCALE = 150;
function scalePoints(points: readonly Vec2[], scale: number): Vec2[] {
  return points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
}

function runSpecialCases() {
  console.log('');
  console.log('=== PART 2: SPECIAL CASES (synthetic graphs, no live routing) ===');

  // Repeated letter: MIM.
  const mimShape = buildWalkableWordShape('MIM', { letterVariant: 'smooth' });
  const mimTarget = scalePoints(mimShape.points, SYNTH_SCALE);
  const mimGraph = buildDenseConnectedGraph(mimTarget);
  const mimBoundaries = letterBoundariesFromWordShape(mimShape).boundaries;
  const mimBins = computeLetterBinRanges(mimBoundaries);
  console.log(`MIM letter bin ranges: ${JSON.stringify(mimBins.map((b) => ({ letter: b.letter, binCount: b.bins.length })))}`);
  for (const x of [0.3, 0.5]) {
    const variant = withPerLetterConstraint(`fraction X=${x}`, makeMinFractionGoal(x));
    const result = routeGraphConstrainedShapeMirror({ target: mimTarget, graph: mimGraph, kind: 'generic', multiLetter: true, goalCheck: variant.goalCheck, letterBins: mimBins });
    console.log(`  MIM [${variant.name}]: failure=${result.failure ?? 'null'} targetCoverage=${result.metrics.targetCoverage.toFixed(3)} statesExplored=${result.search.statesExplored} pathLen=${result.pathPoints.length}`);
  }

  // Narrow letter unsatisfiable check for Variant B.
  for (const n of [1, 2, 3]) {
    const unsatisfiable = findUnsatisfiableLetters(mimBins, n);
    console.log(`  MIM Variant B hits=${n}: structurally unsatisfiable letters (bin count < ${n}): ${JSON.stringify(unsatisfiable)}`);
  }

  // Loop shape: O — must remain unaffected by per-letter constraints (single-letter, letterBins effectively moot since loop coverage>=0.7 dominates).
  const oShape = buildWalkableWordShape('O', { letterVariant: 'smooth' });
  const oTarget = scalePoints(oShape.points, SYNTH_SCALE);
  const oGraph = buildDenseConnectedGraph(oTarget);
  const oBoundaries = letterBoundariesFromWordShape(oShape).boundaries;
  const oBins = computeLetterBinRanges(oBoundaries);
  const oReal = routeGraphConstrainedShapeMirror({ target: oTarget, graph: oGraph, kind: 'O', multiLetter: false, goalCheck: REAL_ISGOAL });
  const oVariant = withPerLetterConstraint('fraction X=0.5', makeMinFractionGoal(0.5));
  const oNew = routeGraphConstrainedShapeMirror({ target: oTarget, graph: oGraph, kind: 'O', multiLetter: false, goalCheck: oVariant.goalCheck, letterBins: oBins });
  console.log(`  O (loop) baseline: failure=${oReal.failure ?? 'null'} targetCoverage=${oReal.metrics.targetCoverage.toFixed(3)} statesExplored=${oReal.search.statesExplored} pathLen=${oReal.pathPoints.length}`);
  console.log(`  O (loop) with per-letter fraction X=0.5 (should be IDENTICAL — loop path in withPerLetterConstraint short-circuits before per-letter check applies for multiLetter=false / single boundary): failure=${oNew.failure ?? 'null'} targetCoverage=${oNew.metrics.targetCoverage.toFixed(3)} statesExplored=${oNew.search.statesExplored} pathLen=${oNew.pathPoints.length}`);
  console.log(`  O loop unaffected: pathPoints identical=${JSON.stringify(oReal.pathPoints) === JSON.stringify(oNew.pathPoints)}`);
}

// ---------------------------------------------------------------------------
// Part 3 — full 28-request native corpus (scoped variant subset).
// ---------------------------------------------------------------------------

const WORDS = ['R', 'O', 'B', 'Z', 'L', 'ROBZ', 'CAIRO'];
const LOCATIONS: Array<{ name: string; start: typeof ZAMALEK }> = [
  { name: 'Alexandria', start: ALEXANDRIA },
  { name: 'Zamalek', start: ZAMALEK },
];
const DISTANCES = [2000, 4000];

async function runFullCorpus() {
  console.log('');
  console.log('=== PART 3: FULL 28-REQUEST NATIVE CORPUS (scoped variant subset) ===');
  const started = Date.now();

  type CorpusRow = { word: string; locationName: string; targetDistanceMeters: number; placementId: string; variantResults: ReturnType<typeof runVariantsOn> };
  const rows: CorpusRow[] = [];

  for (const word of WORDS) {
    for (const location of LOCATIONS) {
      for (const targetDistanceMeters of DISTANCES) {
        const report = await runExperimentalPipelineMultiVariant({ word, start: location.start, targetDistanceMeters }, ['smooth']);
        const feasibility = (report.diagnostics.feasibility ?? []).filter((f) => f.feasible && f.pathPoints.length >= 2);
        console.log(`[corpus] ${word} ${location.name} ${targetDistanceMeters}m: feasible=${feasibility.length}`);
        for (const record of feasibility) {
          const variantResults = runVariantsOn(word, record, CORPUS_VARIANTS);
          rows.push({ word, locationName: location.name, targetDistanceMeters, placementId: record.placementId, variantResults });
        }
      }
    }
  }

  console.log('');
  console.log(`=== CORPUS SUMMARY (n=${rows.length} feasible candidates replayed) ===`);
  for (const variant of CORPUS_VARIANTS) {
    const results = rows.map((r) => r.variantResults.find((v) => v.variantName === variant.name)!);
    const withRoute = results.filter((r) => r.result.pathPoints.length >= 2);
    const completePass = withRoute.filter((r) => r.quality.completenessPass !== false);
    const sequencePass = withRoute.filter((r) => r.quality.sequenceValid !== false);
    const unreachable = results.filter((r) => r.result.pathPoints.length < 2);
    const meanExpansions = results.length ? results.reduce((s, r) => s + r.result.search.statesExplored, 0) / results.length : 0;
    const meanShapeScore = withRoute.length ? withRoute.reduce((s, r) => s + (r.quality.shapeScore ?? 0), 0) / withRoute.length : 0;
    console.log(
      `[${variant.name}]: routesGenerated=${withRoute.length}/${results.length} completenessPass=${completePass.length} sequencePass=${sequencePass.length} unreachable=${unreachable.length} meanExpansions=${meanExpansions.toFixed(0)} meanShapeScore=${meanShapeScore.toFixed(3)}`,
    );
  }

  console.log('');
  console.log(`[corpus] done in ${Math.round((Date.now() - started) / 1000)}s`);
  return rows;
}

async function main() {
  const overallStart = Date.now();

  console.log('=== PART 1: DEEP-DIVE ON THE 3 KNOWN CANDIDATES (full threshold sweep) ===');
  const cairo = await fetchCandidate('CAIRO', 'Alexandria', ALEXANDRIA, 2000, 'sf-r22.5-s1.0-e282.8-n-282.8');
  if (cairo.record) {
    const runs = runVariantsOn('CAIRO', cairo.record, FULL_SWEEP_VARIANTS);
    printVariantResults('CAIRO strong-but-incomplete', 'CAIRO', runs);
  } else {
    console.log('CAIRO candidate not found in this run (native candidate set may have shifted).');
  }

  const robz = await fetchCandidate('ROBZ', 'Zamalek', ZAMALEK, 4000, 'sf-r315-s0.6-e-905.1-n905.1');
  if (robz.record) {
    const runs = runVariantsOn('ROBZ', robz.record, FULL_SWEEP_VARIANTS);
    printVariantResults('ROBZ highest-shapeScore', 'ROBZ', runs);
  } else {
    console.log('ROBZ candidate not found in this run.');
  }

  const zControl = await fetchCandidate('Z', 'Alexandria', ALEXANDRIA, 2000);
  if (zControl.record) {
    const runs = runVariantsOn('Z', zControl.record, FULL_SWEEP_VARIANTS);
    printVariantResults('Z accepted single-letter control', 'Z', runs);
  } else {
    console.log('Z control candidate not found in this run.');
  }

  runSpecialCases();

  const corpusRows = await runFullCorpus();

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'beam-search-goal-variant-evaluation-results.json');
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        graphShapeConstants: GRAPH_SHAPE,
        cairo: cairo.record ? runVariantsOn('CAIRO', cairo.record, FULL_SWEEP_VARIANTS).map((r) => ({ variant: r.variantName, failure: r.result.failure, metrics: r.result.metrics, statesExplored: r.result.search.statesExplored, quality: r.quality })) : null,
        corpusRowCount: corpusRows.length,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log('');
  console.log(`[beam-search-goal-variant-evaluation] done in ${Math.round((Date.now() - overallStart) / 1000)}s`);
  console.log(`[beam-search-goal-variant-evaluation] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
