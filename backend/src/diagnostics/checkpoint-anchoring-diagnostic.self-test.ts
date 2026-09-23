import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { buildShapeGraph } from '../generation/graph-shape';
import {
  buildLetterCheckpoints,
  buildSingleLetterCheckpoint,
  indexCheckpointBits,
  makeCheckpointExtraMaskUpdate,
  makeCheckpointAnchoringAugmenter,
  summarizeCheckpointConnectivity,
} from './checkpoint-anchoring-diagnostic';
import type { Directed, SearchState } from './graph-shape-goal-mirror';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

const SCALE = 500;
function scalePoints(points: readonly Vec2[]): Vec2[] {
  return points.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
}
function densify(points: readonly Vec2[], factor: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let s = 0; s < factor; s += 1) { const t = s / factor; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  out.push(points[points.length - 1]!);
  return out;
}
function buildDenseGraph(target: Vec2[]) {
  const segments: Array<{ id: string; wayId: string; points: Vec2[] }> = [];
  const steps = 16;
  for (let i = 0; i < steps; i += 1) {
    const a = target[Math.floor((i / steps) * (target.length - 1))]!;
    const b = target[Math.floor(((i + 1) / steps) * (target.length - 1))]!;
    segments.push({ id: `main${i}`, wayId: `w${i}`, points: [{ ...a }, { ...b }] });
  }
  return buildShapeGraph(segments);
}

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const target = scalePoints(robzShape.points);
const boundaries = letterBoundariesFromWordShape(robzShape).boundaries;
const graph = buildDenseGraph(target);

check('buildLetterCheckpoints midpoint mode produces exactly 1 checkpoint per letter', () => {
  const checkpoints = buildLetterCheckpoints(boundaries, target, graph, 3, 'midpoint');
  assert.equal(checkpoints.length, 4);
  assert.deepEqual(checkpoints.map((c) => c.letter), ['R', 'O', 'B', 'Z']);
  assert.deepEqual(checkpoints.map((c) => c.position), ['mid', 'mid', 'mid', 'mid']);
});

check('buildLetterCheckpoints startEnd mode produces exactly 2 checkpoints per letter', () => {
  const checkpoints = buildLetterCheckpoints(boundaries, target, graph, 3, 'startEnd');
  assert.equal(checkpoints.length, 8);
});

check('each checkpoint snaps to exactly K candidate nodes (dense graph, K=3)', () => {
  const checkpoints = buildLetterCheckpoints(boundaries, target, graph, 3, 'midpoint');
  for (const c of checkpoints) assert.equal(c.snap.candidateNodeCount, 3);
});

check('indexCheckpointBits + makeCheckpointExtraMaskUpdate: an edge ending AT a checkpoint node sets that checkpoint\'s bit', () => {
  const checkpoints = buildLetterCheckpoints(boundaries, target, graph, 1, 'midpoint');
  const { nodeToBits, bitToLetterIndex } = indexCheckpointBits(checkpoints);
  const update = makeCheckpointExtraMaskUpdate(nodeToBits);
  const rCheckpointNode = checkpoints[0]!.snap.nearestNode!;
  const edge: Directed = { id: 'e', wayId: 'w', from: 'x', to: rCheckpointNode, reverseId: 'e2', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], length: 1, meanPerp: 0, headingFit: 1, forward: 1, startProgress: 0, endProgress: 0.1, minProgress: 0, maxProgress: 0.1, progressSpan: 0.1, forwardness: 0.1, overlapMeters: 1, followMeters: 1, crossing: false, interior: false };
  const parent: SearchState = { node: 'x', progress: 0, cost: 0, length: 0, covered: 0, edgeIds: [], usedUndirected: new Set(), usedInterior: false, extraMask: 0 };
  const mask = update(parent, edge);
  assert.equal(mask & 1, 1);
  assert.equal(bitToLetterIndex[0], 0);
});

