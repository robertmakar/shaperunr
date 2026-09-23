/**
 * DEVELOPMENT ONLY. Traces exactly where per-letter coverage is lost in
 * the native `graph_constrained` pipeline, for representative candidates
 * identified by the native-candidate-corpus-audit task.
 *
 * Pipeline call graph (traced by reading graph-constrained-pipeline.ts and
 * graph-shape.ts directly, not assumed from prior diagnostic work):
 *
 *   buildWalkableWordShape(word)                    -- word geometry (abstract units)
 *   -> buildStreetFitPlacements / rankStreetFitPlacements -- placement grid, ranked by a cheap street-fit heuristic against the raw street graph
 *   -> projectWordPlacement(wordShape, targetDistanceMeters, placement) -- GEOGRAPHIC PROJECTION: places the word at real scale/rotation/offset -> `projected.target` (local meters)
 *   -> filterCorridorSegments(collection.segments, projected.target)   -- STREET-NETWORK FEASIBILITY: restricts the raw street graph to a corridor around the projected target
 *   -> routeGraphConstrainedShape({ target: projected.target, graph: buildShapeGraph(corridor), ... }) -- ROUTE CONSTRUCTION: a beam search over corridor street edges (graph-shape.ts). Produces `result.pathPoints`.
 *   -> (no resampling/simplification of pathPoints between here and scoring/completeness)
 *   -> scorePolylines(pathPoints, target)            -- shape metrics, computed directly on the SAME pathPoints
 *   -> experimentalProductRejectionReasons            -- completeness/sequence/continuity, computed directly on the SAME pathPoints/target (converted to local meters via the same coordinatesToLocalMeters call)
 *
 * KEY FINDING from reading graph-shape.ts's beamSearch/isGoal/GRAPH_SHAPE
 * directly: for non-loop shapes (all multi-letter words), the search's own
 * goal condition is `coverage >= GRAPH_SHAPE.goalCoverage (0.62)` AND
 * `progress >= GRAPH_SHAPE.goalProgress (0.88)`, where `coverage` is the
 * FRACTION of GRAPH_SHAPE.progressBins (28) bins visited anywhere along
 * the route — NOT full coverage, and NOT per-letter. A route that covers
 * ~62% of progress bins while reaching ~88% overall progress is a
 * satisfied GOAL, even if entire letters' bins were never visited. This
 * file does not modify graph-shape.ts; it only reads GRAPH_SHAPE's
 * exported constants and independently re-measures per-letter coverage on
 * the real output.
 *
 * Nothing here modifies production. Read-only trace + independent
 * measurement using already-validated diagnostic functions.
 *
 * Run with: npx tsx src/diagnostics/native-letter-coverage-trace.run.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Vec2 } from '@/lib/geometry';
import { distanceToPolyline, projectPointOnPolyline, polylineLength } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type ExperimentalPipelineReport, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { experimentalProductRejectionReasons, meetsExperimentalProductThreshold } from '../generation/experimental-product';
import { GRAPH_SHAPE, buildShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import { generateCheckpointRoutes } from '../generation/checkpoint-route-generator';
import { buildTargetCheckpoints } from './checkpoint-route-experiment';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

type Target = { word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number; preferId?: string };

const TARGETS: Target[] = [
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000, preferId: 'sf-r22.5-s1.0-e282.8-n-282.8' },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 }, // will pick highest-shapeScore ROBZ candidate found across the ROBZ requests below
  { word: 'Z', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 }, // accepted single-letter control
];
const ROBZ_SWEEP: Target[] = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];

function isMultiLetter(word: string): boolean {
  return word.replace(/[^A-Za-z]/g, '').length > 1;
}

type PerLetterRow = {
  letter: string;
  targetLengthMeters: number;
  routeCoverageMeters: number;
  coverageFraction: number;
  routePointsNear: number;
  corridorSegmentPointsNear: number;
  corridorAvailable: boolean;
};

/** Independent per-letter measurement — mirrors the SAME distance/progress-window logic already validated in letter-sequence-integrity-diagnostic.ts's extractLetterRouteSpans, but also reports raw corridor (pre-search) segment availability, which no prior diagnostic needed. */
function measurePerLetter(word: string, geometryVariant: 'smooth', target: Vec2[], pathPoints: Vec2[], corridorLines: Vec2[][]): { rows: PerLetterRow[]; boundaries: LetterBoundary[] } {
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  const boundarySet = letterBoundariesFromWordShape(shape);
  const boundaries = boundarySet.boundaries;
  const followRadius = GRAPH_SHAPE.followRadiusMeters;

  const rows: PerLetterRow[] = boundaries.map((boundary) => {
    const targetLengthMeters = boundary.letterLength;
    // Route points whose projection onto the FULL target falls within this letter's progress window AND close enough to be "near" it.
    const near = pathPoints.filter((p) => {
      const hit = projectPointOnPolyline(p, target);
      return hit.progress >= boundary.projectedStartProgress - 0.02 && hit.progress <= boundary.projectedEndProgress + 0.02 && hit.distance <= followRadius;
    });
    // Route coverage: how much of the route's own path length falls within this letter's window (consecutive-point distance sum, only counting points identified as "near").
    let routeCoverageMeters = 0;
    for (let i = 0; i + 1 < pathPoints.length; i += 1) {
      const a = pathPoints[i]!;
      const b = pathPoints[i + 1]!;
      const hitA = projectPointOnPolyline(a, target);
      const hitB = projectPointOnPolyline(b, target);
      const aIn = hitA.progress >= boundary.projectedStartProgress - 0.02 && hitA.progress <= boundary.projectedEndProgress + 0.02 && hitA.distance <= followRadius;
      const bIn = hitB.progress >= boundary.projectedStartProgress - 0.02 && hitB.progress <= boundary.projectedEndProgress + 0.02 && hitB.distance <= followRadius;
      if (aIn && bIn) routeCoverageMeters += Math.hypot(b.x - a.x, b.y - a.y);
    }
    // Corridor (pre-search) segment points near this letter's own target sub-polyline, testing whether ANY street geometry existed here at all, independent of whether the search used it.
    const letterTargetPoints = target.filter((_, i) => {
      const progress = target.length <= 1 ? 0 : i / (target.length - 1);
      return progress >= boundary.projectedStartProgress - 0.02 && progress <= boundary.projectedEndProgress + 0.02;
    });
    let corridorSegmentPointsNear = 0;
    for (const line of corridorLines) {
      for (const p of line) {
        const distToLetter = letterTargetPoints.length ? Math.min(...letterTargetPoints.map((tp) => Math.hypot(tp.x - p.x, tp.y - p.y))) : Number.POSITIVE_INFINITY;
        if (distToLetter <= GRAPH_SHAPE.corridorMeters) corridorSegmentPointsNear += 1;
      }
    }

    return {
      letter: boundary.letter,
      targetLengthMeters,
      routeCoverageMeters,
      coverageFraction: targetLengthMeters > 0 ? Math.min(1, routeCoverageMeters / targetLengthMeters) : 0,
      routePointsNear: near.length,
      corridorSegmentPointsNear,
      corridorAvailable: corridorSegmentPointsNear > 0,
    };
  });

  return { rows, boundaries };
}

