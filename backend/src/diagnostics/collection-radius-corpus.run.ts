/**
 * DEVELOPMENT ONLY. Corpus-wide counterfactual: neighborhood /locate radius
 * 170m (production) vs 230m, everything else identical. Same ROBZ + CAIRO
 * corpus (Alexandria/Zamalek × 2000/4000m, 'smooth') used by every prior
 * Z/O diagnostic.
 *
 * PRIMARY (placement-matched): the production pipeline's feasible records
 * (38 Z / 40 O) fix the placements and targets; each identical target is
 * routed on the 170m and on the 230m collection with the unchanged corridor
 * filter, buildShapeGraph, production routeGraphConstrainedShape and
 * isFeasible. The 170m routing is checked against the production record
 * (corridor + path) for every candidate.
 * SECONDARY (pipeline-level): the full pipeline with the 230m collection
 * injected (placement ranking may reshuffle when the collection changes).
 *
 * No production file is modified; graph-shape.ts is untouched.
 * Run with: npx tsx src/diagnostics/collection-radius-corpus.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, type GraphShapeResult } from '../generation/graph-shape';
import { collectNeighborhoodShapeGraph, NEIGHBORHOOD_COLLECT, shapeKindFromWord, type ShapeGraphCollection } from '../generation/graph-shape-router';
import { snapSearchOrigin, searchOriginFromSnap } from '../generation/snap-search-origin';
import { getSearchRadiusForTargetDistance } from '../generation/search-radius';
import { filterCorridorSegments, isFeasible } from '../generation/shape-discovery';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror } from './graph-shape-goal-mirror';
import { routeQuality } from './goal-threshold-diagnostic';
import { analyzeStrokeTraversal, buildRoutePieces } from './z-diagonal-direction-diagnostic';
import { measureSubStrokeCoverage } from './z-checkpoint-repair-experiment';
import { connectedComponents } from './graph-fragment-audit';
import { createBeamTracer, pathOf } from './beam-survival-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const CASES = [
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];
const RADII = [NEIGHBORHOOD_COLLECT.locateRadiusMeters, 230] as const;
/** Beam states pre-filtered by final-letter ink (>= inkThreshold) and evaluated for physical + in-order completion, best-ink/lowest-cost first. */
const MAX_BEAM_EVALUATIONS = 80;
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const mean = (v: readonly number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : Number.NaN);

type RadiusOutcome = {
  radius: number;
  feasible: boolean;
  failure: string | null;
  shapeScore: number;
  targetCoverage: number;
  routeTarget: number;
  routeLengthMeters: number;
  headingAgreement: number;
  finalLetterPhysical: boolean;
  finalLetterCoverage: number;
  finalLetterInOrder: boolean;
  wordPhysical: boolean;
  inOrderCompleteInAnyBeamState: boolean;
  inOrderCompleteGoalState: boolean;
  corridorEdges: number;
  components: number;
  statesExplored: number;
  searchMs: number;
  usesEdgesAbsentAt170: number;
  path: Vec2[];
};

type CaseRow = { word: string; caseLabel: string; placementId: string; parity170: boolean; r170: RadiusOutcome; r230: RadiusOutcome; classification: string; routeChanged: boolean };