check('makeCheckpointAnchoringAugmenter: penalizes moving into O\'s window when R\'s checkpoint bit is unset in the parent state, zero penalty once set', () => {
  const checkpoints = buildLetterCheckpoints(boundaries, target, graph, 1, 'midpoint');
  const { bitToLetterIndex } = indexCheckpointBits(checkpoints);
  const augmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, checkpoints, { penaltyPerMissedCheckpoint: 50 });
  const oProgress = (boundaries[1]!.projectedStartProgress + boundaries[1]!.projectedEndProgress) / 2;
  const edgeIntoO: Directed = { id: 'e', wayId: 'w', from: 'x', to: 'y', reverseId: 'e2', points: [{ x: 0, y: 0 }], length: 1, meanPerp: 0, headingFit: 1, forward: 1, startProgress: oProgress - 0.01, endProgress: oProgress, minProgress: oProgress - 0.01, maxProgress: oProgress, progressSpan: 0.01, forwardness: 0.01, overlapMeters: 1, followMeters: 1, crossing: false, interior: false };
  const unset = augmenter(edgeIntoO, oProgress - 0.01, { node: 'x', progress: 0, cost: 0, length: 0, covered: 0, edgeIds: [], usedUndirected: new Set(), usedInterior: false, extraMask: 0 });
  const set = augmenter(edgeIntoO, oProgress - 0.01, { node: 'x', progress: 0, cost: 0, length: 0, covered: 0, edgeIds: [], usedUndirected: new Set(), usedInterior: false, extraMask: 1 });
  assert.equal(unset, 50);
  assert.equal(set, 0);
});

check('summarizeCheckpointConnectivity reports hit=true only for bits present in the final mask', () => {
  const checkpoints = buildLetterCheckpoints(boundaries, target, graph, 1, 'midpoint');
  const summary = summarizeCheckpointConnectivity(0b0101, checkpoints); // bits 0 and 2 hit -> R and B
  assert.equal(summary[0]!.hit, true); // R, bit 0
  assert.equal(summary[1]!.hit, false); // O, bit 1
  assert.equal(summary[2]!.hit, true); // B, bit 2
  assert.equal(summary[3]!.hit, false); // Z, bit 3
});

check('buildSingleLetterCheckpoint preserves the TRUE letter index (O is index 1 in ROBZ), not 0', () => {
  const oCheckpoints = buildSingleLetterCheckpoint(boundaries, 1, target, graph, 3, 'midpoint');
  assert.equal(oCheckpoints.length, 1);
  assert.equal(oCheckpoints[0]!.letter, 'O');
  assert.equal(oCheckpoints[0]!.letterIndex, 1);
});

check('makeCheckpointAnchoringAugmenter with a single-letter checkpoint list only penalizes moving PAST that letter (not letters before or the letter itself)', () => {
  const oCheckpoints = buildSingleLetterCheckpoint(boundaries, 1, target, graph, 1, 'midpoint');
  const { bitToLetterIndex } = indexCheckpointBits(oCheckpoints);
  const augmenter = makeCheckpointAnchoringAugmenter(boundaries, bitToLetterIndex, oCheckpoints, { penaltyPerMissedCheckpoint: 50 });
  const unset: SearchState = { node: 'x', progress: 0, cost: 0, length: 0, covered: 0, edgeIds: [], usedUndirected: new Set(), usedInterior: false, extraMask: 0 };
  // Edge whose endProgress is still within R (index 0, before O) -> no penalty (target letter O has not been passed yet).
  const rProgress = (boundaries[0]!.projectedStartProgress + boundaries[0]!.projectedEndProgress) / 2;
  const edgeInR: Directed = { id: 'e', wayId: 'w', from: 'x', to: 'y', reverseId: 'e2', points: [{ x: 0, y: 0 }], length: 1, meanPerp: 0, headingFit: 1, forward: 1, startProgress: rProgress - 0.01, endProgress: rProgress, minProgress: rProgress - 0.01, maxProgress: rProgress, progressSpan: 0.01, forwardness: 0.01, overlapMeters: 1, followMeters: 1, crossing: false, interior: false };
  assert.equal(augmenter(edgeInR, rProgress - 0.01, unset), 0);
  // Edge whose endProgress is now in B (index 2, after O) -> penalty, since O's checkpoint was never hit.
  const bProgress = (boundaries[2]!.projectedStartProgress + boundaries[2]!.projectedEndProgress) / 2;
  const edgeInB: Directed = { ...edgeInR, startProgress: bProgress - 0.01, endProgress: bProgress, minProgress: bProgress - 0.01, maxProgress: bProgress };
  assert.equal(augmenter(edgeInB, bProgress - 0.01, unset), 50);
});

console.log(`checkpoint-anchoring-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