function printPerLetterTable(label: string, rows: PerLetterRow[]) {
  console.log(`--- Per-letter table: ${label} ---`);
  console.log('Letter | TargetLen(m) | RouteCoverage(m) | CoverageFraction | RoutePointsNear | CorridorPointsNear | CorridorAvailable');
  for (const r of rows) {
    console.log(`${r.letter}      | ${r.targetLengthMeters.toFixed(1)} | ${r.routeCoverageMeters.toFixed(1)} | ${r.coverageFraction.toFixed(3)} | ${r.routePointsNear} | ${r.corridorSegmentPointsNear} | ${r.corridorAvailable}`);
  }
}

async function findCandidate(t: Target): Promise<{ report: ExperimentalPipelineReport; record: FeasibilityRecord | null; routeMeta: ExperimentalPipelineReport['routes'][number] | null }> {
  const report = await runExperimentalPipelineMultiVariant({ word: t.word, start: t.start, targetDistanceMeters: t.targetDistanceMeters }, ['smooth']);
  const feasibility = report.diagnostics.feasibility ?? [];
  let chosenRoute = null as ExperimentalPipelineReport['routes'][number] | null;
  if (t.preferId) {
    chosenRoute = report.routes.find((r) => r.id === t.preferId) ?? null;
  }
  if (!chosenRoute) {
    chosenRoute = [...report.routes].sort((a, b) => b.shapeScore - a.shapeScore)[0] ?? null;
  }
  const record = chosenRoute ? feasibility.find((f) => f.placementId === chosenRoute!.id) ?? null : null;
  return { report, record, routeMeta: chosenRoute };
}

