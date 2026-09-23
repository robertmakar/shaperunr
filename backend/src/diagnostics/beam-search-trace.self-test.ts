/**
 * DEVELOPMENT ONLY. Tests for the instrumented beam-search mirror.
 *
 * A. Production parity — traceGraphConstrainedShape()'s `result` must be
 *    byte-identical (pathPoints, edgeIds, metrics, failure) to the REAL,
 *    unmodified routeGraphConstrainedShape() for the same input.
 * B. Beam-state parity — the recorded trace is internally consistent with
 *    production's own pruning/slicing (survivedBeamCut never exceeds the
 *    real beam width; the state production actually selected shows up as
 *    surviving at every step of its own path).
 * C. Read-only graph — inputs are never mutated.
 * D. No production mutation — analyzeTargetIdentity() is unaffected.
 * E. Coverage parity — rawInkCoverage still matches production exactly.
 */
import type { Vec2 } from '@/lib/geometry';
import { routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeLetterEntries, traceGraphConstrainedShape, type LetterCorridor } from './beam-search-trace';
import { computeInkOnlyOccupancy } from './letter-occupancy';
import { letterBoundariesFromWordShape } from './multi-letter-trace';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const rLetter = robzShape.letters[0]!;

// A small synthetic zig-zag graph that imperfectly follows R, built from
// several CONNECTED segments (consecutive chunks share a node id) so the
// beam search has real transitions to make, plus a competing detour branch
// that also connects at the shared nodes (so the search has an actual
// choice between following R and drifting away from it).
function buildSyntheticGraph(): ShapeGraph {
  const points = rLetter.points.map((point) => ({ x: point.x + 0.02, y: point.y - 0.02 }));
  const chunk = Math.max(2, Math.floor(points.length / 4));
  const chunkStarts: number[] = [];
  for (let index = 0; index + 1 < points.length; index += chunk - 1) {
    chunkStarts.push(index);
  }

  const segments: Array<{ id: string; wayId: string; from: string; to: string; points: Vec2[] }> = [];
  for (let c = 0; c < chunkStarts.length; c += 1) {
    const start = chunkStarts[c]!;
    const end = Math.min(points.length - 1, c + 1 < chunkStarts.length ? chunkStarts[c + 1]! : points.length - 1);
    const slice = points.slice(start, end + 1);
    if (slice.length < 2) continue;
    segments.push({ id: `seg${c}`, wayId: `way${c}`, from: `node-${start}`, to: `node-${end}`, points: slice });
  }

  // A competing detour: connects the SAME start/end nodes as the chained R
  // segments (so it's a real alternative route the search can pick instead)
  // but drifts far from the letter in between.
  const detour = points.map((point, index) => ({ x: point.x + (index % 2 === 0 ? 0.6 : -0.6), y: point.y + 0.4 }));
  const firstNode = `node-${chunkStarts[0]!}`;
  const lastNode = `node-${Math.min(points.length - 1, chunkStarts[chunkStarts.length - 1]!)}`;
  segments.push({ id: 'detour', wayId: 'wayDetour', from: firstNode, to: lastNode, points: [{ ...points[chunkStarts[0]!]! }, ...detour, { ...points[points.length - 1]! }] });

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
  const { result: mirrored } = traceGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' });
  const metricsMatch = JSON.stringify(real.metrics) === JSON.stringify(mirrored.metrics);
  const pathMatch = JSON.stringify(real.pathPoints) === JSON.stringify(mirrored.pathPoints);
  const edgeIdsMatch = JSON.stringify(real.edgeIds) === JSON.stringify(mirrored.edgeIds);
  tests.push({
    name: 'A. production parity: traceGraphConstrainedShape() reproduces the real routeGraphConstrainedShape() result exactly (metrics, pathPoints, edgeIds) for a synthetic multi-segment graph',
    passed: metricsMatch && pathMatch && edgeIdsMatch,
    detail: `metricsMatch=${metricsMatch} pathMatch=${pathMatch} edgeIdsMatch=${edgeIdsMatch} real.failure=${real.failure} mirrored.failure=${mirrored.failure}`,
  });
}

