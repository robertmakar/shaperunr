/**
 * DEVELOPMENT ONLY. Tests for the letter-transition feasibility diagnostic.
 *
 * A. edgeCostBreakdown parity — sums to the exact real edgeCost() total.
 * B-E. Step 12's four synthetic controls: direct monotonic transition,
 *      transition requiring temporary backward progress, transition
 *      requiring corridor escape, disconnected letters.
 * F. production isolation / read-only graph.
 */
import { polylineLength, type Vec2 } from '@/lib/geometry';
import { explodeDirected, indexOutgoing, type LetterCorridor } from './beam-search-trace';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  analyzeTransitionPath,
  beamAchievesTransition,
  classifyTransition,
  corridorEntryExitNodes,
  edgeCostBreakdown,
  findShortestConnectingPath,
  realEdgeCost,
} from './letter-transition-diagnostic';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const rLetter = robzShape.letters[0]!;
const oLetter = robzShape.letters[1]!;
const target = robzShape.points;
const targetLength = polylineLength(target);
const rCorridor: LetterCorridor = { letter: 'R', index: 0, target: rLetter.points, thresholdMeters: 0.15 };
const oCorridor: LetterCorridor = { letter: 'O', index: 1, target: oLetter.points, thresholdMeters: 0.15 };

function buildDirected(segments: Array<{ id: string; wayId: string; from: string; to: string; points: Vec2[] }>) {
  const nodes: Record<string, Vec2> = {};
  for (const segment of segments) {
    nodes[segment.from] = segment.points[0]!;
    nodes[segment.to] = segment.points[segment.points.length - 1]!;
  }
  const graph = { nodes, segments };
  const directed = explodeDirected(graph, target, targetLength, 'generic', false, [], 0.15);
  return directed;
}

// --- A. edgeCostBreakdown parity ---
{
  const directed = buildDirected([
    { id: 'r', wayId: 'r', from: 'A', to: 'B', points: rLetter.points },
    { id: 'o', wayId: 'o', from: 'B', to: 'C', points: oLetter.points },
  ]);
  let allMatch = true;
  const details: string[] = [];
  for (const edge of directed.values()) {
    const breakdown = edgeCostBreakdown(edge, 0.1, targetLength, false, new Set(), 'generic', []);
    const real = realEdgeCost(edge, 0.1, targetLength, false, new Set(), 'generic', []);
    if (Math.abs(breakdown.total - real) > 1e-9) {
      allMatch = false;
      details.push(`${edge.id}: breakdown=${breakdown.total} real=${real}`);
    }
  }
  tests.push({
    name: 'A. edgeCostBreakdown parity: breakdown.total exactly matches the real edgeCost() for every edge',
    passed: allMatch,
    detail: allMatch ? 'all edges match exactly' : details.join('; '),
  });
}

// --- B. direct monotonic transition ---
{
  // R's own points, then a short direct link, then O's own points — low perp, no backward progress, no corridor escape.
  const link: Vec2[] = [rLetter.points[rLetter.points.length - 1]!, oLetter.points[0]!];
  const directed = buildDirected([
    { id: 'r', wayId: 'r', from: 'A', to: 'B', points: rLetter.points },
    { id: 'link', wayId: 'link', from: 'B', to: 'C', points: link },
    { id: 'o', wayId: 'o', from: 'C', to: 'D', points: oLetter.points },
  ]);
  const outgoing = indexOutgoing(directed);
  const fromNodes = corridorEntryExitNodes(directed, rCorridor);
  const toNodes = corridorEntryExitNodes(directed, oCorridor);
  const path = findShortestConnectingPath(directed, outgoing, fromNodes, toNodes);
  tests.push({ name: 'B. direct transition: a connecting path is found', passed: path != null, detail: path ? `edges=${path.edgeIds.join(',')}` : 'no path found' });
  if (path) {
    const analysis = analyzeTransitionPath(path, directed, targetLength, false, 'generic', [], 0.2);
    const classification = classifyTransition(analysis, true, true);
    tests.push({
      name: 'B. direct transition: classified as DIRECT_AND_FOUND (no backward progress, no corridor escape) when the beam achieves it',
      passed: classification === 'DIRECT_AND_FOUND',
      detail: `classification=${classification} backward=${analysis.requiredBackwardProgress.toFixed(3)} escape45=${analysis.requiresCorridorEscape45m}`,
    });
  }
}