function inOrderComplete(word: string, target: Vec2[], path: Vec2[], finalBoundary: LetterBoundary): { physical: boolean; coverage: number; inOrder: boolean; wordPhysical: boolean } {
  if (path.length < 2) return { physical: false, coverage: 0, inOrder: false, wordPhysical: false };
  const phys = evaluatePhysicalWordTraversal(word, target, path, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const fl = phys.letters[phys.letters.length - 1]!;
  const trav = analyzeStrokeTraversal(buildRoutePieces(path, target), target, { label: finalBoundary.letter, start: finalBoundary.projectedStartProgress, end: finalBoundary.projectedEndProgress });
  return { physical: fl.physicallyCovered, coverage: fl.coverage, inOrder: fl.physicallyCovered && trav.category === 'A_correct', wordPhysical: phys.wordTraversalPhysical };
}

function routeOn(word: string, target: Vec2[], collection: ShapeGraphCollection, radius: number, finalBoundary: LetterBoundary, edges170: ReadonlySet<string>): RadiusOutcome {
  const kind = shapeKindFromWord(word);
  const corridor = filterCorridorSegments(collection.segments, target);
  const graph = buildShapeGraph(corridor);
  const t0 = performance.now();
  const result: GraphShapeResult = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
  const searchMs = performance.now() - t0;
  const q = result.pathPoints.length >= 2 ? routeQuality(word, target, result.pathPoints, result.failure) : null;
  const ret = inOrderComplete(word, target, result.pathPoints, finalBoundary);

  // Existence of an in-order physically complete final letter in ANY beam state (mirror + tracer, parity-proven).
  const { observer, trace } = createBeamTracer();
  routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
  const range = [{ label: 'final', start: finalBoundary.projectedStartProgress, end: finalBoundary.projectedEndProgress }];
  const beam = trace.records.filter((r) => r.fate === 'survived' || r.fate === 'start');
  const inked = beam
    .map((r) => {
      const path = pathOf(r.state, trace.directed);
      const ink = path.length >= 2 ? measureSubStrokeCoverage(path, target, range)[0]!.occupancy : 0;
      return { r, path, ink };
    })
    .filter((x) => x.ink >= PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold)
    .sort((a, b) => b.ink - a.ink || a.r.state.cost - b.r.state.cost)
    .slice(0, MAX_BEAM_EVALUATIONS);
  let anyState = false;
  let goalState = false;
  for (const x of inked) {
    if (inOrderComplete(word, target, x.path, finalBoundary).inOrder) {
      anyState = true;
      if (x.r.isGoal) goalState = true;
      if (goalState) break;
    }
  }
  const usedEdges = new Set(result.edgeIds.map((id) => id.replace(/#start$/, '').replace(/[><]$/, '')));
  return {
    radius,
    feasible: isFeasible(result),
    failure: result.failure,
    shapeScore: q?.shapeScore ?? 0,
    targetCoverage: result.metrics.targetCoverage,
    routeTarget: q?.routeTarget ?? 0,
    routeLengthMeters: polylineLength(result.pathPoints),
    headingAgreement: result.metrics.headingAgreement,
    finalLetterPhysical: ret.physical,
    finalLetterCoverage: ret.coverage,
    finalLetterInOrder: ret.inOrder,
    wordPhysical: ret.wordPhysical,
    inOrderCompleteInAnyBeamState: anyState,
    inOrderCompleteGoalState: goalState,
    corridorEdges: corridor.length,
    components: connectedComponents(graph).sizes.size,
    statesExplored: result.search.statesExplored,
    searchMs,
    usesEdgesAbsentAt170: [...usedEdges].filter((id) => !edges170.has(id)).length,
    path: result.pathPoints,
  };
}

function classify(a: RadiusOutcome, b: RadiusOutcome, routeChanged: boolean): string {
  if (!a.feasible && b.feasible) return 'newly_feasible';
  if (a.feasible && !b.feasible) return 'newly_infeasible';
  if (!routeChanged) return 'unchanged';
  const improved = (b.finalLetterInOrder && !a.finalLetterInOrder) || (b.finalLetterPhysical && !a.finalLetterPhysical) || (b.finalLetterCoverage - a.finalLetterCoverage > 0.05 && b.shapeScore >= a.shapeScore - 0.03);
  const regressed = (a.finalLetterInOrder && !b.finalLetterInOrder) || (a.finalLetterPhysical && !b.finalLetterPhysical) || a.finalLetterCoverage - b.finalLetterCoverage > 0.05 || a.shapeScore - b.shapeScore > 0.03;
  if (improved && !regressed) return 'improved';
  if (regressed && !improved) return 'regressed';
  if (improved && regressed) return 'mixed';
  return 'unchanged_quality'; // route changed but no threshold crossed
}

async function main() {
  const started = Date.now();
  const rows: CaseRow[] = [];
  const caseStats: Array<Record<string, unknown>> = [];
  for (const word of ['ROBZ', 'CAIRO']) {
    const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
    const finalBoundary = boundaries[boundaries.length - 1]!;
    for (const tc of CASES) {
      const caseLabel = `${tc.locationName}/${tc.targetDistanceMeters}`;
      const input = { word, start: tc.start, targetDistanceMeters: tc.targetDistanceMeters };
      const prodReport = await runExperimentalPipelineMultiVariant(input, ['smooth']);
      const records: FeasibilityRecord[] = (prodReport.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2);

      const originSnap = await snapSearchOrigin(tc.start);
      const searchOrigin = searchOriginFromSnap(originSnap);
      const radius = getSearchRadiusForTargetDistance(tc.targetDistanceMeters);
      const collections: Record<number, { c: ShapeGraphCollection; ms: number }> = {};
      for (const r of RADII) {
        const t0 = performance.now();
        const c = await collectNeighborhoodShapeGraph(searchOrigin, { radiusMeters: radius, locateRadiusMeters: r });
        collections[r] = { c, ms: performance.now() - t0 };
      }
      const edges170 = new Set(collections[170]!.c.segments.map((s) => s.id));
      const cf = await runExperimentalPipelineMultiVariant(input, ['smooth'], { collection: collections[230]!.c, searchOriginSnap: originSnap });
      const cfFeasible = (cf.diagnostics.feasibility ?? []).filter((r) => r.feasible);
      caseStats.push({
        word,
        caseLabel,
        raw170: collections[170]!.c.segments.length,
        raw230: collections[230]!.c.segments.length,
        calls170: collections[170]!.c.valhallaCalls,
        calls230: collections[230]!.c.valhallaCalls,
        collectMs170: Math.round(collections[170]!.ms),
        collectMs230: Math.round(collections[230]!.ms),
        pipelineFeasible170: records.length,
        pipelineFeasible230: cfFeasible.length,
        routes170: prodReport.routes.map((r) => ({ id: r.id, shapeScore: r.shapeScore })),
        routes230: cf.routes.map((r) => ({ id: r.id, shapeScore: r.shapeScore })),
        overlapFeasiblePlacements: cfFeasible.filter((r) => records.some((p) => p.placementId === r.placementId)).length,
      });
      console.log(`[case] ${word} ${caseLabel}: raw edges 170m=${collections[170]!.c.segments.length} 230m=${collections[230]!.c.segments.length} (+${f((100 * (collections[230]!.c.segments.length - collections[170]!.c.segments.length)) / collections[170]!.c.segments.length, 1)}%), locate calls ${collections[170]!.c.valhallaCalls}/${collections[230]!.c.valhallaCalls}, collect ${Math.round(collections[170]!.ms)}ms/${Math.round(collections[230]!.ms)}ms; feasible placements ${records.length}`);

      for (const record of records) {
        const r170 = routeOn(word, record.target, collections[170]!.c, 170, finalBoundary, edges170);
        const r230 = routeOn(word, record.target, collections[230]!.c, 230, finalBoundary, edges170);
        const parity170 = JSON.stringify(r170.path) === JSON.stringify(record.pathPoints) && r170.corridorEdges === record.graphLines.length;
        const routeChanged = JSON.stringify(r170.path) !== JSON.stringify(r230.path);
        rows.push({ word, caseLabel, placementId: record.placementId, parity170, r170, r230, routeChanged, classification: classify(r170, r230, routeChanged) });
      }
    }
  }

  // ------------------------------------------------------------ REPORT
  const z = rows.filter((r) => r.word === 'ROBZ');
  const o = rows.filter((r) => r.word === 'CAIRO');
  console.log('');
  console.log(`=== PARITY === 170m placement-matched routing reproduces the production record (path + corridor size): ${rows.filter((r) => r.parity170).length}/${rows.length}`);
  console.log('');
  console.log('=== COLLECTION SIZE / COST (per case) ===');
  console.log('| case | raw 170 | raw 230 | Δ% | locate calls 170/230 | collect ms 170/230 | pipeline feasible 170/230 (overlap) | routed 170 → 230 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const s of caseStats) {
    const r170 = (s.routes170 as Array<{ id: string; shapeScore: number }>).map((r) => `${r.id}(${r.shapeScore.toFixed(2)})`).join(' ');
    const r230 = (s.routes230 as Array<{ id: string; shapeScore: number }>).map((r) => `${r.id}(${r.shapeScore.toFixed(2)})`).join(' ');
    console.log(`| ${s.word} ${s.caseLabel} | ${s.raw170} | ${s.raw230} | +${f((100 * ((s.raw230 as number) - (s.raw170 as number))) / (s.raw170 as number), 1)} | ${s.calls170}/${s.calls230} | ${s.collectMs170}/${s.collectMs230} | ${s.pipelineFeasible170}/${s.pipelineFeasible230} (${s.overlapFeasiblePlacements}) | ${r170} → ${r230} |`);
  }

  const table = (label: string, rs: CaseRow[]) => {
    const g = (sel: (r: CaseRow) => RadiusOutcome) => {
      const xs = rs.map(sel);
      return {
        feasible: xs.filter((x) => x.feasible).length,
        finalPhys: xs.filter((x) => x.finalLetterPhysical).length,
        finalInOrder: xs.filter((x) => x.finalLetterInOrder).length,
        anyState: xs.filter((x) => x.inOrderCompleteInAnyBeamState).length,
        goalState: xs.filter((x) => x.inOrderCompleteGoalState).length,
        word: xs.filter((x) => x.wordPhysical).length,
        shape: mean(xs.map((x) => x.shapeScore)),
        cov: mean(xs.map((x) => x.targetCoverage)),
        rt: mean(xs.map((x) => x.routeTarget)),
        len: mean(xs.map((x) => x.routeLengthMeters)),
        head: mean(xs.map((x) => x.headingAgreement)),
        fcov: mean(xs.map((x) => x.finalLetterCoverage)),
        corr: mean(xs.map((x) => x.corridorEdges)),
        comps: mean(xs.map((x) => x.components)),
        states: mean(xs.map((x) => x.statesExplored)),
        ms: mean(xs.map((x) => x.searchMs)),
      };
    };
    const a = g((r) => r.r170);
    const b = g((r) => r.r230);
    console.log(`  ${label} (n=${rs.length})`);
    console.log('  | metric | 170m | 230m |');
    console.log('  |---|---|---|');
    for (const [k, fmt] of [['feasible', 0], ['finalPhys', 0], ['finalInOrder', 0], ['anyState', 0], ['goalState', 0], ['word', 0], ['fcov', 3], ['shape', 3], ['cov', 3], ['rt', 3], ['len', 0], ['head', 3], ['corr', 1], ['comps', 2], ['states', 0], ['ms', 1]] as const) {
      const names: Record<string, string> = { feasible: 'returned route feasible', finalPhys: 'final letter physically complete (returned)', finalInOrder: 'final letter physically complete IN ORDER (returned)', anyState: 'in-order complete final letter in ANY beam state', goalState: 'in-order complete final letter in a GOAL state', word: 'whole word physical', fcov: 'final-letter coverage (mean)', shape: 'shapeScore (mean)', cov: 'targetCoverage (mean)', rt: 'route/target (mean)', len: 'route length m (mean)', head: 'heading agreement (mean)', corr: 'corridor edges (mean)', comps: 'corridor components (mean)', states: 'states explored (mean)', ms: 'search ms (mean)' };
      console.log(`  | ${names[k]} | ${f(a[k] as number, fmt)} | ${f(b[k] as number, fmt)} |`);
    }
    const cls: Record<string, number> = {};
    for (const r of rs) cls[r.classification] = (cls[r.classification] ?? 0) + 1;
    console.log(`  classification: ${JSON.stringify(cls)}`);
    console.log(`  route changed: ${rs.filter((r) => r.routeChanged).length}; changed WITHOUT final-letter completion gain: ${rs.filter((r) => r.routeChanged && !(r.r230.finalLetterPhysical && !r.r170.finalLetterPhysical) && !(r.r230.finalLetterInOrder && !r.r170.finalLetterInOrder)).length}; 230m returned route uses edges absent at 170m: ${rs.filter((r) => r.r230.usesEdgesAbsentAt170 > 0).length}; corridor components reduced: ${rs.filter((r) => r.r230.components < r.r170.components).length}`);
  };
  console.log('');
  console.log('=== PLACEMENT-MATCHED COMPARISON ===');
  table('Z (ROBZ)', z);
  table('O (CAIRO)', o);

  console.log('');
  console.log('=== CASES THAT CHANGED CLASS (non-unchanged) ===');
  for (const r of rows.filter((x) => !['unchanged', 'unchanged_quality'].includes(x.classification))) {
    console.log(`  ${r.word} ${r.caseLabel} ${r.placementId}: ${r.classification} | feasible ${r.r170.feasible}→${r.r230.feasible} (${r.r230.failure ?? 'ok'}, heading ${f(r.r170.headingAgreement)}→${f(r.r230.headingAgreement)}) | final phys ${r.r170.finalLetterPhysical}→${r.r230.finalLetterPhysical} inOrder ${r.r170.finalLetterInOrder}→${r.r230.finalLetterInOrder} cov ${f(r.r170.finalLetterCoverage)}→${f(r.r230.finalLetterCoverage)} | shape ${f(r.r170.shapeScore)}→${f(r.r230.shapeScore)} | len ${f(r.r170.routeLengthMeters, 0)}→${f(r.r230.routeLengthMeters, 0)}m | comps ${r.r170.components}→${r.r230.components} | new edges used ${r.r230.usesEdgesAbsentAt170} | in-order state exists ${r.r170.inOrderCompleteInAnyBeamState}→${r.r230.inOrderCompleteInAnyBeamState}`);
  }

  writeFileSync(
    resolve(DIAGNOSTIC_DIR, 'collection-radius-corpus-results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), radii: RADII, maxBeamEvaluations: MAX_BEAM_EVALUATIONS, cases: caseStats, rows: rows.map((r) => ({ ...r, r170: { ...r.r170, path: undefined }, r230: { ...r.r230, path: undefined } })) }, null, 2),
    'utf8',
  );
  console.log('');
  console.log(`[collection-radius-corpus] done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
