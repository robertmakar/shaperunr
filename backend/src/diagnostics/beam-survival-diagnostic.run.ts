/**
 * DEVELOPMENT ONLY. Beam-survival trace for ROBZ #1 (Zamalek / 4000m /
 * sf-r315-s0.6-e-905.1-n905.1): where does the "Z top + diagonal held" branch
 * disappear, and could it have reached the bottom stroke? Diagnostic only;
 * graph-shape.ts is never touched. Counterfactuals (beam width, expansion
 * cap, coverage-reward weight) run ONLY in the mirror, after parity.
 *
 * Run with: npx tsx src/diagnostics/beam-survival-diagnostic.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant, type FeasibilityRecord } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE, type ShapeGraph, type ShapeKind } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, mirrorResultForState, type Directed, type EdgeCostAugmenterFn } from './graph-shape-goal-mirror';
import { routeQuality, finalLetterOf } from './goal-threshold-diagnostic';
import { indexOutgoing } from './beam-search-trace';
import { findShortestConnectingPath } from './letter-transition-diagnostic';
import { buildDirected, decomposeZStrokes, testConnectivity } from './letter-street-support-diagnostic';
import { zStrokeRanges } from './z-checkpoint-repair-experiment';
import { pointAtProgress, analyzeStrokeTraversal, buildRoutePieces } from './z-diagonal-direction-diagnostic';
import { coverageThresholdMeters } from '../generation/target-identity';
import {
  createBeamTracer,
  createMetricCache,
  decomposeCost,
  ancestry,
  coverageRewardDelta,
  type Trace,
  type StateRecord,
  type StateMetrics,
} from './beam-survival-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const PRODUCTION_BEAM = GRAPH_SHAPE.beamPerBin * 4;

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}
async function fetchRecord(word: string, start: typeof ZAMALEK, distance: number, placementId: string): Promise<FeasibilityRecord> {
  const report = await runExperimentalPipelineMultiVariant({ word, start, targetDistanceMeters: distance }, ['smooth']);
  const r = (report.diagnostics.feasibility ?? []).find((x) => x.feasible && x.placementId === placementId);
  if (!r) throw new Error(`candidate ${word} ${placementId} not found`);
  return r;
}

type Ctx = { word: string; record: FeasibilityRecord; target: Vec2[]; graph: ShapeGraph; kind: ShapeKind; loop: boolean; targetLength: number; ranges: Array<{ label: string; start: number; end: number }> };
function ctxOf(word: string, record: FeasibilityRecord): Ctx {
  const target = record.target;
  const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
  return { word, record, target, graph: reconstructGraph(record.graphLines), kind: shapeKindFromWord(word), loop: isClosedTarget(target), targetLength: polylineLength(target), ranges: zStrokeRanges(boundaries[boundaries.length - 1]!) };
}

function runTraced(ctx: Ctx, opts: { beamWidth?: number; maxExpansions?: number; extraCost?: EdgeCostAugmenterFn } = {}) {
  const { observer, trace } = createBeamTracer();
  const result = routeGraphConstrainedShapeMirror({ target: ctx.target, graph: ctx.graph, kind: ctx.kind, multiLetter: true, observer, beamWidth: opts.beamWidth, maxExpansions: opts.maxExpansions, extraCost: opts.extraCost });
  return { result, trace, metrics: createMetricCache(trace, ctx.target, ctx.ranges) };
}

function evaluateState(ctx: Ctx, trace: Trace, rec: StateRecord, regions: never, search: never) {
  const r = mirrorResultForState(rec.state, trace.directed, ctx.target, ctx.kind, ctx.loop, regions, search);
  const q = routeQuality(ctx.word, ctx.target, r.pathPoints, r.failure)!;
  q.targetCoverage = r.metrics.targetCoverage;
  const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(ctx.word, { letterVariant: 'smooth' })).boundaries;
  const fl = finalLetterOf(ctx.word, ctx.target, r.pathPoints, boundaries[boundaries.length - 1]!, q);
  return { q, fl, failure: r.failure };
}

const inBeam = (r: StateRecord) => r.fate === 'survived' || r.fate === 'start';
/** Beam index a record belongs to (0 for starts). */
const beamLayer = (r: StateRecord) => r.createdInLayer + 1;

function isDescendant(trace: Trace, r: StateRecord, ancestorId: number): boolean {
  let cur: StateRecord | undefined = r;
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId !== null ? trace.records[cur.parentId] : undefined;
  }
  return false;
}

function summarizeRun(label: string, ctx: Ctx, run: ReturnType<typeof runTraced>) {
  const { trace, metrics, result } = run;
  const beamStates = trace.records.filter(inBeam);
  const tdBeams = new Set(beamStates.filter((r) => metrics(r).topDiag).map(beamLayer));
  const all3Beam = beamStates.filter((r) => metrics(r).all3);
  const all3Goals = trace.records.filter((r) => r.isGoal && metrics(r).all3);
  let bestAll3: { rec: StateRecord; q: ReturnType<typeof evaluateState> } | null = null;
  let zPhysCount = 0;
  let zPhysGoals = 0;
  // Best recovered state = physically covered Z, then feasible, then goal, then shapeScore.
  const rank = (x: { rec: StateRecord; q: ReturnType<typeof evaluateState> }) => [x.q.fl?.physicallyCovered ? 1 : 0, x.q.failure === null ? 1 : 0, x.rec.isGoal ? 1 : 0, x.q.q.shapeScore];
  const better = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i]! > b[i]!; return false; };
  for (const r of all3Beam) {
    const q = evaluateState(ctx, trace, r, result.regions as never, result.search as never);
    if (q.fl?.physicallyCovered) {
      zPhysCount += 1;
      if (r.isGoal) zPhysGoals += 1;
    }
    if (!bestAll3 || better(rank({ rec: r, q }), rank(bestAll3))) bestAll3 = { rec: r, q };
  }
  const returned = trace.byState.get(trace.finish!.best!)!;
  const rq = evaluateState(ctx, trace, returned, result.regions as never, result.search as never);
  const rm = metrics(returned);
  console.log(
    `  ${label.padEnd(34)} states=${result.search.statesExplored} layers=${trace.finish!.layers} finish=${trace.finish!.reason} lastTopDiagBeam=${tdBeams.size ? Math.max(...tdBeams) : '-'} all3InkInAnyBeam=${all3Beam.length} (Z physically covered: ${zPhysCount}, of which goals: ${zPhysGoals}) all3InkGoals=${all3Goals.length} | returned prog=${f(returned.state.progress)} Z(t/d/b)=${f(rm.ink.top, 2)}/${f(rm.ink.diagonal, 2)}/${f(rm.ink.bottom, 2)} shape=${f(rq.q.shapeScore)} feasible=${rq.failure === null}`,
  );
  if (bestAll3) {
    const m = metrics(bestAll3.rec);
    console.log(`    best all-3 beam state: #${bestAll3.rec.id} beam L${beamLayer(bestAll3.rec)} goal=${bestAll3.rec.isGoal} prog=${f(bestAll3.rec.state.progress)} cost=${f(bestAll3.rec.state.cost, 1)} Z(t/d/b)=${f(m.ink.top, 2)}/${f(m.ink.diagonal, 2)}/${f(m.ink.bottom, 2)} shape=${f(bestAll3.q.q.shapeScore)} tgtCov=${f(bestAll3.q.q.targetCoverage)} route/tgt=${f(bestAll3.q.q.routeTarget)} backtr=${f(bestAll3.q.q.backtracking)} feasible=${bestAll3.q.failure === null} (${bestAll3.q.failure ?? 'ok'}) Zphys=${bestAll3.q.fl?.physicallyCovered}`);
  }
  return { tdLast: tdBeams.size ? Math.max(...tdBeams) : null, all3Beam: all3Beam.length, all3Goals: all3Goals.length, zPhysCount, zPhysGoals, bestAll3, returned, rq };
}