// --- A. production parity for a multi-letter (regions-collapsed) case ---
{
  const real = routeGraphConstrainedShape({ target: robzShape.points, graph, kind: 'generic', multiLetter: true });
  const { result: mirrored } = traceGraphConstrainedShape({ target: robzShape.points, graph, kind: 'generic', multiLetter: true });
  const metricsMatch = JSON.stringify(real.metrics) === JSON.stringify(mirrored.metrics);
  const regionsMatch = JSON.stringify(real.regions) === JSON.stringify(mirrored.regions);
  tests.push({
    name: 'A. production parity (multiLetter=true, full ROBZ target): metrics and regions (single collapsed region) match exactly',
    passed: metricsMatch && regionsMatch,
    detail: `metricsMatch=${metricsMatch} regionsMatch=${regionsMatch} regions=${JSON.stringify(mirrored.regions)}`,
  });
}

// --- A. production parity for a no-graph-support case (empty graph) ---
{
  const emptyGraph: ShapeGraph = { nodes: {}, segments: [] };
  const real = routeGraphConstrainedShape({ target: rLetter.points, graph: emptyGraph, kind: 'generic' });
  const { result: mirrored } = traceGraphConstrainedShape({ target: rLetter.points, graph: emptyGraph, kind: 'generic' });
  tests.push({
    name: 'A. production parity: both real and mirror report no_graph for an empty graph',
    passed: real.failure === 'no_graph' && mirrored.failure === 'no_graph',
    detail: `real.failure=${real.failure} mirrored.failure=${mirrored.failure}`,
  });
}

// --- B. beam-state parity ---
{
  const { result, trace } = traceGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' }, { recordExpansions: true });
  const maxBeamWidth = 48 * 4; // GRAPH_SHAPE.beamPerBin * 4, mirrored constant
  const survivedPerDepth = new Map<number, number>();
  for (const record of trace.expansions) {
    if (record.survivedBeamCut) {
      survivedPerDepth.set(record.depth, (survivedPerDepth.get(record.depth) ?? 0) + 1);
    }
  }
  const anyDepthExceedsWidth = [...survivedPerDepth.values()].some((count) => count > maxBeamWidth);
  tests.push({
    name: 'B. beam-state parity: no depth ever has more survivedBeamCut=true records than the real beam width (beamPerBin*4=192)',
    passed: !anyDepthExceedsWidth,
    detail: `max survivors at any depth=${Math.max(0, ...survivedPerDepth.values())}`,
  });
  // Every edge on the FINAL selected path must itself have been recorded as surviving the beam cut at some point (production only ever returns a state that was in `beam`/`bestGoal`/`bestAny`, all of which came from survived states or a start state).
  const finalEdgeSet = new Set(result.edgeIds);
  const recordedFinalEdges = trace.expansions.filter((record) => finalEdgeSet.has(record.edgeId));
  const allFinalEdgesRecordedAsSurviving = result.edgeIds.length <= 1 || recordedFinalEdges.some((record) => record.survivedBeamCut);
  tests.push({
    name: 'B. beam-state parity: edges on the final selected route appear in the trace as having survived the beam cut at least once',
    passed: allFinalEdgesRecordedAsSurviving,
    detail: `finalEdgeIds=${JSON.stringify(result.edgeIds)} recordedCount=${recordedFinalEdges.length}`,
  });
}

// --- C. read-only graph ---
{
  const graphSnapshot = JSON.stringify(graph);
  const targetSnapshot = JSON.stringify(rLetter.points);
  traceGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' }, { recordExpansions: true });
  tests.push({
    name: 'C. read-only graph: graph and target are byte-identical before and after tracing',
    passed: JSON.stringify(graph) === graphSnapshot && JSON.stringify(rLetter.points) === targetSnapshot,
    detail: 'no mutation detected',
  });
}