async function traceCandidate(label: string, t: Target) {
  console.log('');
  console.log(`=== ${label}: ${t.word} ${t.locationName} ${t.targetDistanceMeters}m ${t.preferId ? `(preferring ${t.preferId})` : '(highest shapeScore)'} ===`);
  const { report, record, routeMeta } = await findCandidate(t);
  if (!record || !routeMeta) {
    console.log(`  No routed native candidate found for this request (native candidates: ${report.routes.length}).`);
    return null;
  }
  console.log(`  candidateId=${routeMeta.id} shapeScore=${routeMeta.shapeScore.toFixed(3)} coverage=${routeMeta.coverage.toFixed(3)} rawOrder=${routeMeta.scoreBreakdown.order.toFixed(3)}`);
  console.log(`  graph-shape result.metrics.targetCoverage=${record.result.metrics.targetCoverage.toFixed(3)} (GRAPH_SHAPE.goalCoverage=${GRAPH_SHAPE.goalCoverage}, goalProgress=${GRAPH_SHAPE.goalProgress})`);
  console.log(`  result.metrics.progressSpan=${record.result.metrics.progressSpan.toFixed(3)} largestTargetProgressGap=${record.result.metrics.largestTargetProgressGap.toFixed(3)} connected=${record.result.metrics.connected} failure=${record.result.failure ?? 'null'} failureReason=${record.result.failureReason ?? 'null'}`);
  console.log(`  target length=${polylineLength(record.target).toFixed(1)}m route length=${polylineLength(record.pathPoints).toFixed(1)}m corridor segment count=${record.graphLines.length}`);

  const context = { word: t.word, targetDistance: t.targetDistanceMeters };
  const gateReasons = experimentalProductRejectionReasons(routeMeta, context);
  const gatePasses = meetsExperimentalProductThreshold(routeMeta, context);
  console.log(`  gatePasses=${gatePasses} reasons=${JSON.stringify(gateReasons)}`);

  if (isMultiLetter(t.word)) {
    const { rows } = measurePerLetter(t.word, 'smooth', record.target, record.pathPoints, record.graphLines);
    printPerLetterTable(`${t.word} native candidate`, rows);

    const physical = evaluatePhysicalWordTraversal(t.word, record.target, record.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
    console.log(`  physical-word-traversal per-letter: ${JSON.stringify(physical.letters.map((l) => ({ letter: l.letter, rawInkCoverage: Number(l.rawInkCoverage.toFixed(3)), coverage: Number(l.coverage.toFixed(3)), physicallyCovered: l.physicallyCovered })))}`);

    // Chronological-compression check: does the route's progress-vs-distance profile show a smooth continuous advance (shortcut) through missing letters' progress range, or a genuine gap?
    const missingLetters = physical.letters.filter((l) => !l.physicallyCovered).map((l) => l.letter);
    if (missingLetters.length > 0) {
      console.log(`  missing letters (physically not covered): ${JSON.stringify(missingLetters)}`);
      for (const row of rows) {
        if (!missingLetters.includes(row.letter)) continue;
        const classification = row.routePointsNear === 0 && row.corridorSegmentPointsNear === 0
          ? 'unreachable: no corridor street geometry near this letter at all'
          : row.routePointsNear === 0 && row.corridorSegmentPointsNear > 0
            ? 'street candidates existed nearby, but the search never routed through them (shortcut/graph-search choice)'
            : row.coverageFraction < 0.3
              ? 'touched only briefly / crossed through, not traced'
              : 'partially traced but below completeness thresholds';
        console.log(`    ${row.letter}: ${classification} (corridorPointsNear=${row.corridorSegmentPointsNear}, routePointsNear=${row.routePointsNear}, coverageFraction=${row.coverageFraction.toFixed(3)})`);
      }
    }
  }

  return { report, record, routeMeta };
}

async function compareCheckpointV1(t: Target, record: FeasibilityRecord) {
  console.log('');
  console.log(`--- Checkpoint-v1 comparison for the SAME target/graph: ${t.word} ${t.locationName} ${t.targetDistanceMeters}m ---`);
  const shape = buildWalkableWordShape(t.word, { letterVariant: 'smooth' });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const checkpoints = buildTargetCheckpoints(record.target, 12, boundaries);
  console.log(`  buildTargetCheckpoints places 12 EVENLY-SPACED checkpoints across the full 0..1 target progress range (structural guarantee, independent of street availability):`);
  for (const c of checkpoints) {
    console.log(`    checkpoint ${c.index}: progress=${c.targetProgress.toFixed(3)} letter=${c.targetLetter ?? 'gap/connector'}`);
  }
  const graph = buildShapeGraph(record.graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
  const kind = shapeKindFromWord(t.word);
  const checkpointResult = generateCheckpointRoutes({
    word: t.word,
    target: record.target,
    graph,
    kind,
    geometryVariant: 'smooth',
    targetDistanceMeters: record.shapeRouteMeters > 0 ? record.shapeRouteMeters : t.targetDistanceMeters,
    searchOrigin: t.start,
    placement: { rotationDegrees: record.rotationDegrees, scale: record.scale, eastMeters: record.eastMeters, northMeters: record.northMeters, distanceFromUserMeters: 0 },
  });
  const cpBest = checkpointResult.candidates[0];
  if (!cpBest) {
    console.log('  checkpoint-v1 produced no candidate for this exact corridor/target (reported honestly, not forced).');
    return;
  }
  console.log(`  checkpoint-v1 candidate: shapeScore=${cpBest.route.shapeScore.toFixed(3)} coverage=${cpBest.route.coverage.toFixed(3)}`);
  // checkpoint-v1's route comes back as geo coordinates (GeneratedRoute) — convert to a self-consistent local-meters frame anchored at its own target's first point (the same conversion pattern used throughout this diagnostic investigation), then measure completeness independently.
  const cpShapeGeo = cpBest.route.shapeCoordinates ?? cpBest.route.coordinates;
  const cpOrigin = cpBest.route.targetCoordinates[0] ?? cpShapeGeo[0] ?? t.start;
  const cpTargetLocal = coordinatesToLocalMeters(cpOrigin, cpBest.route.targetCoordinates);
  const cpShapeLocal = coordinatesToLocalMeters(cpOrigin, cpShapeGeo);
  if (cpShapeLocal.length >= 2 && cpTargetLocal.length >= 2) {
    const cpPhysical = evaluatePhysicalWordTraversal(t.word, cpTargetLocal, cpShapeLocal, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
    console.log(`  checkpoint-v1 per-letter physicallyCovered: ${JSON.stringify(cpPhysical.letters.map((l) => ({ letter: l.letter, rawInkCoverage: Number(l.rawInkCoverage.toFixed(3)), physicallyCovered: l.physicallyCovered })))}`);
  } else {
    console.log('  (checkpoint-v1 candidate had insufficient geometry for a local-meters completeness comparison.)');
  }
  void distanceToPolyline;
}

async function main() {
  const started = Date.now();

  // Find the highest-shapeScore ROBZ candidate across all 4 ROBZ requests.
  let bestRobz: { target: Target; report: ExperimentalPipelineReport } | null = null;
  for (const t of ROBZ_SWEEP) {
    const report = await runExperimentalPipelineMultiVariant({ word: t.word, start: t.start, targetDistanceMeters: t.targetDistanceMeters }, ['smooth']);
    const top = [...report.routes].sort((a, b) => b.shapeScore - a.shapeScore)[0];
    if (top && (!bestRobz || top.shapeScore > [...bestRobz.report.routes].sort((a, b) => b.shapeScore - a.shapeScore)[0]!.shapeScore)) {
      bestRobz = { target: t, report };
    }
    console.log(`[robz-sweep] ${t.locationName} ${t.targetDistanceMeters}m: native=${report.routes.length} bestShapeScore=${top?.shapeScore.toFixed(3) ?? 'N/A'}`);
  }

  const cairoResult = await traceCandidate('TARGET A: strong-but-incomplete CAIRO', TARGETS[0]!);
  const robzTarget = bestRobz?.target ?? TARGETS[1]!;
  const robzResult = await traceCandidate('TARGET B: highest-shapeScore ROBZ', robzTarget);
  const controlResult = await traceCandidate('TARGET C: accepted single-letter control', TARGETS[2]!);

  if (cairoResult) {
    await compareCheckpointV1(TARGETS[0]!, cairoResult.record);
  }

  console.log('');
  console.log('=== LENGTHRATIO TRACE ===');
  for (const result of [cairoResult, robzResult, controlResult]) {
    if (!result) continue;
    const { routeMeta, record } = result;
    const shapeLen = polylineLength(record.pathPoints);
    const targetLen = polylineLength(record.target);
    console.log(
      `  ${routeMeta.id}: shapeRouteDistanceMeters(metadata)=${routeMeta.metadata.shapeRouteDistanceMeters?.toFixed(1)} targetLengthMeters=${targetLen.toFixed(1)} local-shape-polyline-length=${shapeLen.toFixed(1)} lengthRatioProjected-equivalent=${(shapeLen / Math.max(targetLen, 1e-6)).toFixed(3)} requestedTargetDistanceMeters=${result.report.diagnostics.placementsEvaluated ? 'see targetDistanceMeters below' : ''}`,
    );
  }

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'native-letter-coverage-trace-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'see console log for full trace; this file is a placeholder marker' }, null, 2), 'utf8');

  console.log('');
  console.log(`[native-letter-coverage-trace] done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
