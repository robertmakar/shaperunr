/**
 * DEVELOPMENT ONLY. Tests for the coverage-aware deduplication shadow
 * experiment.
 *
 * A. production parity (dedupMode='current' reproduces the real,
 *    unmodified routeGraphConstrainedShape() exactly — same start states,
 *    graph, edge expansion order, edge costs, coverage mask, progress
 *    bins, beam sort, beam width, expansion cap; all reused unchanged
 *    from beam-search-trace.ts's already-verified mirror helpers).
 * B. read-only graph.
 * C. production isolation.
 * D. control: when no node/progressBin group ever accumulates more than
 *    one distinct coverage mask, the coverage-aware key cannot possibly
 *    diverge from the current key, so both modes must produce identical
 *    results — proving the experiment's mechanism degenerates correctly
 *    when there is no mask diversity to preserve.
 */
import type { Vec2 } from '@/lib/geometry';
import { routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { traceGraphConstrainedShapeDedup } from './beam-dedup-diversity';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const rLetter = robzShape.letters[0]!;

function buildSyntheticGraph(): ShapeGraph {
  const points = rLetter.points.map((point) => ({ x: point.x + 0.02, y: point.y - 0.02 }));
  const chunk = Math.max(2, Math.floor(points.length / 4));
  const chunkStarts: number[] = [];
  for (let index = 0; index + 1 < points.length; index += chunk - 1) chunkStarts.push(index);

  const segments: Array<{ id: string; wayId: string; from: string; to: string; points: Vec2[] }> = [];
  for (let c = 0; c < chunkStarts.length; c += 1) {
    const start = chunkStarts[c]!;
    const end = Math.min(points.length - 1, c + 1 < chunkStarts.length ? chunkStarts[c + 1]! : points.length - 1);
    const slice = points.slice(start, end + 1);
    if (slice.length < 2) continue;
    segments.push({ id: `seg${c}`, wayId: `way${c}`, from: `node-${start}`, to: `node-${end}`, points: slice });
  }
  const detour = points.map((point, index) => ({ x: point.x + (index % 2 === 0 ? 0.6 : -0.6), y: point.y + 0.4 }));
  const firstNode = `node-${chunkStarts[0]!}`;
  const lastNode = `node-${Math.min(points.length - 1, chunkStarts[chunkStarts.length - 1]!)}`;
  segments.push({ id: 'detour', wayId: 'wayDetour', from: firstNode, to: lastNode, points: [{ ...points[chunkStarts[0]!]! }, ...detour, { ...points[points.length - 1]! }] });

  // A THIRD, more elaborate branch offering genuine competing routes so dedup collisions actually occur.
  const altBranch = points.map((point, index) => ({ x: point.x - (index % 3 === 0 ? 0.3 : 0.1), y: point.y + (index % 2 === 0 ? 0.15 : -0.15) }));
  segments.push({ id: 'alt', wayId: 'wayAlt', from: firstNode, to: lastNode, points: [{ ...points[chunkStarts[0]!]! }, ...altBranch, { ...points[points.length - 1]! }] });

  const nodes: Record<string, Vec2> = {};
  for (const segment of segments) {
    nodes[segment.from] = segment.points[0]!;
    nodes[segment.to] = segment.points[segment.points.length - 1]!;
  }
  return { nodes, segments };
}

const graph = buildSyntheticGraph();

// --- A. production parity ---
{
  const real = routeGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' });
  const { result: mirrored } = traceGraphConstrainedShapeDedup({ target: rLetter.points, graph, kind: 'generic' }, { dedupMode: 'current', collectStats: true });
  const metricsMatch = JSON.stringify(real.metrics) === JSON.stringify(mirrored.metrics);
  const pathMatch = JSON.stringify(real.pathPoints) === JSON.stringify(mirrored.pathPoints);
  const edgeIdsMatch = JSON.stringify(real.edgeIds) === JSON.stringify(mirrored.edgeIds);
  tests.push({
    name: 'A. production parity: dedupMode=current reproduces the real routeGraphConstrainedShape() result exactly (metrics, pathPoints, edgeIds) for a 3-branch competitive synthetic graph',
    passed: metricsMatch && pathMatch && edgeIdsMatch,
    detail: `metricsMatch=${metricsMatch} pathMatch=${pathMatch} edgeIdsMatch=${edgeIdsMatch} real.failure=${real.failure} mirrored.failure=${mirrored.failure}`,
  });
}

// --- A. production parity for a multi-letter (regions-collapsed) case ---
{
  const real = routeGraphConstrainedShape({ target: robzShape.points, graph, kind: 'generic', multiLetter: true });
  const { result: mirrored } = traceGraphConstrainedShapeDedup({ target: robzShape.points, graph, kind: 'generic', multiLetter: true }, { dedupMode: 'current' });
  const metricsMatch = JSON.stringify(real.metrics) === JSON.stringify(mirrored.metrics);
  tests.push({
    name: 'A. production parity (multiLetter=true, full ROBZ target): metrics match exactly',
    passed: metricsMatch,
    detail: `metricsMatch=${metricsMatch}`,
  });
}

// --- A. production parity for a no-graph case ---
{
  const emptyGraph: ShapeGraph = { nodes: {}, segments: [] };
  const real = routeGraphConstrainedShape({ target: rLetter.points, graph: emptyGraph, kind: 'generic' });
  const { result: mirrored } = traceGraphConstrainedShapeDedup({ target: rLetter.points, graph: emptyGraph, kind: 'generic' }, { dedupMode: 'current' });
  tests.push({
    name: 'A. production parity: both real and mirror report no_graph for an empty graph',
    passed: real.failure === 'no_graph' && mirrored.failure === 'no_graph',
    detail: `real.failure=${real.failure} mirrored.failure=${mirrored.failure}`,
  });
}

// --- collision stats sanity: the 3-branch competitive graph actually produces some dedup rejections to analyze ---
{
  const { stats, expansions } = traceGraphConstrainedShapeDedup({ target: rLetter.points, graph, kind: 'generic' }, { dedupMode: 'current', collectStats: true });
  tests.push({
    name: 'collision stats: the competitive synthetic graph produces at least one dedup attempt (proves the instrumentation runs, not a trivial zero-branch case)',
    passed: stats.totalDedupAttempts > 0 && expansions > 0,
    detail: `totalDedupAttempts=${stats.totalDedupAttempts} totalDedupRejections=${stats.totalDedupRejections} identicalMask=${stats.rejectionsIdenticalMask} differentMask=${stats.rejectionsDifferentMask}`,
  });
  tests.push({
    name: 'collision stats: identical-mask + different-mask rejection counts sum to totalDedupRejections (for rejections where a competing mask was recorded)',
    passed: stats.rejectionsIdenticalMask + stats.rejectionsDifferentMask <= stats.totalDedupRejections,
    detail: `identical=${stats.rejectionsIdenticalMask} different=${stats.rejectionsDifferentMask} total=${stats.totalDedupRejections}`,
  });
  tests.push({
    name: 'collision stats: every recorded Hamming distance is a non-negative integer bounded by 28 (the mask width)',
    passed: stats.hammingDistances.every((d) => Number.isInteger(d) && d >= 0 && d <= 28),
    detail: `n=${stats.hammingDistances.length} max=${stats.hammingDistances.length ? Math.max(...stats.hammingDistances) : 'n/a'}`,
  });
}

// --- coverage-aware mode never rejects MORE than current mode rejects at the same key granularity (it only relaxes collisions, never tightens them) ---
{
  const currentRun = traceGraphConstrainedShapeDedup({ target: rLetter.points, graph, kind: 'generic' }, { dedupMode: 'current' });
  const awareRun = traceGraphConstrainedShapeDedup({ target: rLetter.points, graph, kind: 'generic' }, { dedupMode: 'coverageAware' });
  tests.push({
    name: 'coverage-aware mode explores at least as many surviving states as current mode (max beam size never shrinks) for the same graph/target',
    passed: awareRun.maxBeamSize >= currentRun.maxBeamSize,
    detail: `current maxBeamSize=${currentRun.maxBeamSize} coverageAware maxBeamSize=${awareRun.maxBeamSize}`,
  });
}

// --- B. read-only graph ---
{
  const graphSnapshot = JSON.stringify(graph);
  const targetSnapshot = JSON.stringify(rLetter.points);
  traceGraphConstrainedShapeDedup({ target: rLetter.points, graph, kind: 'generic' }, { dedupMode: 'coverageAware', collectStats: true });
  tests.push({
    name: 'B. read-only graph: graph and target are byte-identical before and after tracing',
    passed: JSON.stringify(graph) === graphSnapshot && JSON.stringify(rLetter.points) === targetSnapshot,
    detail: 'no mutation detected',
  });
}

// --- C. production isolation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  traceGraphConstrainedShapeDedup({ target: rLetter.points, graph, kind: 'generic' }, { dedupMode: 'coverageAware', collectStats: true });
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'C. production isolation: running the dedup experiment does not change a subsequent real analyzeTargetIdentity() result',
    passed: identityBefore.targetSpan === identityAfter.targetSpan && identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord,
    detail: `before traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

// --- D. control: no mask diversity => both modes identical ---
{
  // A single, simple following path (no competing branch) should never accumulate more than one distinct mask per (node, progressBin) group, since there is only one way to reach any given node.
  const simpleGraph: ShapeGraph = {
    nodes: {},
    segments: [{ id: 'only', wayId: 'only', from: 'A', to: 'B', points: rLetter.points.map((point) => ({ x: point.x + 0.01, y: point.y })) }],
  };
  const currentRun = traceGraphConstrainedShapeDedup({ target: rLetter.points, graph: simpleGraph, kind: 'generic' }, { dedupMode: 'current', collectStats: true });
  const awareRun = traceGraphConstrainedShapeDedup({ target: rLetter.points, graph: simpleGraph, kind: 'generic' }, { dedupMode: 'coverageAware', collectStats: true });
  const noDiversity = Object.values(currentRun.stats.distinctMasksPerGroup).every((count) => count <= 1);
  tests.push({
    name: 'D. control: a single-path graph (no competing branches) never accumulates more than 1 distinct mask per (node, progressBin) group',
    passed: noDiversity,
    detail: `groups=${Object.keys(currentRun.stats.distinctMasksPerGroup).length} maxDistinct=${Math.max(0, ...Object.values(currentRun.stats.distinctMasksPerGroup))}`,
  });
  tests.push({
    name: 'D. control: with no mask diversity, coverage-aware mode degenerates to current mode exactly (identical result)',
    passed: JSON.stringify(currentRun.result.pathPoints) === JSON.stringify(awareRun.result.pathPoints) && JSON.stringify(currentRun.result.metrics) === JSON.stringify(awareRun.result.metrics),
    detail: `current.shapeScore=${currentRun.result.metrics.shapeScore} aware.shapeScore=${awareRun.result.metrics.shapeScore}`,
  });
}

// --- semantic: letter-corridor tracking reports the R corridor as entered and used by the final route on the R-following synthetic graph ---
{
  const rCorridor = { letter: 'R', index: 0, target: rLetter.points, thresholdMeters: 18 };
  const { letters } = traceGraphConstrainedShapeDedup({ target: rLetter.points, graph, kind: 'generic' }, { dedupMode: 'current', corridors: [rCorridor] });
  tests.push({
    name: 'semantic: the R corridor (which the synthetic graph was built to approximate) is entered, survives, and is used by the final selected route',
    passed: letters[0]!.everEntered && letters[0]!.everSurvivedBeamCut && letters[0]!.finalRouteUsesRegion,
    detail: `everEntered=${letters[0]!.everEntered} everSurvivedBeamCut=${letters[0]!.everSurvivedBeamCut} finalRouteUsesRegion=${letters[0]!.finalRouteUsesRegion}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