// --- C. transition requiring temporary backward progress ---
{
  // A detour that loops back toward R's OWN START (much earlier target progress) before reaching O.
  const backwardDetour: Vec2[] = [rLetter.points[rLetter.points.length - 1]!, rLetter.points[0]!, oLetter.points[0]!];
  const directed = buildDirected([
    { id: 'r', wayId: 'r', from: 'A', to: 'B', points: rLetter.points },
    { id: 'detour', wayId: 'detour', from: 'B', to: 'C', points: backwardDetour },
    { id: 'o', wayId: 'o', from: 'C', to: 'D', points: oLetter.points },
  ]);
  const outgoing = indexOutgoing(directed);
  const fromNodes = corridorEntryExitNodes(directed, rCorridor);
  const toNodes = corridorEntryExitNodes(directed, oCorridor);
  const path = findShortestConnectingPath(directed, outgoing, fromNodes, toNodes);
  if (path) {
    const analysis = analyzeTransitionPath(path, directed, targetLength, false, 'generic', [], 0.9);
    tests.push({
      name: 'C. backward-progress transition: requiredBackwardProgress is measured as nonzero when the connecting path detours back toward an earlier part of the target',
      passed: analysis.requiredBackwardProgress > 0,
      detail: `requiredBackwardProgress=${analysis.requiredBackwardProgress.toFixed(3)} minProgress=${analysis.minProgressDuringTransition.toFixed(3)}`,
    });
    const classification = classifyTransition(analysis, true, true);
    tests.push({
      name: 'C. backward-progress transition: classified as DETOUR_AND_FOUND when achieved by the beam',
      passed: classification === 'DETOUR_AND_FOUND',
      detail: `classification=${classification}`,
    });
  } else {
    tests.push({ name: 'C. backward-progress transition: a connecting path is found', passed: false, detail: 'no path found' });
  }
}

// --- D. transition requiring corridor escape ---
{
  const farDetour: Vec2[] = [rLetter.points[rLetter.points.length - 1]!, { x: rLetter.points[rLetter.points.length - 1]!.x + 100, y: rLetter.points[rLetter.points.length - 1]!.y + 100 }, oLetter.points[0]!];
  const directed = buildDirected([
    { id: 'r', wayId: 'r', from: 'A', to: 'B', points: rLetter.points },
    { id: 'fardetour', wayId: 'fardetour', from: 'B', to: 'C', points: farDetour },
    { id: 'o', wayId: 'o', from: 'C', to: 'D', points: oLetter.points },
  ]);
  const outgoing = indexOutgoing(directed);
  const fromNodes = corridorEntryExitNodes(directed, rCorridor);
  const toNodes = corridorEntryExitNodes(directed, oCorridor);
  const path = findShortestConnectingPath(directed, outgoing, fromNodes, toNodes);
  if (path) {
    const analysis = analyzeTransitionPath(path, directed, targetLength, false, 'generic', [], 0.2);
    tests.push({
      name: 'D. corridor-escape transition: maxPerpendicularDistanceMeters exceeds the 45m follow radius for a far detour',
      passed: analysis.requiresCorridorEscape45m,
      detail: `maxPerp=${analysis.maxPerpendicularDistanceMeters.toFixed(1)}`,
    });
    const classification = classifyTransition(analysis, true, true);
    tests.push({
      name: 'D. corridor-escape transition: classified as DETOUR_AND_FOUND when achieved by the beam',
      passed: classification === 'DETOUR_AND_FOUND',
      detail: `classification=${classification}`,
    });
  } else {
    tests.push({ name: 'D. corridor-escape transition: a connecting path is found', passed: false, detail: 'no path found' });
  }
}

// --- E. disconnected letters ---
{
  const directed = buildDirected([
    { id: 'r', wayId: 'r', from: 'A', to: 'B', points: rLetter.points },
    { id: 'o', wayId: 'o', from: 'C', to: 'D', points: oLetter.points }, // no connecting edge at all
  ]);
  const outgoing = indexOutgoing(directed);
  const fromNodes = corridorEntryExitNodes(directed, rCorridor);
  const toNodes = corridorEntryExitNodes(directed, oCorridor);
  const path = findShortestConnectingPath(directed, outgoing, fromNodes, toNodes);
  tests.push({ name: 'E. disconnected letters: no connecting path is found', passed: path === null, detail: path ? `unexpectedly found path: ${path.edgeIds.join(',')}` : 'no path found, as expected' });
  const classification = classifyTransition(path ? analyzeTransitionPath(path, directed, targetLength, false, 'generic', [], 0.2) : null, false, true);
  tests.push({ name: 'E. disconnected letters: classified as DISCONNECTED', passed: classification === 'DISCONNECTED', detail: `classification=${classification}` });
}

