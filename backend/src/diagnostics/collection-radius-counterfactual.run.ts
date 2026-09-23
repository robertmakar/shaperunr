/**
 * DEVELOPMENT ONLY. Counterfactual for the graph-collection gap found in
 * ROBZ #1 (graph-fragment-audit.run.ts): the neighborhood /locate radius
 * changes 170m → 230m and NOTHING else (same grid spacing, same placement /
 * target, same corridor filter, same buildShapeGraph, same search, scoring,
 * beam, cap and goal). Uses only existing production entry points with
 * their existing options (collectNeighborhoodShapeGraph's locateRadiusMeters,
 * the pipeline's `collection` / `searchOriginSnap` injection). No production
 * file is modified; graph-shape.ts is untouched.
 *
 * Run with: npx tsx src/diagnostics/collection-radius-counterfactual.run.ts
 */
import { distanceToPolyline, polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE } from '../generation/graph-shape';
import { collectNeighborhoodShapeGraph, NEIGHBORHOOD_COLLECT, shapeKindFromWord, type ShapeGraphCollection } from '../generation/graph-shape-router';
import { snapSearchOrigin, searchOriginFromSnap } from '../generation/snap-search-origin';
import { getSearchRadiusForTargetDistance } from '../generation/search-radius';
import { filterCorridorSegments } from '../generation/shape-discovery';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { coverageThresholdMeters } from '../generation/target-identity';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, mirrorResultForState } from './graph-shape-goal-mirror';
import { routeQuality, finalLetterOf } from './goal-threshold-diagnostic';
import { zStrokeRanges } from './z-checkpoint-repair-experiment';
import { analyzeStrokeTraversal, buildRoutePieces, pointAtProgress } from './z-diagonal-direction-diagnostic';
import { connectedComponents, shortestPathBetween } from './graph-fragment-audit';
import { createBeamTracer, createMetricCache, type StateRecord } from './beam-survival-diagnostic';

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const PLACEMENT = 'sf-r315-s0.6-e-905.1-n905.1';
const RETURNED_NODE = '-496,536';
const FRAGMENT_EDGE = '3512545072640'; // the C3 bottom-fragment edge (way 1311765103) from graph-fragment-audit
const COUNTERFACTUAL_RADIUS = 230;
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));

