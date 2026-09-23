/**
 * DEVELOPMENT ONLY. Graph-construction audit of ROBZ #1's disconnected
 * bottom-stroke fragment (Zamalek / 4000m / sf-r315-s0.6-e-905.1-n905.1).
 * Read-only: rebuilds the raw pedestrian collection exactly as the pipeline
 * does (snapSearchOrigin -> collectNeighborhoodShapeGraph), proves the
 * corridor filter reproduces the record's graphLines, then compares
 * connectivity in the RAW collection vs the CORRIDOR graph, and asks
 * Valhalla for a pedestrian route across the gap as a ground-truth check.
 * graph-shape.ts and all production files are untouched.
 *
 * Run with: npx tsx src/diagnostics/graph-fragment-audit.run.ts
 */
import { distanceToPolyline, type Vec2 } from '@/lib/geometry';
import { localMeters, offsetCoordinate } from '@/lib/shape-projection';

import { runExperimentalPipelineMultiVariant } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, snapNodeId, GRAPH_SHAPE, type GraphSegment } from '../generation/graph-shape';
import { collectNeighborhoodShapeGraph, NEIGHBORHOOD_COLLECT } from '../generation/graph-shape-router';
import { snapSearchOrigin, searchOriginFromSnap } from '../generation/snap-search-origin';
import { getSearchRadiusForTargetDistance } from '../generation/search-radius';
import { filterCorridorSegments } from '../generation/shape-discovery';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { coverageThresholdMeters } from '../generation/target-identity';
import { routePedestrianLeg, locatePedestrianEdgeSets } from '../routing/valhalla';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { zStrokeRanges } from './z-checkpoint-repair-experiment';
import { pointAtProgress } from './z-diagonal-direction-diagnostic';
import { connectedComponents, nearestGap, nearMissEndpoints, shortestPathBetween, segmentDistanceToTarget } from './graph-fragment-audit';

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const PLACEMENT = 'sf-r315-s0.6-e-905.1-n905.1';
const RETURNED_NODE = '-496,536'; // node of the returned (top+diagonal) state, from beam-survival-diagnostic
const f = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));

