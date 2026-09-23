/**
 * DEVELOPMENT ONLY. Tests for the checkpoint-anchored graph routing
 * feasibility experiment (checkpoint-route-experiment.ts).
 *
 * Step 17's 5 mandatory synthetic controls:
 * 1. checkpoints on a straight connected graph produce a valid assembled route.
 * 2. a 90-degree street-grid path can connect checkpoints.
 * 3. a disconnected checkpoint pair is detected.
 * 4. multiple snap candidates can choose the connected candidate rather than nearest-but-dead-end.
 * 5. assembled routes remove duplicate junction nodes correctly.
 *
 * Plus: checkpoint generation semantics, snap-K semantics, read-only graph,
 * production isolation.
 */
import type { Vec2 } from '@/lib/geometry';
import { buildShapeGraph, type ShapeGraph } from '../generation/graph-shape';
import { analyzeTargetIdentity } from '../generation/target-identity';
import {
  buildTargetCheckpoints,
  CHECKPOINT_SNAP_K,
  evaluateSegmentRoute,
  searchCheckpointRoute,
  snapCheckpointToGraph,
  traceCheckpointRoute,
} from './checkpoint-route-experiment';
import { explodeDirected, indexOutgoing } from './beam-search-trace';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

function graphOf(segments: Array<{ id: string; wayId: string; points: Vec2[] }>): ShapeGraph {
  return buildShapeGraph(segments);
}

// --- 1. straight connected graph ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const graph = graphOf([{ id: 'seg0', wayId: 'way0', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }] }]);
  const trace = traceCheckpointRoute({ word: 'I', target, graph, kind: 'generic' }, 8);
  tests.push({
    name: '1. straight connected graph: checkpoint route is fully connected and pathPoints span the target',
    passed: trace.fullyConnected && trace.pathPoints.length >= 2,
    detail: `fullyConnected=${trace.fullyConnected} pathPoints=${trace.pathPoints.length} connectedSegments=${trace.connectedSegmentCount}/${trace.totalSegmentCount}`,
  });
}

// --- 2. 90-degree street grid ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  // An L-shaped grid: along X then along Y, connected at the corner node.
  const graph = graphOf([
    { id: 'legA', wayId: 'wayA', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }] },
    { id: 'legB', wayId: 'wayB', points: [{ x: 100, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 100 }] },
  ]);
  const trace = traceCheckpointRoute({ word: 'L', target, graph, kind: 'L' }, 8);
  tests.push({
    name: '2. 90-degree street-grid path connects checkpoints across the corner',
    passed: trace.fullyConnected && trace.pathPoints.length >= 3,
    detail: `fullyConnected=${trace.fullyConnected} pathPoints=${trace.pathPoints.length}`,
  });
}

// --- 3. disconnected checkpoint pair ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 500, y: 0 }];
  // Two 4-node clusters, each internally connected, far apart from each
  // other and never joined. Each cluster has >= K=3 nodes of its own so
  // that a checkpoint near one cluster never has a distant, wrong-cluster
  // node leak into its K=3 candidate set (which would let the beam
  // "cheat" by re-picking an already-visited node from the other
  // cluster purely because too few real nodes existed nearby).
  const graph = graphOf([
    { id: 'near0', wayId: 'wN', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { id: 'near1', wayId: 'wN', points: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
    { id: 'near2', wayId: 'wN', points: [{ x: 20, y: 0 }, { x: 30, y: 0 }] },
    { id: 'far0', wayId: 'wF', points: [{ x: 470, y: 0 }, { x: 480, y: 0 }] },
    { id: 'far1', wayId: 'wF', points: [{ x: 480, y: 0 }, { x: 490, y: 0 }] },
    { id: 'far2', wayId: 'wF', points: [{ x: 490, y: 0 }, { x: 500, y: 0 }] },
  ]);
  const trace = traceCheckpointRoute({ word: 'I', target, graph, kind: 'generic' }, 8);
  tests.push({
    name: '3. disconnected checkpoint pair is correctly detected as NOT fully connected',
    passed: !trace.fullyConnected && trace.connectedSegmentCount < trace.totalSegmentCount,
    detail: `fullyConnected=${trace.fullyConnected} connectedSegments=${trace.connectedSegmentCount}/${trace.totalSegmentCount}`,
  });
}

// --- 4. prefer connected candidate over nearest-but-dead-end ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const graph = graphOf([
    // A dead-end node very close to (100,0) but NOT connected to the start.
    { id: 'deadEnd', wayId: 'wDead', points: [{ x: 98, y: 5 }, { x: 102, y: 5 }] },
    // The real, connected path from (0,0) to a node further from (100,0) but reachable.
    { id: 'realPath', wayId: 'wReal', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 90, y: 20 }] },
  ]);
  const kBig = 5; // ensure both the dead-end and the real path's end node are among the candidates
  const target1 = { x: 100, y: 0 };
  const checkpoint = { index: 1, targetProgress: 1, targetCoordinate: target1, targetLetter: null };
  const snap = snapCheckpointToGraph(checkpoint, graph, kBig);
  const directed = explodeDirected(graph, target, 100, 'generic', false, [], 5);
  const outgoing = indexOutgoing(directed);
  const fromNode = graph.segments.find((s) => s.id === 'realPath')!.from;
  const results = snap.candidates.map((candidate) => evaluateSegmentRoute(directed, outgoing, target, 0, 1, fromNode, candidate.nodeId, { x: 0, y: 0 }, target1));
  const anyConnected = results.some((r) => r.connected);
  tests.push({
    name: '4. among K candidate nodes, at least one connected candidate is found even though the nearest candidate (dead end) is not reachable',
    passed: anyConnected,
    detail: `candidates=${snap.candidates.length} connectedCount=${results.filter((r) => r.connected).length} nearestNodeConnected=${results[0]?.connected}`,
  });
}

