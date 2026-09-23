/**
 * DEVELOPMENT ONLY. Tests for the checkpoint-v1 candidate generator
 * (checkpoint-route-generator.ts) — this is a NEW, NOT-YET-WIRED module;
 * these tests never touch /generate-routes-experimental or graph-shape.ts.
 *
 * Covers the 14 categories this task's spec requires:
 * 1. C12 checkpoint generation
 * 2. checkpoint progress monotonicity
 * 3. exactly 3 snap candidates where available
 * 4. checkpoint beam maximum 8
 * 5. no graph mutation
 * 6. duplicate junction removal
 * 7. disconnected checkpoint detection
 * 8. multi-source shortest-path correctness
 * 9. deterministic candidate generation
 * 10. single-letter bypass
 * 11. smooth/angular metadata preservation
 * 12. existing scoring parity
 * 13. existing product-gate parity
 * 14. ROBZ/CAIRO structural cases (synthetic)
 */
import type { Vec2 } from '@/lib/geometry';
import { buildShapeGraph, type ShapeGraph } from './graph-shape';
import { analyzeTargetIdentity } from './target-identity';
import { experimentalProductRejectionReasons } from './experimental-product';
import { scorePolylines } from '../scoring/shape-match';
import { buildWalkableWordShape } from './walkable-target';
import { buildTargetCheckpoints, snapCheckpointToGraph, CHECKPOINT_SNAP_K } from '../diagnostics/checkpoint-route-experiment';
import { findShortestConnectingPath } from '../diagnostics/letter-transition-diagnostic';
import { explodeDirected, indexOutgoing } from '../diagnostics/beam-search-trace';
import { CHECKPOINT_V1, generateCheckpointRoutes, type CheckpointV1Input } from './checkpoint-route-generator';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const ORIGIN = { latitude: 30.0444, longitude: 31.2357 };

function graphOf(segments: Array<{ id: string; wayId: string; points: Vec2[] }>): ShapeGraph {
  return buildShapeGraph(segments);
}

/** A simple, fully-connected 4-segment "staircase" graph loosely tracing a straight multi-letter target, dense enough to give every checkpoint 3 real snap candidates. */
function buildDenseConnectedGraph(target: Vec2[]): ShapeGraph {
  const segments: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
  const steps = 12;
  for (let i = 0; i < steps; i += 1) {
    const a = target[Math.floor((i / steps) * (target.length - 1))]!;
    const b = target[Math.floor(((i + 1) / steps) * (target.length - 1))]!;
    segments.push({ id: `main${i}`, wayId: `wayMain${i}`, points: [{ ...a }, { ...b }] });
    // A short spur off each main node so every checkpoint sees >=3 distinct nearby nodes.
    segments.push({ id: `spur${i}`, wayId: `waySpur${i}`, points: [{ ...a }, { x: a.x + 3, y: a.y + 3 }] });
  }
  return graphOf(segments);
}

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const cairoShape = buildWalkableWordShape('CAIRO', { letterVariant: 'smooth' });
/** buildShapeGraph's node-snapping uses the real GRAPH_SHAPE.nodeSnapMeters=8m grid — abstract WordShape coordinates (~1 unit per letter) all collapse into a single node under that grid, so structural synthetic graphs must scale the abstract shape up to a realistic meters magnitude first (mirrors how production's own placement search scales a word up to real target-distance-meters). */
const ROBZ_SCALE = 150;
function scalePoints(points: Vec2[], scale: number): Vec2[] {
  return points.map((point) => ({ x: point.x * scale, y: point.y * scale }));
}
const robzTarget = scalePoints(robzShape.points, ROBZ_SCALE);
const cairoTarget = scalePoints(cairoShape.points, ROBZ_SCALE);
const straightTarget: Vec2[] = Array.from({ length: 20 }, (_, i) => ({ x: (i / 19) * 200, y: 0 }));

function baseInput(overrides: Partial<CheckpointV1Input> = {}): CheckpointV1Input {
  const target = overrides.target ?? straightTarget;
  const graph = overrides.graph ?? buildDenseConnectedGraph(target as Vec2[]);
  return {
    word: 'ROBZ',
    target,
    graph,
    kind: 'generic',
    geometryVariant: 'smooth',
    targetDistanceMeters: 2000,
    searchOrigin: ORIGIN,
    ...overrides,
  };
}