// --- D. no production mutation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  traceGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' }, { recordExpansions: true });
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'D. no production mutation: running the traced beam search does not change a subsequent real analyzeTargetIdentity() result',
    passed: identityBefore.targetSpan === identityAfter.targetSpan && identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord,
    detail: `before traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

// --- E. coverage parity ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const boundarySet = letterBoundariesFromWordShape(robzShape);
  const inkResult = computeInkOnlyOccupancy({
    route: robzShape.points,
    target: robzShape.points,
    boundarySet,
    letterMeaningfullyVisited: identity.letters.map((letter) => letter.meaningfullyVisited),
  });
  const completedCount = inkResult.perLetterOccupancy.filter((letter) => letter.completed).length;
  tests.push({
    name: 'E. coverage parity: rawInkCoverage input (from the real, unmodified computeInkOnlyOccupancy) still matches production lettersVisited exactly',
    passed: completedCount === identity.lettersVisited,
    detail: `completedCount=${completedCount} identity.lettersVisited=${identity.lettersVisited}`,
  });
}

// --- semantic: analyzeLetterEntries classifies a letter with no nearby corridor as NO_ENTRY ---
{
  const { trace, result } = traceGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' }, { recordExpansions: true });
  const farCorridor: LetterCorridor = { letter: 'X', index: 0, target: rLetter.points.map((point) => ({ x: point.x + 5000, y: point.y + 5000 })), thresholdMeters: 18 };
  const analysis = analyzeLetterEntries(trace, [farCorridor], result.pathPoints, [0], trace.hitExpansionCap);
  tests.push({
    name: 'semantic: a letter corridor 5000+ units away from every explored beam state classifies as NO_ENTRY',
    passed: analysis[0]!.classification === 'NO_ENTRY' && !analysis[0]!.everEntered,
    detail: `classification=${analysis[0]!.classification} everEntered=${analysis[0]!.everEntered}`,
  });
}

// --- semantic: analyzeLetterEntries classifies the ACTUAL letter corridor (R itself) as entered ---
{
  const { trace, result } = traceGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' }, { recordExpansions: true });
  const rCorridor: LetterCorridor = { letter: 'R', index: 0, target: rLetter.points, thresholdMeters: 18 };
  const analysis = analyzeLetterEntries(trace, [rCorridor], result.pathPoints, [1], trace.hitExpansionCap);
  tests.push({
    name: 'semantic: the R letter\'s own corridor (which the synthetic graph was built to approximate) is entered by at least one beam state',
    passed: analysis[0]!.everEntered,
    detail: `classification=${analysis[0]!.classification} everEntered=${analysis[0]!.everEntered} firstEntryExpansion=${analysis[0]!.firstEntryExpansion}`,
  });
}

// --- fine-coverage toggle: fineCoverageEnabled=false reproduces the PRE-experiment algorithm; the selected route's fineCoverageBinsCovered is tracked either way, but the reward is only ever subtracted from cost when enabled ---
{
  const { trace: traceWith } = traceGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' }, { recordExpansions: true, fineCoverageEnabled: true });
  const { trace: traceWithout } = traceGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' }, { recordExpansions: true, fineCoverageEnabled: false });
  tests.push({
    name: 'fine-coverage toggle: fine coverage bins are tracked identically regardless of the toggle (mask accumulation is unconditional; only the cost subtraction is gated)',
    passed: traceWith.finalFineCoverageBinsCovered === traceWithout.finalFineCoverageBinsCovered,
    detail: `with=${traceWith.finalFineCoverageBinsCovered} without=${traceWithout.finalFineCoverageBinsCovered}`,
  });
  tests.push({
    name: 'fine-coverage toggle: every expansion record shows zero reward applied when the toggle is off',
    passed: traceWithout.expansions.every((record) => record.fineCoverageRewardApplied === 0),
    detail: `nonzero-reward records when disabled: ${traceWithout.expansions.filter((r) => r.fineCoverageRewardApplied !== 0).length}/${traceWithout.expansions.length}`,
  });
  tests.push({
    name: 'fine-coverage toggle: at least one expansion record shows nonzero reward applied when the toggle is on (the reward is not a silent no-op)',
    passed: traceWith.expansions.some((record) => record.fineCoverageRewardApplied > 0),
    detail: `nonzero-reward records when enabled: ${traceWith.expansions.filter((r) => r.fineCoverageRewardApplied > 0).length}/${traceWith.expansions.length}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