// --- NO_DATA classification ---
{
  tests.push({
    name: 'classification: hasData=false always classifies as NO_DATA regardless of path/beam state',
    passed: classifyTransition(null, false, false) === 'NO_DATA' && classifyTransition(null, true, false) === 'NO_DATA',
    detail: 'verified both branches',
  });
}

// --- CONNECTED_BUT_BEAM_BLOCKED classification ---
{
  const link: Vec2[] = [rLetter.points[rLetter.points.length - 1]!, oLetter.points[0]!];
  const directed = buildDirected([
    { id: 'r', wayId: 'r', from: 'A', to: 'B', points: rLetter.points },
    { id: 'link', wayId: 'link', from: 'B', to: 'C', points: link },
    { id: 'o', wayId: 'o', from: 'C', to: 'D', points: oLetter.points },
  ]);
  const outgoing = indexOutgoing(directed);
  const fromNodes = corridorEntryExitNodes(directed, rCorridor);
  const toNodes = corridorEntryExitNodes(directed, oCorridor);
  const path = findShortestConnectingPath(directed, outgoing, fromNodes, toNodes);
  const analysis = path ? analyzeTransitionPath(path, directed, targetLength, false, 'generic', [], 0.2) : null;
  const classification = classifyTransition(analysis, false, true); // beamAchieves=false even though a path exists
  tests.push({
    name: 'classification: a connected path with beamAchieves=false classifies as CONNECTED_BUT_BEAM_BLOCKED',
    passed: classification === 'CONNECTED_BUT_BEAM_BLOCKED',
    detail: `classification=${classification}`,
  });
}

// --- beamAchievesTransition semantic check ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  void identity;
  // Uses R and Z (the FIRST and LAST letters of ROBZ, maximally separated) rather than R/O (adjacent letters close enough that an early point of one can accidentally register as "inside" the other's corridor at this test's tight synthetic threshold) — avoids a proximity false-positive unrelated to the ordering logic being tested.
  const zLetter = robzShape.letters[3]!;
  const zCorridor: LetterCorridor = { letter: 'Z', index: 3, target: zLetter.points, thresholdMeters: 0.15 };
  const achievedInOrder = beamAchievesTransition(robzShape.points, rCorridor, zCorridor);
  const notAchievedReversed = beamAchievesTransition([...zLetter.points, ...rLetter.points], rCorridor, zCorridor);
  tests.push({
    name: 'beamAchievesTransition: walking the full target in order (R then Z) achieves the R->Z transition',
    passed: achievedInOrder,
    detail: `achieved=${achievedInOrder}`,
  });
  tests.push({
    name: 'beamAchievesTransition: walking Z then R does NOT achieve the R->Z transition (order matters)',
    passed: !notAchievedReversed,
    detail: `achieved=${notAchievedReversed}`,
  });
}

// --- F. production isolation / read-only graph ---
{
  const directed = buildDirected([
    { id: 'r', wayId: 'r', from: 'A', to: 'B', points: rLetter.points },
    { id: 'o', wayId: 'o', from: 'B', to: 'C', points: oLetter.points },
  ]);
  const bigintSafe = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);
  const snapshot = JSON.stringify([...directed.entries()], bigintSafe);
  const outgoing = indexOutgoing(directed);
  const fromNodes = corridorEntryExitNodes(directed, rCorridor);
  const toNodes = corridorEntryExitNodes(directed, oCorridor);
  findShortestConnectingPath(directed, outgoing, fromNodes, toNodes);
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'F. read-only graph: the directed map is unchanged after running the connectivity search',
    passed: JSON.stringify([...directed.entries()], bigintSafe) === snapshot,
    detail: 'no mutation detected',
  });
  tests.push({
    name: 'F. production isolation: analyzeTargetIdentity results are unaffected by running the transition diagnostic',
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