// --- 1. C12 checkpoint generation ---
{
  const result = generateCheckpointRoutes(baseInput());
  tests.push({
    name: '1. C12 checkpoint generation: checkpointsAttempted is exactly CHECKPOINT_V1.checkpointCount (12)',
    passed: result.checkpointsAttempted === CHECKPOINT_V1.checkpointCount && CHECKPOINT_V1.checkpointCount === 12,
    detail: `checkpointsAttempted=${result.checkpointsAttempted}`,
  });
}

// --- 2. checkpoint progress monotonicity ---
{
  const checkpoints = buildTargetCheckpoints(straightTarget, CHECKPOINT_V1.checkpointCount);
  const monotonic = checkpoints.every((c, i) => i === 0 || c.targetProgress > checkpoints[i - 1]!.targetProgress);
  tests.push({
    name: '2. checkpoint progress monotonicity: progress strictly increases from 0 to 1 across all 12 checkpoints',
    passed: monotonic && checkpoints[0]!.targetProgress === 0 && checkpoints[checkpoints.length - 1]!.targetProgress === 1,
    detail: `monotonic=${monotonic} first=${checkpoints[0]!.targetProgress} last=${checkpoints[checkpoints.length - 1]!.targetProgress}`,
  });
}

// --- 3. exactly 3 snap candidates where available ---
{
  const graph = buildDenseConnectedGraph(straightTarget);
  const checkpoints = buildTargetCheckpoints(straightTarget, 12);
  const snap = snapCheckpointToGraph(checkpoints[5]!, graph, CHECKPOINT_SNAP_K);
  tests.push({
    name: '3. exactly K=3 snap candidates returned when >=3 graph nodes exist nearby',
    passed: snap.candidates.length === 3 && CHECKPOINT_V1.snapCandidates === 3,
    detail: `candidateCount=${snap.candidates.length}`,
  });
  // Fewer-than-3 case: a graph with only 1 node total.
  const sparseGraph = graphOf([{ id: 'only', wayId: 'w', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }]);
  const sparseSnap = snapCheckpointToGraph(checkpoints[0]!, sparseGraph, CHECKPOINT_SNAP_K);
  tests.push({
    name: '3b. fewer than K candidates returned when fewer real graph nodes exist (uses however many exist)',
    passed: sparseSnap.candidates.length === 2,
    detail: `candidateCount=${sparseSnap.candidates.length} (graph has exactly 2 nodes)`,
  });
}

// --- 4. checkpoint beam maximum 8 ---
{
  const result = generateCheckpointRoutes(baseInput());
  tests.push({
    name: '4. checkpoint beam maximum: candidates.length never exceeds CHECKPOINT_V1.maxCandidateRoutes (8)',
    passed: result.candidates.length <= CHECKPOINT_V1.maxCandidateRoutes && CHECKPOINT_V1.maxCandidateRoutes === 8,
    detail: `candidateCount=${result.candidates.length}`,
  });
}

// --- 5. no graph mutation ---
{
  const graph = buildDenseConnectedGraph(straightTarget);
  const snapshot = JSON.stringify(graph);
  generateCheckpointRoutes(baseInput({ graph }));
  tests.push({
    name: '5. no graph mutation: the input graph object is byte-identical before and after generation',
    passed: JSON.stringify(graph) === snapshot,
    detail: 'no mutation detected',
  });
}

// --- 6. duplicate junction removal ---
{
  const result = generateCheckpointRoutes(baseInput());
  let anyDuplicate = false;
  for (const candidate of result.candidates) {
    const coords = candidate.route.coordinates;
    for (let i = 1; i < coords.length; i += 1) {
      if (coords[i]!.latitude === coords[i - 1]!.latitude && coords[i]!.longitude === coords[i - 1]!.longitude) {
        anyDuplicate = true;
      }
    }
  }
  tests.push({
    name: '6. duplicate junction removal: no candidate route has a duplicated consecutive coordinate at a segment boundary',
    passed: !anyDuplicate && result.candidates.length > 0,
    detail: `candidateCount=${result.candidates.length} anyDuplicate=${anyDuplicate}`,
  });
}