async function main() {
  // 1. The candidate, exactly as the pipeline produced it.
  const report = await runExperimentalPipelineMultiVariant({ word: 'ROBZ', start: ZAMALEK, targetDistanceMeters: 4000 }, ['smooth']);
  const record = (report.diagnostics.feasibility ?? []).find((r) => r.feasible && r.placementId === PLACEMENT);
  if (!record) throw new Error('ROBZ #1 not found');
  const target = record.target;

  // 2. Rebuild the RAW collection the same way the pipeline does, and prove it matches.
  const originSnap = await snapSearchOrigin(ZAMALEK);
  const searchOrigin = searchOriginFromSnap(originSnap);
  const collection = await collectNeighborhoodShapeGraph(searchOrigin, { radiusMeters: getSearchRadiusForTargetDistance(4000) });
  const corridor = filterCorridorSegments(collection.segments, target);
  const parity = JSON.stringify(corridor.map((s) => s.points)) === JSON.stringify(record.graphLines);
  console.log('=== RECONSTRUCTION ===');
  console.log(`  search origin ${searchOrigin.latitude.toFixed(6)},${searchOrigin.longitude.toFixed(6)}; raw collection: ${collection.segments.length} Valhalla edges (radius ${getSearchRadiusForTargetDistance(4000)}m); corridor (≤${GRAPH_SHAPE.corridorMeters}m of target): ${corridor.length} edges; corridor graphLines identical to the pipeline record: ${parity}`);
  if (!parity) throw new Error('reconstruction does not match the pipeline corridor — stop');

  const corridorGraph = buildShapeGraph(corridor);
  const rawGraph = buildShapeGraph(collection.segments);
  const cc = connectedComponents(corridorGraph);
  const rc = connectedComponents(rawGraph);
  const mainComp = cc.nodeComponent.get(RETURNED_NODE);
  if (mainComp === undefined) throw new Error(`returned node ${RETURNED_NODE} not in corridor graph`);

  // 3. Walk the bottom stroke: which corridor component serves each t?
  const zBoundary = letterBoundariesFromWordShape(buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' })).boundaries[3]!;
  const bottom = zStrokeRanges(zBoundary)[2]!;
  const radius = coverageThresholdMeters(target);
  console.log('');
  console.log(`=== CORRIDOR COMPONENTS === ${cc.sizes.size} components; main (contains returned node ${RETURNED_NODE}) = C${mainComp} ${JSON.stringify(cc.sizes.get(mainComp))}; others: ${[...cc.sizes].filter(([k]) => k !== mainComp).map(([k, v]) => `C${k}:${v.nodes}n/${v.segments}e`).join(' ')}`);
  console.log(`  bottom stroke (progress ${bottom.start.toFixed(4)}–${bottom.end.toFixed(4)}), ink radius ${f(radius)}m: nearest corridor edge per component`);
  const fragCounts = new Map<number, number>();
  let lostAt: number | null = null;
  for (let i = 0; i <= 40; i += 1) {
    const t = i / 40;
    const p = pointAtProgress(target, bottom.start + t * (bottom.end - bottom.start));
    const byComp = new Map<number, { d: number; id: string }>();
    for (const s of corridorGraph.segments) {
      const d = distanceToPolyline(p, s.points);
      const k = cc.segmentComponent.get(s.id)!;
      if (d < (byComp.get(k)?.d ?? Infinity)) byComp.set(k, { d, id: s.id });
    }
    const main = byComp.get(mainComp);
    const other = [...byComp].filter(([k]) => k !== mainComp).sort((a, b) => a[1].d - b[1].d)[0];
    const servedByOther = other && other[1].d < (main?.d ?? Infinity);
    if (servedByOther && t > 0) fragCounts.set(other![0], (fragCounts.get(other![0]) ?? 0) + 1);
    if (lostAt === null && servedByOther) lostAt = t;
    if (i % 4 === 0 || (servedByOther && lostAt === t)) console.log(`    t=${t.toFixed(3)}: main C${mainComp} edge ${f(main?.d)}m${(main?.d ?? Infinity) <= radius ? '' : ' (OUTSIDE ink radius)'} | nearest other C${other?.[0]} ${f(other?.[1].d)}m${servedByOther ? '  ← served by the other component' : ''}`);
  }
  const fragComp = [...fragCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
  console.log(`  connectivity to the bottom stroke is lost at t≈${f(lostAt, 3)} (first t where a non-main component's edge is closer than any main-component edge); fragment = C${fragComp} ${JSON.stringify(cc.sizes.get(fragComp!))}`);
  if (fragComp === undefined) return;

  const mainSegs = corridorGraph.segments.filter((s) => cc.segmentComponent.get(s.id) === mainComp);
  const fragSegs = corridorGraph.segments.filter((s) => cc.segmentComponent.get(s.id) === fragComp);
  console.log(`  fragment edges: ${fragSegs.map((s) => `${s.id} (way ${s.wayId})`).join(', ')}`);

  // 4. Nearest gap + near-miss endpoints (snapping / T-junction losses) in the corridor graph.
  const gap = nearestGap(mainSegs, fragSegs)!;
  const gapA = offsetCoordinate(searchOrigin, gap.pointA.x, gap.pointA.y);
  const gapB = offsetCoordinate(searchOrigin, gap.pointB.x, gap.pointB.y);
  console.log('');
  console.log(`=== NEAREST GAP (corridor) === ${f(gap.distance)}m between main edge ${gap.segmentA} at (${f(gap.pointA.x)},${f(gap.pointA.y)}) [${gapA.latitude.toFixed(6)},${gapA.longitude.toFixed(6)}] and fragment edge ${gap.segmentB} at (${f(gap.pointB.x)},${f(gap.pointB.y)}) [${gapB.latitude.toFixed(6)},${gapB.longitude.toFixed(6)}]`);
  const nearMisses = [...nearMissEndpoints(fragSegs, mainSegs, 20), ...nearMissEndpoints(mainSegs, fragSegs, 20)];
  console.log(`  endpoints within 20m of the other component's geometry (never merged): ${nearMisses.length}${nearMisses.slice(0, 5).map((n) => ` | ${n.ofSegment} → ${n.toSegment} ${f(n.distance)}m ${n.toInterior ? 'T-junction (interior)' : 'endpoint-endpoint'}`).join('')}`);
  const within8 = nearMisses.filter((n) => n.distance <= GRAPH_SHAPE.nodeSnapMeters);
  console.log(`  of those within nodeSnapMeters (${GRAPH_SHAPE.nodeSnapMeters}m): ${within8.length}`);

  // 5. RAW collection connectivity.
  console.log('');
  console.log('=== RAW COLLECTION CONNECTIVITY ===');
  const rawMain = rc.nodeComponent.get(RETURNED_NODE);
  const fragNode = fragSegs[0]!.from;
  const rawFrag = rc.nodeComponent.get(fragNode);
  console.log(`  raw graph: ${rc.sizes.size} components; main node in raw C${rawMain} ${JSON.stringify(rc.sizes.get(rawMain!))}; fragment node in raw C${rawFrag} ${JSON.stringify(rc.sizes.get(rawFrag!))}; SAME component in raw data: ${rawMain === rawFrag}`);
  const corridorIds = new Set(corridor.map((s) => s.id));
  if (rawMain === rawFrag) {
    const mainNodes = new Set([...cc.nodeComponent].filter(([, k]) => k === mainComp).map(([n]) => n));
    const fragNodes = new Set([...cc.nodeComponent].filter(([, k]) => k === fragComp).map(([n]) => n));
    const path = shortestPathBetween(rawGraph, mainNodes, fragNodes)!;
    console.log(`  shortest RAW connection between the corridor components: ${f(path.lengthMeters, 0)}m over ${path.segments.length} edges`);
    for (const s of path.segments) console.log(`    ${s.id} way ${s.wayId}: in corridor=${corridorIds.has(s.id)}; nearest vertex to target ${f(segmentDistanceToTarget(s, target))}m (corridor keeps edges with ANY vertex ≤ ${GRAPH_SHAPE.corridorMeters}m)`);
    const dropped = path.segments.filter((s) => !corridorIds.has(s.id));
    console.log(`  → ${dropped.length} connecting edge(s) exist in the raw data but were removed by filterCorridorSegments`);
  } else {
    // Snapping check in RAW data too.
    const rawMainSegs = rawGraph.segments.filter((s) => rc.segmentComponent.get(s.id) === rawMain);
    const rawFragSegs = rawGraph.segments.filter((s) => rc.segmentComponent.get(s.id) === rawFrag);
    const rawGap = nearestGap(rawMainSegs, rawFragSegs)!;
    const rawNear = [...nearMissEndpoints(rawFragSegs, rawMainSegs, 20), ...nearMissEndpoints(rawMainSegs, rawFragSegs, 20)];
    console.log(`  raw components are also separate; nearest raw gap ${f(rawGap.distance)}m (${rawGap.segmentA} ↔ ${rawGap.segmentB}); raw near-miss endpoints ≤20m: ${rawNear.length}${rawNear.slice(0, 5).map((n) => ` | ${n.ofSegment}→${n.toSegment} ${f(n.distance)}m ${n.toInterior ? 'T-junction' : 'endpoint'}`).join('')}`);
  }

  // 6. Ground truth: does Valhalla's full pedestrian network connect the two sides of the gap?
  console.log('');
  console.log('=== VALHALLA PEDESTRIAN ROUTE ACROSS THE GAP (full network, not the collection) ===');
  try {
    const route = await routePedestrianLeg(gapA, gapB);
    const pts = route.coordinates.map((c) => localMeters(searchOrigin, c));
    const maxOff = Math.max(...pts.map((p) => distanceToPolyline(p, target)));
    const collected = new Set<string>();
    // Which parts of the route are covered by collected (raw) edges vs absent from the collection?
    let uncollected = 0;
    for (const p of pts) {
      const near = collection.segments.some((s) => distanceToPolyline(p, s.points) <= 3);
      if (!near) uncollected += 1;
      else collected.add('x');
    }
    console.log(`  route ${f(route.distanceMeters, 0)}m for a ${f(gap.distance)}m straight gap (ratio ${f(route.distanceMeters / Math.max(gap.distance, 1), 1)}); max distance from target along route ${f(maxOff, 0)}m; route vertices NOT on any collected edge (>3m): ${uncollected}/${pts.length}`);
    // Walk the route: for each vertex, the nearest COLLECTED edge, whether that edge is in the corridor, and its corridor component.
    const corridorIdSet = new Set(corridor.map((s) => s.id));
    console.log('  route vertex → nearest collected edge (distance) | in corridor | corridor component | distance to target');
    for (const [i, p] of pts.entries()) {
      let best: { id: string; wayId: string; d: number } | null = null;
      for (const s of collection.segments) {
        const d = distanceToPolyline(p, s.points);
        if (!best || d < best.d) best = { id: s.id, wayId: s.wayId, d };
      }
      const comp = best && corridorIdSet.has(best.id) ? `C${cc.segmentComponent.get(best.id)}` : '-';
      console.log(`    v${i} (${f(p.x)},${f(p.y)}) → ${best?.id} way ${best?.wayId} (${f(best?.d)}m) | ${best ? corridorIdSet.has(best.id) : '-'} | ${comp} | ${f(distanceToPolyline(p, target))}m`);
    }
    // Where does the route pass between components, and is there a snapped node mismatch there?
    const nodeIds = (s: { points: readonly Vec2[] }) => [snapNodeId(s.points[0]!), snapNodeId(s.points[s.points.length - 1]!)];
    const fragEnds = fragSegs.flatMap((s) => [s.points[0]!, s.points[s.points.length - 1]!]);
    console.log(`  fragment endpoints: ${fragEnds.map((e) => `(${f(e.x)},${f(e.y)})→node ${snapNodeId(e)}`).join(' ')}`);
    for (const e of fragEnds) {
      const nearMain = mainSegs.flatMap((s) => [s.points[0]!, s.points[s.points.length - 1]!]).map((q) => ({ q, d: Math.hypot(q.x - e.x, q.y - e.y) })).sort((a, b) => a.d - b.d)[0];
      console.log(`    fragment endpoint (${f(e.x)},${f(e.y)}) nearest MAIN endpoint (${f(nearMain?.q.x)},${f(nearMain?.q.y)}) ${f(nearMain?.d)}m apart → nodes ${snapNodeId(e)} vs ${nearMain ? snapNodeId(nearMain.q) : '-'}${nearMain && nearMain.d <= GRAPH_SHAPE.nodeSnapMeters && snapNodeId(e) !== snapNodeId(nearMain.q) ? '  ← within snap distance but DIFFERENT grid cells' : ''}`);
    }
    void nodeIds;

    // Targeted locate at every route vertex that is NOT on a collected edge: does Valhalla return the missing edge?
    console.log('');
    console.log('=== TARGETED LOCATE AT THE UNCOLLECTED ROUTE VERTEX (read-only) ===');
    const collectedIds = new Set(collection.segments.map((s) => s.id));
    const missingPts = pts.filter((p) => !collection.segments.some((s) => distanceToPolyline(p, s.points) <= 3));
    const located = await locatePedestrianEdgeSets(missingPts.map((p) => offsetCoordinate(searchOrigin, p.x, p.y)), 25, { verbose: true });
    const extra: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
    for (const set of located) {
      for (const e of set.edges) {
        if (!e.shape || e.shape.length < 2) continue;
        const id = e.edgeId ?? `way:${e.wayId}`;
        const pointsLocal = e.shape.map((c) => localMeters(searchOrigin, c));
        const inCollection = collectedIds.has(id);
        console.log(`  located edge ${id} way ${e.wayId}: ${pointsLocal.length} pts from (${f(pointsLocal[0]!.x)},${f(pointsLocal[0]!.y)}) to (${f(pointsLocal.at(-1)!.x)},${f(pointsLocal.at(-1)!.y)}), in raw collection=${inCollection}, distance to target ${f(segmentDistanceToTarget({ points: pointsLocal }, target))}m`);
        if (!inCollection && !extra.some((x) => x.id === id)) extra.push({ id, wayId: String(e.wayId ?? id), points: pointsLocal });
      }
    }
    if (extra.length) {
      // Shadow graph: the SAME corridor filter + buildShapeGraph, with the missing edges added to the raw collection.
      const shadowCorridor = filterCorridorSegments([...collection.segments, ...extra], target);
      const shadowGraph = buildShapeGraph(shadowCorridor);
      const sc = connectedComponents(shadowGraph);
      const joined = sc.nodeComponent.get(RETURNED_NODE) === sc.nodeComponent.get(fragSegs[0]!.from);
      console.log(`  shadow corridor with the ${extra.length} missing edge(s) added: ${shadowCorridor.length} edges, ${sc.sizes.size} components; main and bottom fragment CONNECTED: ${joined}`);
      if (joined) {
        const p2 = shortestPathBetween(shadowGraph, new Set([RETURNED_NODE]), new Set([fragSegs[0]!.from, fragSegs[0]!.to]));
        console.log(`    shortest link returned node → fragment in the shadow graph: ${f(p2?.lengthMeters, 0)}m via ${p2?.segments.map((x) => x.id).join(', ')}`);
      }
    }
    // Why the collection missed it: distance from the missing vertex to the nearest collection grid sample.
    const rad = getSearchRadiusForTargetDistance(4000);
    let nearestSample = Infinity;
    for (let east = -rad; east <= rad; east += NEIGHBORHOOD_COLLECT.stepMeters) {
      for (let north = -rad; north <= rad; north += NEIGHBORHOOD_COLLECT.stepMeters) {
        if (Math.hypot(east, north) > rad + 1) continue;
        for (const p of missingPts) nearestSample = Math.min(nearestSample, Math.hypot(p.x - east, p.y - north));
      }
    }
    console.log(`  nearest collectNeighborhoodShapeGraph locate sample to the missing vertex: ${f(nearestSample, 0)}m (grid step ${NEIGHBORHOOD_COLLECT.stepMeters}m, locate radius ${NEIGHBORHOOD_COLLECT.locateRadiusMeters}m)`);
  } catch (error) {
    console.log(`  Valhalla route failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  void ({} as GraphSegment);
  void ({} as Vec2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