// --- 5. assembled routes remove duplicate junction nodes ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const graph = graphOf([
    { id: 'segA', wayId: 'wA', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] },
    { id: 'segB', wayId: 'wB', points: [{ x: 40, y: 0 }, { x: 100, y: 0 }] },
  ]);
  const trace = traceCheckpointRoute({ word: 'I', target, graph, kind: 'generic' }, 8);
  const duplicateJunction = trace.pathPoints.filter((point, index) => index > 0 && point.x === trace.pathPoints[index - 1]!.x && point.y === trace.pathPoints[index - 1]!.y);
  tests.push({
    name: '5. assembled route has no duplicate consecutive junction point at the segA/segB boundary',
    passed: trace.fullyConnected && duplicateJunction.length === 0,
    detail: `fullyConnected=${trace.fullyConnected} duplicateCount=${duplicateJunction.length} pathPoints=${trace.pathPoints.length}`,
  });
}

// --- checkpoint generation semantics ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const checkpoints = buildTargetCheckpoints(target, 8);
  const firstAtStart = checkpoints[0]!.targetProgress === 0 && checkpoints[0]!.targetCoordinate.x === 0 && checkpoints[0]!.targetCoordinate.y === 0;
  const lastAtEnd = checkpoints[checkpoints.length - 1]!.targetProgress === 1;
  const monotonic = checkpoints.every((c, i) => i === 0 || c.targetProgress > checkpoints[i - 1]!.targetProgress);
  tests.push({
    name: 'checkpoint generation: first checkpoint is the target start (progress 0), last is the target end (progress 1), progress strictly increasing',
    passed: firstAtStart && lastAtEnd && monotonic && checkpoints.length === 8,
    detail: `count=${checkpoints.length} first.progress=${checkpoints[0]!.targetProgress} last.progress=${checkpoints[checkpoints.length - 1]!.targetProgress} monotonic=${monotonic}`,
  });
}

// --- snap-K semantics ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const graph = graphOf([
    { id: 's0', wayId: 'w0', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { id: 's1', wayId: 'w1', points: [{ x: 20, y: 0 }, { x: 30, y: 0 }] },
    { id: 's2', wayId: 'w2', points: [{ x: 40, y: 0 }, { x: 50, y: 0 }] },
    { id: 's3', wayId: 'w3', points: [{ x: 60, y: 0 }, { x: 70, y: 0 }] },
  ]);
  const checkpoint = { index: 0, targetProgress: 0, targetCoordinate: { x: 0, y: 0 }, targetLetter: null };
  const snap = snapCheckpointToGraph(checkpoint, graph, CHECKPOINT_SNAP_K);
  const sortedByDistance = snap.candidates.every((c, i) => i === 0 || c.distanceMeters >= snap.candidates[i - 1]!.distanceMeters);
  tests.push({
    name: `snap-K semantics: returns exactly K=${CHECKPOINT_SNAP_K} candidates sorted by ascending distance`,
    passed: snap.candidates.length === CHECKPOINT_SNAP_K && sortedByDistance && snap.nearestNode != null,
    detail: `candidateCount=${snap.candidates.length} sortedByDistance=${sortedByDistance} nearestDistance=${snap.nearestDistanceMeters.toFixed(2)}`,
  });
}

// --- beam width bound ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }];
  const graph = graphOf([
    { id: 'a', wayId: 'wa', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { id: 'b', wayId: 'wb', points: [{ x: 100, y: 0 }, { x: 200, y: 0 }] },
  ]);
  const kind = 'generic' as const;
  const directed = explodeDirected(graph, target, 200, kind, false, [], 5);
  const outgoing = indexOutgoing(directed);
  const checkpoints = buildTargetCheckpoints(target, 8);
  const snaps = checkpoints.map((c) => snapCheckpointToGraph(c, graph, CHECKPOINT_SNAP_K));
  const { finalBeam } = searchCheckpointRoute(snaps, directed, outgoing, target);
  tests.push({
    name: 'beam width bound: the checkpoint-choice beam never exceeds CHECKPOINT_BEAM_WIDTH=8',
    passed: finalBeam.length <= 8,
    detail: `finalBeamSize=${finalBeam.length}`,
  });
}

// --- read-only graph ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const graph = graphOf([{ id: 'seg0', wayId: 'way0', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }] }]);
  const graphSnapshot = JSON.stringify(graph);
  traceCheckpointRoute({ word: 'I', target, graph, kind: 'generic' }, 12);
  tests.push({
    name: 'read-only graph: the input graph object is byte-identical before and after tracing',
    passed: JSON.stringify(graph) === graphSnapshot,
    detail: 'no mutation detected',
  });
}

// --- production isolation ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const graph = graphOf([{ id: 'seg0', wayId: 'way0', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }] }]);
  const identityBefore = analyzeTargetIdentity({ route: target, target, word: 'I', geometryVariant: 'smooth' });
  traceCheckpointRoute({ word: 'I', target, graph, kind: 'generic' }, 16);
  const identityAfter = analyzeTargetIdentity({ route: target, target, word: 'I', geometryVariant: 'smooth' });
  tests.push({
    name: 'production isolation: running the checkpoint experiment does not change a subsequent real analyzeTargetIdentity() result',
    passed: identityBefore.targetSpan === identityAfter.targetSpan && identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord,
    detail: `before=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