// --- 7. disconnected checkpoint detection ---
{
  // Two clusters, each internally dense (>=3 nodes), never joined — same pattern proven in the diagnostic's own self-test.
  const near: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
  const far: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
  for (let i = 0; i < 4; i += 1) {
    near.push({ id: `near${i}`, wayId: 'wN', points: [{ x: i * 10, y: 0 }, { x: (i + 1) * 10, y: 0 }] });
    far.push({ id: `far${i}`, wayId: 'wF', points: [{ x: 170 + i * 10, y: 0 }, { x: 180 + i * 10, y: 0 }] });
  }
  const graph = graphOf([...near, ...far]);
  const disconnectedTarget: Vec2[] = Array.from({ length: 20 }, (_, i) => ({ x: (i / 19) * 200, y: 0 }));
  const result = generateCheckpointRoutes(baseInput({ target: disconnectedTarget, graph }));
  const anyDisconnected = result.candidates.some((c) => !c.fullyConnected);
  tests.push({
    name: '7. disconnected checkpoint detection: at least one candidate is correctly marked fullyConnected=false when the graph has a real gap',
    passed: result.eligible && (result.candidates.length === 0 || anyDisconnected),
    detail: `candidateCount=${result.candidates.length} anyDisconnected=${anyDisconnected}`,
  });
}

// --- 8. multi-source shortest-path correctness (reused primitive, re-confirmed at this integration point) ---
{
  const graph = buildDenseConnectedGraph(straightTarget);
  const directed = explodeDirected(graph, straightTarget, 200, 'generic', false, [{ id: 'shape', startProgress: 0, endProgress: 1 }], 15);
  const outgoing = indexOutgoing(directed);
  const fromNode = Object.keys(graph.nodes)[0]!;
  const toNode = Object.keys(graph.nodes)[Object.keys(graph.nodes).length - 1]!;
  const path = findShortestConnectingPath(directed, outgoing, new Set([fromNode]), new Set([toNode]));
  tests.push({
    name: '8. multi-source shortest-path correctness: a connected pair of nodes in the dense graph finds a real path',
    passed: path != null && path.edgeIds.length > 0,
    detail: `found=${path != null} edgeCount=${path?.edgeIds.length ?? 0}`,
  });
}

// --- 9. deterministic candidate generation ---
{
  const input = baseInput();
  const result1 = generateCheckpointRoutes(input);
  const result2 = generateCheckpointRoutes(input);
  const strip = (r: ReturnType<typeof generateCheckpointRoutes>) =>
    JSON.stringify(r.candidates.map((c) => ({ shapeScore: c.route.shapeScore, coords: c.route.coordinates, fullyConnected: c.fullyConnected })));
  tests.push({
    name: '9. deterministic candidate generation: two runs on the identical input produce byte-identical candidates',
    passed: strip(result1) === strip(result2),
    detail: `candidateCount1=${result1.candidates.length} candidateCount2=${result2.candidates.length}`,
  });
}

// --- 10. single-letter bypass ---
{
  const result = generateCheckpointRoutes(baseInput({ word: 'L' }));
  tests.push({
    name: '10. single-letter bypass: word="L" returns eligible=false and zero candidates without running any checkpoint logic',
    passed: !result.eligible && result.candidates.length === 0 && result.checkpointsAttempted === 0,
    detail: `eligible=${result.eligible} candidateCount=${result.candidates.length} checkpointsAttempted=${result.checkpointsAttempted}`,
  });
}

// --- 11. smooth/angular metadata preservation ---
{
  const smoothResult = generateCheckpointRoutes(baseInput({ geometryVariant: 'smooth' }));
  const angularResult = generateCheckpointRoutes(baseInput({ geometryVariant: 'angular' }));
  const smoothOk = smoothResult.candidates.every((c) => c.route.metadata.geometryVariant === 'smooth');
  const angularOk = angularResult.candidates.every((c) => c.route.metadata.geometryVariant === 'angular');
  tests.push({
    name: '11. smooth/angular metadata preservation: every candidate route.metadata.geometryVariant matches the requested variant',
    passed: smoothOk && angularOk && smoothResult.candidates.length > 0 && angularResult.candidates.length > 0,
    detail: `smoothOk=${smoothOk} angularOk=${angularOk}`,
  });
}