async function main() {
  const started = Date.now();
  const distance = 4000;
  const originSnap = await snapSearchOrigin(ZAMALEK);
  const searchOrigin = searchOriginFromSnap(originSnap);
  const radius = getSearchRadiusForTargetDistance(distance);

  // Production (170m) and counterfactual (230m) collections — the ONLY difference.
  const prodCollection = await collectNeighborhoodShapeGraph(searchOrigin, { radiusMeters: radius });
  const cfCollection = await collectNeighborhoodShapeGraph(searchOrigin, { radiusMeters: radius, locateRadiusMeters: COUNTERFACTUAL_RADIUS });
  console.log(`=== COLLECTIONS === grid step ${NEIGHBORHOOD_COLLECT.stepMeters}m (unchanged), neighborhood radius ${radius}m`);
  console.log(`  production locate radius ${NEIGHBORHOOD_COLLECT.locateRadiusMeters}m: ${prodCollection.segments.length} raw edges, ${prodCollection.valhallaCalls} locate calls`);
  console.log(`  counterfactual locate radius ${COUNTERFACTUAL_RADIUS}m: ${cfCollection.segments.length} raw edges, ${cfCollection.valhallaCalls} locate calls`);

  // Full pipeline, production default (no injection) vs injected production collection (injection parity) vs injected 230m collection.
  const input = { word: 'ROBZ', start: ZAMALEK, targetDistanceMeters: distance };
  const prodReport = await runExperimentalPipelineMultiVariant(input, ['smooth']);
  const injProdReport = await runExperimentalPipelineMultiVariant(input, ['smooth'], { collection: prodCollection, searchOriginSnap: originSnap });
  const cfReport = await runExperimentalPipelineMultiVariant(input, ['smooth'], { collection: cfCollection, searchOriginSnap: originSnap });
  const find = (r: typeof prodReport) => (r.diagnostics.feasibility ?? []).find((x) => x.placementId === PLACEMENT) ?? null;
  const prodRec = find(prodReport);
  const injRec = find(injProdReport);
  const cfRec = find(cfReport);
  if (!prodRec) throw new Error('ROBZ #1 not found in production run');
  console.log('');
  console.log('=== PIPELINE ===');
  console.log(`  injection parity (170m collection injected == default pipeline): ROBZ #1 target=${JSON.stringify(injRec?.target) === JSON.stringify(prodRec.target)} graphLines=${JSON.stringify(injRec?.graphLines) === JSON.stringify(prodRec.graphLines)} path=${JSON.stringify(injRec?.pathPoints) === JSON.stringify(prodRec.pathPoints)}; routes ${prodReport.routes.map((r) => r.id).join(',')} vs ${injProdReport.routes.map((r) => r.id).join(',')}`);
  console.log(`  230m pipeline: feasibility pool ${cfReport.diagnostics.feasibility?.length ?? 0} (feasible ${(cfReport.diagnostics.feasibility ?? []).filter((x) => x.feasible).length}); ROBZ #1 in pool: ${Boolean(cfRec)}${cfRec ? ` feasible=${cfRec.feasible} same target=${JSON.stringify(cfRec.target) === JSON.stringify(prodRec.target)}` : ''}; routed candidates: ${cfReport.routes.map((r) => `${r.id}(${r.shapeScore.toFixed(3)})`).join(', ') || 'none'}`);

  // Same placement → same target. Route it on the 230m collection exactly as the pipeline does.
  const target = prodRec.target;
  const kind = shapeKindFromWord('ROBZ');
  const prodCorridor = filterCorridorSegments(prodCollection.segments, target);
  const cfCorridor = filterCorridorSegments(cfCollection.segments, target);
  const prodGraph = buildShapeGraph(prodCorridor);
  const cfGraph = buildShapeGraph(cfCorridor);
  console.log(`  corridor edges: production ${prodCorridor.length} (matches record: ${JSON.stringify(prodCorridor.map((s) => s.points)) === JSON.stringify(prodRec.graphLines)}), counterfactual ${cfCorridor.length}${cfRec ? ` (matches 230m pipeline record: ${JSON.stringify(cfCorridor.map((s) => s.points)) === JSON.stringify(cfRec.graphLines)})` : ''}`);

  // Components + former C0/C3 gap.
  const pc = connectedComponents(prodGraph);
  const cc = connectedComponents(cfGraph);
  const sizes = (c: ReturnType<typeof connectedComponents>) => [...c.sizes.values()].sort((a, b) => b.nodes - a.nodes).map((s) => `${s.nodes}n/${s.segments}e`).join(' ');
  console.log('');
  console.log('=== CONNECTIVITY ===');
  console.log(`  production corridor: ${pc.sizes.size} components [${sizes(pc)}]`);
  console.log(`  230m corridor:       ${cc.sizes.size} components [${sizes(cc)}]`);
  const fragSeg = cfGraph.segments.find((s) => s.id === FRAGMENT_EDGE);
  const joined = fragSeg ? cc.nodeComponent.get(RETURNED_NODE) === cc.segmentComponent.get(FRAGMENT_EDGE) : false;
  console.log(`  former C0/C3 gap (returned node ${RETURNED_NODE} ↔ bottom fragment edge ${FRAGMENT_EDGE}): present=${Boolean(fragSeg)} CONNECTED=${joined}`);
  if (joined && fragSeg) {
    const link = shortestPathBetween(cfGraph, new Set([RETURNED_NODE]), new Set([fragSeg.from, fragSeg.to]));
    console.log(`    shortest link: ${f(link?.lengthMeters, 0)}m via ${link?.segments.map((s) => `${s.id}(way ${s.wayId})`).join(', ')}`);
  }

  // Bottom-stroke coverage by the MAIN component (the one the search starts in).
  const zb = letterBoundariesFromWordShape(buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' })).boundaries[3]!;
  const ranges = zStrokeRanges(zb);
  const bottom = ranges[2]!;
  const ink = coverageThresholdMeters(target);
  const mainComp = cc.nodeComponent.get(RETURNED_NODE)!;
  const prodMain = pc.nodeComponent.get(RETURNED_NODE)!;
  let covered = 0;
  let prodCovered = 0;
  const rows: string[] = [];
  for (let i = 0; i <= 20; i += 1) {
    const t = i / 20;
    const p = pointAtProgress(target, bottom.start + t * (bottom.end - bottom.start));
    const dMain = Math.min(...cfGraph.segments.filter((s) => cc.segmentComponent.get(s.id) === mainComp).map((s) => distanceToPolyline(p, s.points)));
    const dProd = Math.min(...prodGraph.segments.filter((s) => pc.segmentComponent.get(s.id) === prodMain).map((s) => distanceToPolyline(p, s.points)));
    if (dMain <= ink) covered += 1;
    if (dProd <= ink) prodCovered += 1;
    if (i % 4 === 0) rows.push(`t=${t.toFixed(2)}: ${f(dProd, 1)}m→${f(dMain, 1)}m`);
  }
  console.log(`  bottom stroke served by the search's (main) component within ink radius ${f(ink, 0)}m: production ${prodCovered}/21 samples, 230m ${covered}/21 samples; nearest main-component edge (production→230m): ${rows.join(' | ')}`);

  // Search: production routeGraphConstrainedShape + traced mirror (parity-checked) on BOTH graphs.
  const loop = isClosedTarget(target);
  const runSearch = (graph: ReturnType<typeof buildShapeGraph>, label: string) => {
    const real = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
    const { observer, trace } = createBeamTracer();
    const mirror = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
    const parity = JSON.stringify(real.pathPoints) === JSON.stringify(mirror.pathPoints) && real.search.statesExplored === mirror.search.statesExplored && real.failure === mirror.failure;
    const metrics = createMetricCache(trace, target, ranges);
    const evaluate = (r: StateRecord) => {
      const res = mirrorResultForState(r.state, trace.directed, target, kind, loop, mirror.regions, mirror.search);
      const q = routeQuality('ROBZ', target, res.pathPoints, res.failure)!;
      q.targetCoverage = res.metrics.targetCoverage;
      return { res, q, fl: finalLetterOf('ROBZ', target, res.pathPoints, zb, q) };
    };
    const anatomy = (path: Vec2[]) => {
      const pieces = buildRoutePieces(path, target);
      const firstAt = (w: { start: number; end: number }) => pieces.find((p) => p.perpendicularDistance <= ink && p.progress >= w.start && p.progress <= w.end)?.routeMeters ?? Infinity;
      const order = [...ranges].sort((a, b) => firstAt(a) - firstAt(b)).filter((w) => firstAt(w) < Infinity).map((w) => w.label[0]).join('');
      const strokes = ranges.map((w) => analyzeStrokeTraversal(pieces, target, { label: w.label, start: w.start, end: w.end }));
      return { order, strokes };
    };
    const returned = trace.byState.get(trace.finish!.best!)!;
    const retEval = evaluate(returned);
    const retAn = anatomy(retEval.res.pathPoints);
    // Candidates: every beam state with Z ink on all three strokes (cheap pre-filter), then physical + order check.
    const beam = trace.records.filter((r) => r.fate === 'survived' || r.fate === 'start');
    const pre = beam.filter((r) => metrics(r).all3);
    const evaluated = pre.map((r) => ({ r, e: evaluate(r), an: anatomy(metrics(r).path) }));
    const zPhys = evaluated.filter((x) => x.e.fl?.physicallyCovered);
    // In order: strokes first entered top → diagonal → bottom, and no stroke predominantly reversed.
    const inOrder = zPhys.filter((x) => x.an.order === 'tdb' && x.an.strokes.every((s) => s.category !== 'B_reverse'));
    const goalOk = (r: StateRecord) => r.isGoal;
    const best = [...inOrder].sort((a, b) => Number(b.e.res.failure === null) - Number(a.e.res.failure === null) || Number(goalOk(b.r)) - Number(goalOk(a.r)) || b.e.q.shapeScore - a.e.q.shapeScore)[0];
    const orders: Record<string, number> = {};
    for (const x of zPhys) orders[x.an.order] = (orders[x.an.order] ?? 0) + 1;
    console.log('');
    console.log(`=== SEARCH: ${label} ===`);
    console.log(`  mirror parity with production routeGraphConstrainedShape: ${parity}; states=${real.search.statesExplored} finish=${trace.finish!.reason} layers=${trace.finish!.layers} goals=${trace.records.filter((r) => r.isGoal).length}`);
    console.log(`  returned: prog=${f(returned.state.progress)} cost=${f(returned.state.cost, 1)} shape=${f(retEval.q.shapeScore)} tgtCov=${f(retEval.q.targetCoverage)} route/tgt=${f(retEval.q.routeTarget)} feasible=${retEval.res.failure === null} Z ink(t/d/b)=${f(retEval.fl?.zStrokeInk?.top, 2)}/${f(retEval.fl?.zStrokeInk?.diagonal, 2)}/${f(retEval.fl?.zStrokeInk?.bottom, 2)} Zphys=${retEval.fl?.physicallyCovered} Zcov=${f(retEval.fl?.coverage)} order=${retAn.order} bottom=${retAn.strokes[2]!.category}(cov ${f(retAn.strokes[2]!.coverage, 2)})`);
    console.log(`  beam states with all-3 ink=${pre.length}; physically complete Z=${zPhys.length} (stroke orders ${JSON.stringify(orders)}); IN-ORDER physically complete Z=${inOrder.length} (goals ${inOrder.filter((x) => x.r.isGoal).length}, feasible ${inOrder.filter((x) => x.e.res.failure === null).length})`);
    if (best) {
      console.log(`  best in-order Z: state #${best.r.id} beam L${best.r.createdInLayer + 1} goal=${best.r.isGoal} prog=${f(best.r.state.progress)} shape=${f(best.e.q.shapeScore)} tgtCov=${f(best.e.q.targetCoverage)} route/tgt=${f(best.e.q.routeTarget)} cost=${f(best.r.state.cost, 1)} feasible=${best.e.res.failure === null}${best.e.res.failure ? ` (${best.e.res.failure})` : ''} Z ink=${f(best.e.fl?.zStrokeInk?.top, 2)}/${f(best.e.fl?.zStrokeInk?.diagonal, 2)}/${f(best.e.fl?.zStrokeInk?.bottom, 2)} Zcov=${f(best.e.fl?.coverage)} strokes=${best.an.strokes.map((s) => `${s.label}:${s.category}`).join(',')} letters=${best.e.q.letters.map((l) => `${l.letter}${l.physicallyCovered ? '✓' : '·'}`).join('')}`);
      console.log(`    vs returned: Δcost=${f(best.r.state.cost - returned.state.cost, 1)} Δshape=${f(best.e.q.shapeScore - retEval.q.shapeScore)}; why not returned: ${best.r.isGoal ? (best.r.state.cost > returned.state.cost ? 'it is a goal but costs more than the cheapest goal (BASELINE_COST selection)' : 'returned (same cost)') : `not a goal state (progress ${f(best.r.state.progress)} vs goal ${GRAPH_SHAPE.goalProgress}, coverage ${f(metrics(best.r).searchCoverage, 2)} vs ${GRAPH_SHAPE.goalCoverage})`}`);
    }
    return { real, returned, retEval, inOrder, zPhys, best, trace, metrics };
  };
  const prodSearch = runSearch(prodGraph, 'PRODUCTION collection (170m)');
  const cfSearch = runSearch(cfGraph, `COUNTERFACTUAL collection (${COUNTERFACTUAL_RADIUS}m)`);
  const changed = JSON.stringify(prodSearch.real.pathPoints) !== JSON.stringify(cfSearch.real.pathPoints);
  console.log('');
  console.log(`=== RETURNED ROUTE === changed vs production: ${changed}; production path ${f(polylineLength(prodSearch.real.pathPoints), 0)}m → counterfactual ${f(polylineLength(cfSearch.real.pathPoints), 0)}m; production record path identical to the 170m direct route: ${JSON.stringify(prodRec.pathPoints) === JSON.stringify(prodSearch.real.pathPoints)}`);
  if (cfRec) console.log(`  230m pipeline record path identical to the 230m direct route: ${JSON.stringify(cfRec.pathPoints) === JSON.stringify(cfSearch.real.pathPoints)}`);

  // If no in-order complete Z: where does it fail? Does ANY state enter the bottom stroke in order?
  if (cfSearch.inOrder.length === 0 || !cfSearch.best?.r.isGoal) {
    const { trace, metrics } = cfSearch;
    const beam = trace.records.filter((r) => r.fate === 'survived' || r.fate === 'start');
    const tdb = beam.filter((r) => metrics(r).topDiag && metrics(r).ink.bottom > 0);
    const created = trace.records.filter((r) => metrics(r).topDiag && metrics(r).ink.bottom > 0);
    console.log('');
    console.log('=== WHERE IT FAILS (230m) ===');
    console.log(`  states holding top+diagonal AND touching bottom: created=${created.length} (in beam ${tdb.length}, dedupe ${created.filter((r) => r.fate === 'dedupe_rejected').length}, truncated ${created.filter((r) => r.fate === 'truncated').length}); max bottom ink among them ${f(Math.max(0, ...created.map((r) => metrics(r).ink.bottom)), 2)}`);
    const bestTDB = [...tdb].sort((a, b) => metrics(b).ink.bottom - metrics(a).ink.bottom || a.state.cost - b.state.cost)[0];
    if (bestTDB) {
      const pieces = buildRoutePieces(metrics(bestTDB).path, target);
      const bt = analyzeStrokeTraversal(pieces, target, { label: 'bottom', start: bottom.start, end: bottom.end });
      console.log(`  best top+diag→bottom beam state #${bestTDB.id} L${bestTDB.createdInLayer + 1} goal=${bestTDB.isGoal} prog=${f(bestTDB.state.progress)} cost=${f(bestTDB.state.cost, 1)} bottom traversal ${bt.category} cov=${f(bt.coverage, 2)} tRange=[${f(bt.minTReached, 2)},${f(bt.maxTReached, 2)}] fate=${bestTDB.fate} expanded=${bestTDB.expanded}`);
    }
    console.log(`  search finish=${trace.finish!.reason}; unexpanded states at cap=${trace.unexpandedAtCap.length}`);
    // Edge granularity: the fragment edge the bottom stroke depends on.
    const frag = cfGraph.segments.find((s) => s.id === FRAGMENT_EDGE)!;
    const fragLen = polylineLength(frag.points);
    const bottomEnd = pointAtProgress(target, bottom.end);
    const bottomStart = pointAtProgress(target, bottom.start);
    const along = (p: Vec2) => {
      let acc = 0;
      let best = { d: Infinity, at: 0 };
      for (let i = 1; i < frag.points.length; i += 1) {
        const a = frag.points[i - 1]!;
        const b = frag.points[i]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const tt = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len || 1)));
        const q = { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt };
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < best.d) best = { d, at: acc + tt * len };
        acc += len;
      }
      return best;
    };
    const eStart = along(bottomStart);
    const eEnd = along(bottomEnd);
    const farEnd = frag.points[frag.points.length - 1]!;
    const withinInk = (() => {
      let m = 0;
      for (let i = 1; i < frag.points.length; i += 1) {
        const a = frag.points[i - 1]!;
        const b = frag.points[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
        for (let k = 0; k < n; k += 1) {
          const p = { x: a.x + ((b.x - a.x) * (k + 0.5)) / n, y: a.y + ((b.y - a.y) * (k + 0.5)) / n };
          if (distanceToPolyline(p, target) <= ink) m += Math.hypot(b.x - a.x, b.y - a.y) / n;
        }
      }
      return m;
    })();
    console.log(`  bottom-fragment edge ${FRAGMENT_EDGE} (way ${frag.wayId}): length ${f(fragLen, 0)}m, ONE atomic search edge (no intermediate node); bottom stroke start projects at ${f(eStart.at, 0)}m along it (${f(eStart.d, 1)}m off), bottom stroke END projects at ${f(eEnd.at, 0)}m (${f(eEnd.d, 1)}m off); far endpoint (${f(farEnd.x, 0)},${f(farEnd.y, 0)}) is ${f(distanceToPolyline(farEnd, target), 0)}m from the target; edge length within the ink radius of the target: ${f(withinInk, 0)}m`);
    const dirs = [...cfGraph.segments.filter((s) => s.id === FRAGMENT_EDGE)].length;
    void dirs;
    const users = trace.records.filter((r) => r.state.edgeIds.some((id) => id.startsWith(FRAGMENT_EDGE)));
    const usersBeam = users.filter((r) => r.fate === 'survived' || r.fate === 'start');
    const edgeIn = trace.directed.get(`${FRAGMENT_EDGE}>`) ?? trace.directed.get(`${FRAGMENT_EDGE}<`);
    const e1 = trace.directed.get(`${FRAGMENT_EDGE}>`);
    const e2 = trace.directed.get(`${FRAGMENT_EDGE}<`);
    console.log(`  search's view of that edge: '>' startProg ${f(e1?.startProgress)} endProg ${f(e1?.endProgress)} forwardness ${f(e1?.forwardness)} crossing=${e1?.crossing} meanPerp ${f(e1?.meanPerp, 0)}m headingFit ${f(e1?.headingFit, 2)} | '<' startProg ${f(e2?.startProgress)} endProg ${f(e2?.endProgress)} forwardness ${f(e2?.forwardness)} crossing=${e2?.crossing} meanPerp ${f(e2?.meanPerp, 0)}m`);
    void edgeIn;
    console.log(`  states whose path uses the fragment edge: created=${users.length} in beam=${usersBeam.length} goals=${users.filter((r) => r.isGoal).length}; of those holding top+diagonal before it: ${users.filter((r) => metrics(r).topDiag).length}`);
    const cfPipe = cfRec;
    if (cfPipe) console.log(`  230m pipeline record for ROBZ #1: feasible=${cfPipe.feasible} failureReason=${cfPipe.failureReason} coverage=${f(cfPipe.coverage)} largestGap=${f(cfPipe.largestGap)} connected=${cfPipe.connected} backtracking=${f(cfPipe.backtracking)} headingAgreement=${f(1 - cfPipe.headingAgreementDegrees / 90)} (isFeasible needs ≥0.45) forwardProgress=${f(cfPipe.forwardProgress)} (needs ≥0.55)`); console.log(`  production pipeline record: feasible=${prodRec.feasible} headingAgreement=${f(1 - prodRec.headingAgreementDegrees / 90)} forwardProgress=${f(prodRec.forwardProgress)} coverage=${f(prodRec.coverage)}`);
  }
  console.log('');
  console.log(`[collection-radius-counterfactual] done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