async function main() {
  const started = Date.now();
  const robz1 = ctxOf('ROBZ', await fetchRecord('ROBZ', ZAMALEK, 4000, 'sf-r315-s0.6-e-905.1-n905.1'));

  // ------------------------------------------------------------------ PARITY
  const production = routeGraphConstrainedShape({ target: robz1.target, graph: robz1.graph, kind: robz1.kind, multiLetter: true });
  const base = runTraced(robz1);
  const { trace, metrics, result } = base;
  const goals = trace.records.filter((r) => r.isGoal);
  const returned = trace.byState.get(trace.finish!.best!)!;
  console.log('=== PARITY (ROBZ #1, tracer attached vs production) ===');
  console.log(
    `  path=${JSON.stringify(result.pathPoints) === JSON.stringify(production.pathPoints)} statesExplored=${result.search.statesExplored}/${production.search.statesExplored} failure=${result.failure}/${production.failure} shapeScore=${f(result.metrics.shapeScore, 6)}/${f(production.metrics.shapeScore, 6)} targetCoverage=${f(result.metrics.targetCoverage, 6)}/${f(production.metrics.targetCoverage, 6)} finish=${trace.finish!.reason} goalPool=${goals.length} returnedIsGoal=${trace.finish!.best === trace.finish!.bestGoal} returnedState=#${returned.id}`,
  );
  const costMismatches = trace.records.filter(inBeam).filter((r) => !decomposeCost(trace, r, robz1.targetLength, robz1.loop, robz1.kind, result.regions).matches).length;
  console.log(`  cost replay (edgeCostBreakdown along ancestry) matches state.cost for ${trace.records.filter(inBeam).length - costMismatches}/${trace.records.filter(inBeam).length} beam states`);
  console.log(`  records: total=${trace.records.length} starts=${trace.records.filter((r) => r.fate === 'start').length} survived=${trace.records.filter((r) => r.fate === 'survived').length} truncated=${trace.records.filter((r) => r.fate === 'truncated').length} dedupe=${trace.records.filter((r) => r.fate === 'dedupe_rejected').length} unexpandedAtCap=${trace.unexpandedAtCap.length}; Z windows top=[${f(robz1.ranges[0]!.start, 4)},${f(robz1.ranges[0]!.end, 4)}] diag=[..,${f(robz1.ranges[1]!.end, 4)}] bottom=[..,${f(robz1.ranges[2]!.end, 4)}]`);

  // ------------------------------------------------------------- LAYER TABLE
  console.log('');
  console.log('=== LAYER TABLE (beam L+1 = survivors of expanding beam L) ===');
  console.log('| Layer | Beam in | Created | After dedupe | Beam survivors | Top | Top+Diag | Bottom | All 3 | created Top+Diag / All3 / Bottom | Best Top+Diag cost | Best Bottom cost | cutoff cost | progress min/max |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of trace.layers) {
    const created = trace.records.filter((r) => r.createdInLayer === l.layer);
    const surv = created.filter((r) => r.fate === 'survived');
    const m = (rs: StateRecord[], pred: (x: StateMetrics) => boolean) => rs.filter((r) => pred(metrics(r)));
    const bestCost = (rs: StateRecord[]) => (rs.length ? Math.min(...rs.map((r) => r.state.cost)) : null);
    const cutoff = surv.length ? Math.max(...surv.map((r) => r.state.cost)) : null;
    const progs = surv.map((r) => r.state.progress);
    console.log(
      `| ${l.layer}→${l.layer + 1} | ${l.beamSize} | ${l.created} | ${l.pushed} | ${l.kept} | ${m(surv, (x) => x.top).length} | ${m(surv, (x) => x.topDiag).length} | ${m(surv, (x) => x.bottom).length} | ${m(surv, (x) => x.all3).length} | ${m(created, (x) => x.topDiag).length} / ${m(created, (x) => x.all3).length} / ${m(created, (x) => x.bottom).length} | ${f(bestCost(m(surv, (x) => x.topDiag)), 1)} | ${f(bestCost(m(surv, (x) => x.bottom)), 1)} | ${f(cutoff, 1)} | ${f(progs.length ? Math.min(...progs) : null)}/${f(progs.length ? Math.max(...progs) : null)} |`,
    );
  }
  const layerCount = trace.layers.length;
  const capNote = trace.finish!.reason === 'max_expansions' ? `search stopped by the expansion cap after expanding beam ${layerCount - 1}; the ${trace.unexpandedAtCap.length} states of beam ${layerCount} were never expanded` : 'beam exhausted';
  console.log(`  ${capNote}`);

  // ------------------------------------------------------- SURVIVAL QUESTION
  console.log('');
  console.log('=== TOP+DIAGONAL SURVIVAL ===');
  const beamRecs = trace.records.filter(inBeam);
  const tdByBeam = new Map<number, StateRecord[]>();
  for (const r of beamRecs) if (metrics(r).topDiag) (tdByBeam.get(beamLayer(r)) ?? tdByBeam.set(beamLayer(r), []).get(beamLayer(r))!).push(r);
  const tdLayers = [...tdByBeam.keys()].sort((a, b) => a - b);
  console.log(`  beams containing a Top+Diag state: ${tdLayers.join(',') || 'none'}`);
  const lastTD = tdLayers.length ? Math.max(...tdLayers) : null;
  console.log(`  LAST_LAYER_WHERE_TOP_AND_DIAGONAL_SURVIVE = beam ${lastTD}; FIRST_LAYER_WHERE_TOP_AND_DIAGONAL_DISAPPEAR = ${lastTD === null ? '-' : lastTD + 1 > layerCount ? `none (beam ${lastTD} is the final beam; search ended: ${trace.finish!.reason})` : `beam ${lastTD + 1}`}`);
  // Fate of every Top+Diag beam state's children, per beam.
  for (const L of tdLayers) {
    const tds = tdByBeam.get(L)!;
    const kids = trace.records.filter((r) => r.parentId !== null && tds.some((t) => t.id === r.parentId));
    const kidTD = kids.filter((k) => metrics(k).topDiag);
    const fates = (rs: StateRecord[]) => ({ survived: rs.filter((r) => r.fate === 'survived').length, truncated: rs.filter((r) => r.fate === 'truncated').length, dedupe: rs.filter((r) => r.fate === 'dedupe_rejected').length });
    const filtered = tds.reduce((a, t) => ({ edge_reuse: a.edge_reuse + t.edgesFiltered.edge_reuse, undirected_reuse: a.undirected_reuse + t.edgesFiltered.undirected_reuse, length_cap: a.length_cap + t.edgesFiltered.length_cap }), { edge_reuse: 0, undirected_reuse: 0, length_cap: 0 });
    const expanded = tds.filter((t) => t.expanded).length;
    const bottomKids = kids.filter((k) => metrics(k).ink.bottom > 0);
    console.log(`  beam ${L}: TD states=${tds.length} expanded=${expanded} unexpandedAtCap=${tds.filter((t) => trace.unexpandedAtCap.includes(t.id)).length} goal=${tds.filter((t) => t.isGoal).length} maxProg=${f(Math.max(...tds.map((t) => t.state.progress)))} maxBottomInk=${f(Math.max(...tds.map((t) => metrics(t).ink.bottom)), 2)} | children=${kids.length} ${JSON.stringify(fates(kids))} TD-children=${kidTD.length} ${JSON.stringify(fates(kidTD))} children touching bottom=${bottomKids.length} ${JSON.stringify(fates(bottomKids))} | filtered edges ${JSON.stringify(filtered)}`);
  }

  // ------------------------------------------- BEST TOP+DIAG STATE (Part 5)
  console.log('');
  console.log('=== FOLLOW THE BEST TOP+DIAGONAL STATE ===');
  const tdAll = beamRecs.filter((r) => metrics(r).topDiag);
  const bestTD = [...tdAll].sort((a, b) => metrics(b).ink.bottom - metrics(a).ink.bottom || b.state.progress - a.state.progress || a.state.cost - b.state.cost)[0];
  if (bestTD) {
    const m = metrics(bestTD);
    console.log(`  best TD state (max bottom ink, then progress, then cost): #${bestTD.id} beam L${beamLayer(bestTD)} goal=${bestTD.isGoal} expanded=${bestTD.expanded} prog=${f(bestTD.state.progress)} cost=${f(bestTD.state.cost, 1)} len=${f(bestTD.state.length, 0)}m Z(t/d/b)=${f(m.ink.top, 2)}/${f(m.ink.diagonal, 2)}/${f(m.ink.bottom, 2)} returned=${bestTD === returned}`);
    const desc = trace.records.filter((r) => r.id !== bestTD.id && isDescendant(trace, r, bestTD.id));
    const byLayer = new Map<number, StateRecord[]>();
    for (const d of desc) (byLayer.get(d.createdInLayer) ?? byLayer.set(d.createdInLayer, []).get(d.createdInLayer)!).push(d);
    for (const [L, rs] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
      const best = [...rs].sort((a, b) => metrics(b).ink.bottom - metrics(a).ink.bottom || b.state.progress - a.state.progress)[0]!;
      console.log(`    descendants created in layer ${L}: ${rs.length} (survived ${rs.filter((r) => r.fate === 'survived').length}, truncated ${rs.filter((r) => r.fate === 'truncated').length}, dedupe ${rs.filter((r) => r.fate === 'dedupe_rejected').length}); keep TD=${rs.filter((r) => metrics(r).topDiag).length}; max bottom ink=${f(metrics(best).ink.bottom, 2)} (#${best.id} ${best.fate} prog=${f(best.state.progress)} cost=${f(best.state.cost, 1)}${best.fate === 'truncated' ? ` rank ${best.truncationRank}/${best.truncationListSize} cutoff ${f(best.truncationCutoffCost, 1)}` : ''})`);
    }
    if (desc.length === 0) console.log(`    NO descendants: ${bestTD.expanded ? `expanded, but every outgoing edge filtered ${JSON.stringify(bestTD.edgesFiltered)} or no outgoing edges` : 'never expanded (search ended first)'}`);
  }

  // ------------------------------------------------ BEST BOTTOM STATE (Part 6)
  console.log('');
  console.log('=== FOLLOW THE BEST BOTTOM-REACHING STATE (ancestry, backward) ===');
  const bottomGoals = goals.filter((r) => metrics(r).bottom);
  const bestBottom = [...bottomGoals].sort((a, b) => a.state.cost - b.state.cost)[0] ?? [...beamRecs.filter((r) => metrics(r).bottom)].sort((a, b) => a.state.cost - b.state.cost)[0];
  let divergence: { common: StateRecord; tdChild: StateRecord | null; bChild: StateRecord } | null = null;
  if (bestBottom) {
    const chain = ancestry(trace, bestBottom);
    console.log(`  best bottom goal #${bestBottom.id} beam L${beamLayer(bestBottom)} prog=${f(bestBottom.state.progress)} cost=${f(bestBottom.state.cost, 1)} Z(t/d/b)=${f(metrics(bestBottom).ink.top, 2)}/${f(metrics(bestBottom).ink.diagonal, 2)}/${f(metrics(bestBottom).ink.bottom, 2)}`);
    console.log('    step  #id    beam  prog   cost    len   Z(t/d/b)         heading perp  backtr  edge');
    for (const r of chain) {
      const m = metrics(r);
      console.log(`    ${String(chain.indexOf(r)).padStart(4)}  #${String(r.id).padEnd(5)} L${String(beamLayer(r)).padEnd(3)} ${f(r.state.progress)}  ${f(r.state.cost, 1).padStart(6)}  ${f(r.state.length, 0).padStart(4)}  ${f(m.ink.top, 2)}/${f(m.ink.diagonal, 2)}/${f(m.ink.bottom, 2)}   ${f(m.headingFit, 2)}   ${f(m.meanPerp, 0).padStart(3)}  ${f(m.backtracking, 2)}  ${r.edgeId}`);
    }
    // Divergence from the returned (top+diag) lineage.
    const retChain = ancestry(trace, returned);
    let k = 0;
    while (k < chain.length && k < retChain.length && chain[k]!.id === retChain[k]!.id) k += 1;
    if (k > 0) {
      divergence = { common: chain[k - 1]!, tdChild: retChain[k] ?? null, bChild: chain[k]! };
      console.log(`  divergence from the RETURNED (top+diag) lineage after step ${k - 1} (#${chain[k - 1]!.id}, beam L${beamLayer(chain[k - 1]!)} prog=${f(chain[k - 1]!.state.progress)}): bottom branch takes ${chain[k]?.edgeId}, returned branch takes ${retChain[k]?.edgeId}`);
    } else console.log('  bottom lineage and returned lineage share NO ancestor (different start edges)');
    const firstTopHeld = retChain.findIndex((r) => metrics(r).top);
    console.log(`  returned lineage first holds TOP at step ${firstTopHeld} (beam L${firstTopHeld >= 0 ? beamLayer(retChain[firstTopHeld]!) : '-'}); bottom lineage ever holds TOP: ${chain.some((r) => metrics(r).top)}`);
  }

  // ------------------------------------------- COST COMPARISON (Parts 7-8)
  console.log('');
  console.log('=== COST DECOMPOSITION (exact edgeCostBreakdown replay) ===');
  const show = (label: string, r: StateRecord | undefined | null) => {
    if (!r) return null;
    const d = decomposeCost(trace, r, robz1.targetLength, robz1.loop, robz1.kind, result.regions);
    const m = metrics(r);
    console.log(`  ${label.padEnd(30)} #${r.id} beam L${beamLayer(r)} prog=${f(r.state.progress)} len=${f(r.state.length, 0)}m cost=${f(d.total, 2)} (matches=${d.matches}) Z=${f(m.ink.top, 2)}/${f(m.ink.diagonal, 2)}/${f(m.ink.bottom, 2)} :: ${Object.entries(d.terms).map(([k, v]) => `${k}=${f(v, 1)}`).join(' ')}`);
    return d;
  };
  const dA = show('A returned (top+diag)', returned);
  const dB = show('B best bottom goal', bestBottom);
  if (bestTD && bestTD !== returned) show('best TD (if different)', bestTD);
  if (dA && dB) {
    const diff = Object.fromEntries(Object.keys(dA.terms).map((k) => [k, (dB.terms as Record<string, number>)[k]! - (dA.terms as Record<string, number>)[k]!]));
    console.log(`  cost(B) - cost(A) = ${f(dB.total - dA.total, 2)} :: ${Object.entries(diff).filter(([, v]) => Math.abs(v) > 0.05).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([k, v]) => `${k}=${v >= 0 ? '+' : ''}${f(v, 1)}`).join(' ')}`);
  }
  if (divergence) {
    // The shared prefix cancels; only the post-divergence cost matters.
    console.log(`  divergence point #${divergence.common.id}: after it, returned branch adds cost ${f(returned.state.cost - divergence.common.state.cost, 1)} over ${returned.state.edgeIds.length - divergence.common.state.edgeIds.length} edges (Δprog ${f(returned.state.progress - divergence.common.state.progress)}, Δlen ${f(returned.state.length - divergence.common.state.length, 0)}m); bottom branch adds ${f(bestBottom!.state.cost - divergence.common.state.cost, 1)} over ${bestBottom!.state.edgeIds.length - divergence.common.state.edgeIds.length} edges (Δprog ${f(bestBottom!.state.progress - divergence.common.state.progress)}, Δlen ${f(bestBottom!.state.length - divergence.common.state.length, 0)}m)`);
  }

  // ------------------------------------------------- DEDUPE (Part 9)
  console.log('');
  console.log('=== DEDUPLICATION ===');
  const dd = trace.records.filter((r) => r.fate === 'dedupe_rejected');
  const ddTD = dd.filter((r) => metrics(r).topDiag);
  const ddTDvsBad = ddTD.filter((r) => r.dedupeHolderId !== null && !metrics(trace.records[r.dedupeHolderId]!).top);
  console.log(`  dedupe-rejected states=${dd.length}; holding Top+Diag=${ddTD.length}; of those rejected against a holder WITHOUT top=${ddTDvsBad.length}`);
  for (const r of ddTDvsBad.slice(0, 10)) {
    const h = trace.records[r.dedupeHolderId!]!;
    console.log(`    #${r.id} (Z ${f(metrics(r).ink.top, 2)}/${f(metrics(r).ink.diagonal, 2)}/${f(metrics(r).ink.bottom, 2)} prog ${f(r.state.progress)} cost ${f(r.state.cost, 1)}) lost key ${r.dedupeKey} to #${h.id} (Z ${f(metrics(h).ink.top, 2)}/${f(metrics(h).ink.diagonal, 2)}/${f(metrics(h).ink.bottom, 2)} prog ${f(h.state.progress)} cost ${f(h.state.cost, 1)}); Δcost=${f(r.state.cost - h.state.cost, 1)}`);
  }
  const ddAll3 = dd.filter((r) => metrics(r).all3);
  console.log(`  dedupe-rejected ALL-3 states: ${ddAll3.length}`);

  // Quality of the dedupe victims that held Top+Diag (were they genuinely better routes?).
  console.log('  quality of Top+Diag dedupe victims vs the state that held their key (lowest-cost victims first, unique paths):');
  const seenPaths = new Set<string>();
  const victims = [...ddTD].sort((a, b) => a.state.cost - b.state.cost).filter((r) => {
    const k = r.state.edgeIds.join(',');
    if (seenPaths.has(k)) return false;
    seenPaths.add(k);
    return true;
  });
  let victimsBetter = 0;
  let victimsZphys = 0;
  for (const r of victims) {
    const e = evaluateState(robz1, trace, r, result.regions as never, result.search as never);
    const h = r.dedupeHolderId !== null ? trace.records[r.dedupeHolderId]! : null;
    const he = h ? evaluateState(robz1, trace, h, result.regions as never, result.search as never) : null;
    const zTrav = analyzeStrokeTraversal(buildRoutePieces(metrics(r).path, robz1.target), robz1.target, { label: 'bottom', start: robz1.ranges[2]!.start, end: robz1.ranges[2]!.end });
    if (e.fl?.physicallyCovered) victimsZphys += 1;
    if (he && e.failure === null && e.q.shapeScore > he.q.shapeScore) victimsBetter += 1;
    if (victims.indexOf(r) < 8)
      console.log(`    victim #${r.id} prog=${f(r.state.progress)} cost=${f(r.state.cost, 1)} Z ink ${f(metrics(r).ink.top, 2)}/${f(metrics(r).ink.diagonal, 2)}/${f(metrics(r).ink.bottom, 2)} Zphys=${e.fl?.physicallyCovered} Zcov=${f(e.fl?.coverage)} bottom traversal=${zTrav.category} (cov ${f(zTrav.coverage, 2)}) shape=${f(e.q.shapeScore)} feasible=${e.failure === null} | holder #${h?.id} top=${h ? f(metrics(h).ink.top, 2) : '-'} shape=${f(he?.q.shapeScore)} feasible=${he?.failure === null} Zphys=${he?.fl?.physicallyCovered}`);
  }
  console.log(`    unique victim paths=${victims.length}; victims with physically covered Z=${victimsZphys}; victims feasible AND higher shapeScore than their holder=${victimsBetter}`);

  // Z-physically-complete dedupe victims: could any have been RETURNED if it survived?
  const goalEligible = (r: StateRecord) => metrics(r).searchCoverage >= GRAPH_SHAPE.goalCoverage && r.state.progress >= GRAPH_SHAPE.goalProgress;
  const zPhysVictims = victims.map((r) => ({ r, e: evaluateState(robz1, trace, r, result.regions as never, result.search as never) })).filter((x) => x.e.fl?.physicallyCovered);
  console.log(`  Z-physically-complete victims=${zPhysVictims.length}: goal-eligible (cov>=${GRAPH_SHAPE.goalCoverage} & prog>=${GRAPH_SHAPE.goalProgress})=${zPhysVictims.filter((x) => goalEligible(x.r)).length}; feasible=${zPhysVictims.filter((x) => x.e.failure === null).length}; cheaper than the returned state (${f(returned.state.cost, 1)})=${zPhysVictims.filter((x) => x.r.state.cost < returned.state.cost).length}; progress range ${f(Math.min(...zPhysVictims.map((x) => x.r.state.progress)))}-${f(Math.max(...zPhysVictims.map((x) => x.r.state.progress)))}; cost range ${f(Math.min(...zPhysVictims.map((x) => x.r.state.cost)), 1)}-${f(Math.max(...zPhysVictims.map((x) => x.r.state.cost)), 1)}`);
  for (const x of [...zPhysVictims].sort((a, b) => b.e.q.shapeScore - a.e.q.shapeScore).slice(0, 5)) {
    const h = trace.records[x.r.dedupeHolderId!]!;
    const he = evaluateState(robz1, trace, h, result.regions as never, result.search as never);
    console.log(`    Zphys victim #${x.r.id} created L${x.r.createdInLayer} prog=${f(x.r.state.progress)} cov=${f(metrics(x.r).searchCoverage, 2)} goalEligible=${goalEligible(x.r)} cost=${f(x.r.state.cost, 1)} shape=${f(x.e.q.shapeScore)} Zcov=${f(x.e.fl?.coverage)} feasible=${x.e.failure === null} | lost key ${x.r.dedupeKey} to #${h.id} (cost ${f(h.state.cost, 1)} Z ink ${f(metrics(h).ink.top, 2)}/${f(metrics(h).ink.diagonal, 2)}/${f(metrics(h).ink.bottom, 2)} Zphys=${he.fl?.physicallyCovered} shape=${f(he.q.shapeScore)} fate=${h.fate})`);
  }

  {
    let holderNotZ = 0;
    for (const x of zPhysVictims) {
      const h = trace.records[x.r.dedupeHolderId!]!;
      if (!evaluateState(robz1, trace, h, result.regions as never, result.search as never).fl?.physicallyCovered) holderNotZ += 1;
    }
    console.log(`  Z-physically-complete victims whose key-holder is NOT Z-complete: ${holderNotZ}/${zPhysVictims.length}`);
  }

  // Anatomy of the Z-physically-complete beam states: stroke order + direction along the route.
  console.log('  anatomy of Z-physically-complete BEAM states (stroke direction via z-diagonal-direction-diagnostic; order = route metres where each stroke is first entered):');
  const zPhysBeam = beamRecs.filter((r) => metrics(r).all3).map((r) => ({ r, e: evaluateState(robz1, trace, r, result.regions as never, result.search as never) })).filter((x) => x.e.fl?.physicallyCovered);
  const orderCounts: Record<string, number> = {};
  const diagCats: Record<string, number> = {};
  for (const x of zPhysBeam) {
    const pieces = buildRoutePieces(metrics(x.r).path, robz1.target);
    const strokes = robz1.ranges.map((w) => ({ w, t: analyzeStrokeTraversal(pieces, robz1.target, { label: w.label, start: w.start, end: w.end }) }));
    const radius = coverageThresholdMeters(robz1.target);
    const firstAt = (w: { start: number; end: number }) => pieces.find((p) => p.perpendicularDistance <= radius && p.progress >= w.start && p.progress <= w.end)?.routeMeters ?? Infinity;
    const order = [...robz1.ranges].sort((a, b) => firstAt(a) - firstAt(b)).map((w) => w.label[0]).join('');
    orderCounts[order] = (orderCounts[order] ?? 0) + 1;
    const dc = strokes[1]!.t.category;
    diagCats[dc] = (diagCats[dc] ?? 0) + 1;
    const last = pieces[pieces.length - 1]!;
    if (zPhysBeam.indexOf(x) < 4)
      console.log(`    #${x.r.id} L${beamLayer(x.r)} state.progress=${f(x.r.state.progress)} final point: target progress ${f(last.progressB)} perp ${f(last.perpendicularDistance, 0)}m | stroke order=${order} | ${strokes.map((s) => `${s.w.label}:${s.t.category} signedAg=${f(s.t.signedAgreement, 2)} fwd=${f(s.t.forwardT, 2)} rev=${f(s.t.reverseT, 2)}`).join(' | ')}`);
  }
  console.log(`    stroke-entry orders (t=top d=diagonal b=bottom): ${JSON.stringify(orderCounts)}; diagonal categories: ${JSON.stringify(diagCats)} (n=${zPhysBeam.length})`);

  // All goal states and all-3-ink beam states: physical Z completion (the ink "all 3" flag uses coarse ±1/32 bins).
  console.log('');
  console.log('=== PHYSICAL Z CHECK (goal pool + all-3-ink beam states) ===');
  const physRows = [...goals, ...beamRecs.filter((r) => metrics(r).all3 && !r.isGoal)].map((r) => ({ r, e: evaluateState(robz1, trace, r, result.regions as never, result.search as never) }));
  const zPhys = physRows.filter((x) => x.e.fl?.physicallyCovered);
  console.log(`  goal states=${goals.length}; all-3-ink non-goal beam states=${physRows.length - goals.length}; with PHYSICALLY covered Z=${zPhys.length} (feasible ${zPhys.filter((x) => x.e.failure === null).length})`);
  const g7834 = goals.filter((r) => metrics(r).all3);
  for (const r of g7834) {
    const e = evaluateState(robz1, trace, r, result.regions as never, result.search as never);
    const bt = analyzeStrokeTraversal(buildRoutePieces(metrics(r).path, robz1.target), robz1.target, { label: 'bottom', start: robz1.ranges[2]!.start, end: robz1.ranges[2]!.end });
    console.log(`  all-3-ink GOAL #${r.id}: prog=${f(r.state.progress)} cost=${f(r.state.cost, 1)} shape=${f(e.q.shapeScore)} tgtCov=${f(e.q.targetCoverage)} route/tgt=${f(e.q.routeTarget)} Zphys=${e.fl?.physicallyCovered} Zcov=${f(e.fl?.coverage)} Zink=${f(e.fl?.rawInk, 2)} bottom traversal=${bt.category} (cov ${f(bt.coverage, 2)} fwdRun ${f(bt.longestForwardRunT, 2)}) feasible=${e.failure === null} (${e.failure ?? 'ok'}) letters=${e.q.letters.map((l) => `${l.letter}${l.physicallyCovered ? '✓' : '·'}`).join('')}`);
  }
  for (const x of zPhys.slice(0, 5)) console.log(`  Z-physically-covered state #${x.r.id} beam L${beamLayer(x.r)} goal=${x.r.isGoal} prog=${f(x.r.state.progress)} cost=${f(x.r.state.cost, 1)} shape=${f(x.e.q.shapeScore)} feasible=${x.e.failure === null}`);

  // ------------------------------------------------- TRUNCATION (Part 10)
  console.log('');
  console.log('=== BEAM TRUNCATION ===');
  const tr = trace.records.filter((r) => r.fate === 'truncated');
  const trTD = tr.filter((r) => metrics(r).topDiag);
  const trAll3 = tr.filter((r) => metrics(r).all3);
  console.log(`  beam width=${PRODUCTION_BEAM}; truncated states=${tr.length}; Top+Diag truncated=${trTD.length}; ALL-3 truncated=${trAll3.length}`);
  for (const l of trace.layers) {
    const created = trace.records.filter((r) => r.createdInLayer === l.layer && (r.fate === 'survived' || r.fate === 'truncated'));
    const tdRanked = created.filter((r) => metrics(r).topDiag).sort((a, b) => (a.truncationRank ?? 0) - (b.truncationRank ?? 0));
    if (!tdRanked.length) continue;
    const bestRank = tdRanked[0]!;
    console.log(`    layer ${l.layer}→${l.layer + 1}: TD pushed=${tdRanked.length} kept=${tdRanked.filter((r) => r.fate === 'survived').length} discarded=${tdRanked.filter((r) => r.fate === 'truncated').length}; best TD rank ${bestRank.truncationRank}/${bestRank.truncationListSize} (rank/beam=${f((bestRank.truncationRank ?? 0) / PRODUCTION_BEAM, 2)}) cost ${f(bestRank.state.cost, 1)} vs cutoff ${f(bestRank.truncationCutoffCost, 1)}; bottom-touching retained=${created.filter((r) => r.fate === 'survived' && metrics(r).ink.bottom > 0).length}`);
  }

  // ---------------------------------------------- CONNECTIVITY (Parts 11-12)
  console.log('');
  console.log('=== GRAPH CONNECTIVITY FROM TOP+DIAG STATES TO THE BOTTOM STROKE ===');
  const { directed: fresh } = buildDirected(robz1.graph, robz1.target, robz1.kind, false);
  const allDirected = new Map<string, Directed>([...(fresh as unknown as Map<string, Directed>)]);
  const outgoingAll = indexOutgoing(allDirected as never);
  const nodes = robz1.graph.nodes;
  const nearest = (p: Vec2, k: number) => Object.entries(nodes).map(([id, q]) => ({ id, d: Math.hypot(q.x - p.x, q.y - p.y) })).sort((a, b) => a.d - b.d).slice(0, k).map((e) => e.id);
  const bottomEnd = pointAtProgress(robz1.target, robz1.ranges[2]!.end);
  const bottomMid = pointAtProgress(robz1.target, (robz1.ranges[2]!.start + robz1.ranges[2]!.end) / 2);
  const radius = coverageThresholdMeters(robz1.target);
  const undirectedKeyOf = (e: Directed) => [e.id.replace(/#start$/, '').replace(/[><]$/, ''), e.reverseId.replace(/#start$/, '').replace(/[><]$/, '')].sort().join('~');
  const connFrom = (r: StateRecord, label: string) => {
    const node = r.state.node;
    const used = r.state.usedUndirected;
    const outgoingFree = new Map<string, Directed[]>();
    for (const [k, list] of outgoingAll as unknown as Map<string, Directed[]>) outgoingFree.set(k, list.filter((e) => !used.has(undirectedKeyOf(e))));
    for (const [tLabel, tp] of [['bottom mid', bottomMid], ['bottom end', bottomEnd]] as const) {
      const toNodes = new Set(nearest(tp, 3));
      const any = findShortestConnectingPath(allDirected as never, outgoingAll as never, new Set([node]), toNodes);
      const free = findShortestConnectingPath(allDirected as never, outgoingFree as never, new Set([node]), toNodes);
      const pathEdges = (p: typeof free) => (p ? p.edgeIds.map((id) => allDirected.get(id)!).filter(Boolean) : []);
      const fe = pathEdges(free);
      const straight = Math.hypot(nodes[node]!.x - tp.x, nodes[node]!.y - tp.y);
      console.log(
        `  ${label} #${r.id} node=${node} → ${tLabel} (${f(straight, 0)}m straight): shortest any-edge path=${any ? `${f(any.totalLengthMeters, 0)}m/${any.edgeIds.length} edges` : 'NONE'}; shortest path WITHOUT re-using this state's edges=${free ? `${f(free.totalLengthMeters, 0)}m/${free.edgeIds.length} edges, maxMeanPerp=${f(Math.max(...fe.map((e) => e.meanPerp)), 0)}m, crossing edges=${fe.filter((e) => e.crossing).length}, backward-progress edges=${fe.filter((e) => e.forwardness < 0).length}, within ink radius (${f(radius, 0)}m) at end=${fe.length ? fe[fe.length - 1]!.meanPerp <= radius : '-'}` : 'NONE'}; remaining length budget=${f(robz1.targetLength * GRAPH_SHAPE.maxRouteFactor - r.state.length, 0)}m`,
      );
    }
  };
  connFrom(returned, 'returned (top+diag) state');
  if (bestTD && bestTD !== returned) connFrom(bestTD, 'best TD state');
  // Connected component of the search (from the returned state's node, undirected reachability over ALL graph edges).
  {
    const adj = new Map<string, string[]>();
    for (const seg of robz1.graph.segments) {
      (adj.get(seg.from) ?? adj.set(seg.from, []).get(seg.from)!).push(seg.to);
      (adj.get(seg.to) ?? adj.set(seg.to, []).get(seg.to)!).push(seg.from);
    }
    const comp = new Set<string>([returned.state.node]);
    const queue = [returned.state.node];
    while (queue.length) for (const n of adj.get(queue.pop()!) ?? []) if (!comp.has(n)) (comp.add(n), queue.push(n));
    const startNode = trace.directed.get(ancestry(trace, returned)[0]!.edgeId!)?.from ?? '';
    const nearestIn = (p: Vec2, inComp: boolean) => Object.entries(nodes).filter(([id]) => comp.has(id) === inComp).map(([id, q]) => ({ id, d: Math.hypot(q.x - p.x, q.y - p.y) })).sort((a, b) => a.d - b.d)[0];
    console.log(`  search component: ${comp.size}/${Object.keys(nodes).length} graph nodes (start edge's node in component: ${comp.has(startNode)})`);
    for (let t = 0; t <= 1.0001; t += 0.125) {
      const pt = pointAtProgress(robz1.target, robz1.ranges[2]!.start + t * (robz1.ranges[2]!.end - robz1.ranges[2]!.start));
      const inC = nearestIn(pt, true);
      const outC = nearestIn(pt, false);
      console.log(`    bottom stroke t=${f(t, 3)}: nearest node IN search component ${f(inC?.d, 0)}m${inC && inC.d <= radius ? ' (within ink radius)' : ''}; nearest node in ANOTHER component ${outC ? `${f(outC.d, 0)}m` : 'none'}`);
    }
  }
  // Stroke transitions on the real graph (Part 12), same method as the Z forensic.
  const zb = letterBoundariesFromWordShape(buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' })).boundaries[3]!;
  const strokes = decomposeZStrokes(robz1.target, zb);
  const { directed: d2, outgoing: o2 } = buildDirected(robz1.graph, robz1.target, robz1.kind, false);
  const mid = (pts: Vec2[]) => pts[Math.floor(pts.length / 2)]!;
  for (const [label, a, b] of [['top→diagonal', mid(strokes.top), mid(strokes.diagonal)], ['diagonal→bottom', mid(strokes.diagonal), mid(strokes.bottom)]] as const) {
    const c = testConnectivity(d2, o2, robz1.graph, a, b, 3);
    console.log(`  stroke transition ${label}: connected=${c.connected} graph=${f(c.routeDistanceMeters, 0)}m straight=${f(c.straightDistanceMeters, 0)}m ratio=${f(c.graphStraightRatio, 2)}`);
  }

  // --------------------------------------------- COUNTERFACTUALS (13-14)
  console.log('');
  console.log('=== COUNTERFACTUALS (mirror only; production untouched) ===');
  const baseSummary = summarizeRun('BASELINE (production parity)', robz1, base);
  const cf: Record<string, ReturnType<typeof summarizeRun>> = {};
  cf['beam×2 (cap unchanged)'] = summarizeRun('beam×2 (cap unchanged)', robz1, runTraced(robz1, { beamWidth: PRODUCTION_BEAM * 2 }));
  cf['beam×4 (cap unchanged)'] = summarizeRun('beam×4 (cap unchanged)', robz1, runTraced(robz1, { beamWidth: PRODUCTION_BEAM * 4 }));
  console.log('  supplementary (the cap is binding, so separate it from beam width):');
  cf['cap×2 (beam unchanged)'] = summarizeRun('cap×2 (beam unchanged)', robz1, runTraced(robz1, { maxExpansions: GRAPH_SHAPE.maxExpansions * 2 }));
  cf['cap×4 (beam unchanged)'] = summarizeRun('cap×4 (beam unchanged)', robz1, runTraced(robz1, { maxExpansions: GRAPH_SHAPE.maxExpansions * 4 }));
  cf['beam×2 + cap×2'] = summarizeRun('beam×2 + cap×2', robz1, runTraced(robz1, { beamWidth: PRODUCTION_BEAM * 2, maxExpansions: GRAPH_SHAPE.maxExpansions * 2 }));
  cf['beam×4 + cap×4'] = summarizeRun('beam×4 + cap×4', robz1, runTraced(robz1, { beamWidth: PRODUCTION_BEAM * 4, maxExpansions: GRAPH_SHAPE.maxExpansions * 4 }));
  console.log('  coverage-reward counterfactual (followBonus + overlapBonus scaled; the only cost terms that reward covering the target):');
  for (const k of [1.25, 1.5]) cf[`coverage×${k}`] = summarizeRun(`coverage reward ×${k}`, robz1, runTraced(robz1, { extraCost: (edge) => coverageRewardDelta(edge, k) }));

  // ------------------------------------------------ CRITICAL STATE TABLE
  console.log('');
  console.log('=== CRITICAL STATE TABLE ===');
  console.log('| State | Branch | Beam | Progress | Cost | Top | Diag | Bottom | Search cov | Heading | Backtrack | Status |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  const row = (r: StateRecord | undefined | null, branch: string) => {
    if (!r) return;
    const m = metrics(r);
    const status = `${r.fate}${r.isGoal ? '+goal' : ''}${trace.unexpandedAtCap.includes(r.id) ? '+unexpanded@cap' : r.expanded ? '+expanded' : ''}${r === returned ? ' (RETURNED)' : ''}`;
    console.log(`| #${r.id} | ${branch} | L${beamLayer(r)} | ${f(r.state.progress)} | ${f(r.state.cost, 1)} | ${f(m.ink.top, 2)} | ${f(m.ink.diagonal, 2)} | ${f(m.ink.bottom, 2)} | ${f(m.searchCoverage, 2)} | ${f(m.headingFit, 2)} | ${f(m.backtracking, 2)} | ${status} |`);
  };
  row(divergence?.common, 'common ancestor');
  row(returned, 'top+diag (A)');
  if (bestTD && bestTD !== returned) row(bestTD, 'best top+diag');
  if (bestBottom) for (const r of ancestry(trace, bestBottom).slice(divergence ? ancestry(trace, divergence.common).length : 0)) row(r, r === bestBottom ? 'bottom (B)' : 'bottom branch');
  const maxProgGoal = [...goals].sort((a, b) => b.state.progress - a.state.progress || a.state.cost - b.state.cost)[0];
  if (maxProgGoal && maxProgGoal !== bestBottom) row(maxProgGoal, 'max-progress goal');

  // ------------------------------------------------ FINAL COMPARISON (17)
  console.log('');
  console.log('=== ROBZ #1: PRODUCTION vs BEST DIAGNOSTICALLY RECOVERED STATE ===');
  const prodEval = evaluateState(robz1, trace, returned, result.regions as never, result.search as never);
  const line = (label: string, e: ReturnType<typeof evaluateState>, prog: number) => console.log(`  ${label.padEnd(44)} prog=${f(prog)} shape=${f(e.q.shapeScore)} tgtCov=${f(e.q.targetCoverage)} route/tgt=${f(e.q.routeTarget)} backtr=${f(e.q.backtracking)} Z(t/d/b)=${f(e.fl?.zStrokeInk?.top, 2)}/${f(e.fl?.zStrokeInk?.diagonal, 2)}/${f(e.fl?.zStrokeInk?.bottom, 2)} Zphys=${e.fl?.physicallyCovered} feasible=${e.failure === null}`);
  line('CURRENT PRODUCTION', prodEval, returned.state.progress);
  const recovered = Object.entries({ baseline: baseSummary, ...cf }).filter(([, s]) => s.bestAll3 && s.bestAll3.q.failure === null && s.bestAll3.q.fl?.physicallyCovered).sort((a, b) => b[1].bestAll3!.q.q.shapeScore - a[1].bestAll3!.q.q.shapeScore)[0];
  if (recovered) line(`best feasible Z-physically-complete (${recovered[0]}, #${recovered[1].bestAll3!.rec.id}, goal=${recovered[1].bestAll3!.rec.isGoal})`, recovered[1].bestAll3!.q, recovered[1].bestAll3!.rec.state.progress);
  else console.log('  no feasible all-three-stroke state found in ANY counterfactual');

  // ---------------------------------------------------------- CONTROLS (18)
  console.log('');
  console.log('=== CONTROLS: tracer-attached parity with production ===');
  const controls: Array<[string, string, typeof ZAMALEK, number, string]> = [
    ['ROBZ #2', 'ROBZ', ALEXANDRIA, 2000, 'sf-r315-s0.8-e0-n-400'],
    ['CAIRO O #2 (O control)', 'CAIRO', ZAMALEK, 4000, 'sf-r315-s0.6-e0-n0'],
    ['CAIRO O #1 (C/I control)', 'CAIRO', ALEXANDRIA, 2000, 'sf-r22.5-s1.0-e282.8-n-282.8'],
  ];
  for (const [label, word, start, dist, id] of controls) {
    const c = ctxOf(word, await fetchRecord(word, start, dist, id));
    const prod = routeGraphConstrainedShape({ target: c.target, graph: c.graph, kind: c.kind, multiLetter: true });
    const t = runTraced(c);
    const acct = t.trace.layers.every((l) => l.created === l.dedupeRejected + l.pushed && l.pushed === l.kept + l.truncated);
    console.log(`  ${label}: path=${JSON.stringify(t.result.pathPoints) === JSON.stringify(prod.pathPoints)} states=${t.result.search.statesExplored === prod.search.statesExplored} failure=${t.result.failure === prod.failure} shape=${t.result.metrics.shapeScore === prod.metrics.shapeScore} tgtCov=${t.result.metrics.targetCoverage === prod.metrics.targetCoverage} goals=${t.trace.records.filter((r) => r.isGoal).length} accounting=${acct}`);
  }

  writeFileSync(
    resolve(DIAGNOSTIC_DIR, 'beam-survival-diagnostic-results.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        candidate: 'ROBZ Zamalek/4000 sf-r315-s0.6-e-905.1-n905.1',
        layers: trace.layers,
        states: trace.records.filter((r) => r.fate !== 'dedupe_rejected' || metrics(r).topDiag).map((r) => ({ id: r.id, parentId: r.parentId, beam: beamLayer(r), fate: r.fate, goal: r.isGoal, expanded: r.expanded, edge: r.edgeId, node: r.state.node, progress: r.state.progress, cost: r.state.cost, length: r.state.length, ink: metrics(r).ink, searchCoverage: metrics(r).searchCoverage, truncationRank: r.truncationRank, dedupeHolderId: r.dedupeHolderId })),
        counterfactuals: Object.fromEntries(Object.entries(cf).map(([k, v]) => [k, { lastTopDiagBeam: v.tdLast, all3InAnyBeam: v.all3Beam, all3Goals: v.all3Goals, bestAll3: v.bestAll3 ? { id: v.bestAll3.rec.id, progress: v.bestAll3.rec.state.progress, shape: v.bestAll3.q.q.shapeScore, feasible: v.bestAll3.q.failure === null } : null }])),
        baseline: { lastTopDiagBeam: baseSummary.tdLast },
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log('');
  console.log(`[beam-survival] done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