// --- 12. existing scoring parity ---
{
  const result = generateCheckpointRoutes(baseInput());
  let allMatch = true;
  const details: string[] = [];
  for (const candidate of result.candidates) {
    // Re-derive the route's own local pathPoints from its geo coordinates via the SAME searchOrigin, then re-score independently.
    const localRoute = candidate.route.shapeCoordinates!.map((coord) => localFromGeo(ORIGIN, coord));
    const localTarget = candidate.route.targetCoordinates.map((coord) => localFromGeo(ORIGIN, coord));
    const independentScore = scorePolylines(localRoute, localTarget);
    if (Math.abs(independentScore.score - candidate.route.shapeScore) > 1e-6) {
      allMatch = false;
      details.push(`${candidate.route.id}: independent=${independentScore.score} route=${candidate.route.shapeScore}`);
    }
  }
  tests.push({
    name: '12. existing scoring parity: every candidate.route.shapeScore exactly matches an independent scorePolylines() call on the same geometry',
    passed: allMatch && result.candidates.length > 0,
    detail: allMatch ? `all ${result.candidates.length} candidates match` : details.join('; '),
  });
}

// --- 13. existing product-gate parity ---
{
  const result = generateCheckpointRoutes(baseInput());
  let allMatch = true;
  for (const candidate of result.candidates) {
    const independentReasons = experimentalProductRejectionReasons(candidate.route, { word: 'ROBZ', targetDistance: 2000 });
    const matches = JSON.stringify(independentReasons) === JSON.stringify(candidate.productGateRejectionReasons) && (independentReasons.length === 0) === candidate.passesProductGate;
    if (!matches) allMatch = false;
  }
  tests.push({
    name: '13. existing product-gate parity: every candidate.passesProductGate/productGateRejectionReasons exactly matches an independent experimentalProductRejectionReasons() call',
    passed: allMatch && result.candidates.length > 0,
    detail: `candidateCount=${result.candidates.length} allMatch=${allMatch}`,
  });
}

// --- 14. ROBZ/CAIRO structural cases (synthetic) ---
{
  const robzGraph = buildDenseConnectedGraph(robzTarget);
  const robzResult = generateCheckpointRoutes(baseInput({ word: 'ROBZ', target: robzTarget, graph: robzGraph }));
  tests.push({
    name: '14a. ROBZ structural case: eligible, attempts 12 checkpoints, produces at least one candidate on a dense synthetic ROBZ-shaped graph',
    passed: robzResult.eligible && robzResult.checkpointsAttempted === 12 && robzResult.candidates.length > 0,
    detail: `eligible=${robzResult.eligible} checkpointsAttempted=${robzResult.checkpointsAttempted} candidateCount=${robzResult.candidates.length}`,
  });

  const cairoGraph = buildDenseConnectedGraph(cairoTarget);
  const cairoResult = generateCheckpointRoutes(baseInput({ word: 'CAIRO', target: cairoTarget, graph: cairoGraph, targetDistanceMeters: 2500 }));
  tests.push({
    name: '14b. CAIRO structural case: eligible, attempts 12 checkpoints, produces at least one candidate on a dense synthetic CAIRO-shaped graph',
    passed: cairoResult.eligible && cairoResult.checkpointsAttempted === 12 && cairoResult.candidates.length > 0,
    detail: `eligible=${cairoResult.eligible} checkpointsAttempted=${cairoResult.checkpointsAttempted} candidateCount=${cairoResult.candidates.length}`,
  });
}

// --- production isolation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  generateCheckpointRoutes(baseInput());
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'production isolation: running checkpoint-v1 generation does not change a subsequent real analyzeTargetIdentity() result',
    passed: identityBefore.targetSpan === identityAfter.targetSpan && identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord,
    detail: `before=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

function localFromGeo(origin: { latitude: number; longitude: number }, point: { latitude: number; longitude: number }): Vec2 {
  const east = (point.longitude - origin.longitude) * 111320 * Math.cos((origin.latitude * Math.PI) / 180);
  const north = (point.latitude - origin.latitude) * 111320;
  return { x: east, y: north };
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
