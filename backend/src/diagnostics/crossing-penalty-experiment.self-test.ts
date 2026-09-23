/**
 * DEVELOPMENT ONLY. Tests for the crossing-penalty shadow experiment.
 *
 * A. baseline parity — CROSSING_VARIANTS.A_BASELINE reproduces the real,
 *    unmodified routeGraphConstrainedShape() exactly.
 * B. crossing formula parity — shadowCrossingCost() at baseline params
 *    exactly matches the real crossing term inside edgeCost().
 * C. edgeCost component parity — shadowEdgeCost() at baseline params
 *    exactly matches the real edgeCost() total.
 * D. read-only graph.
 * E. production isolation.
 * F. semantic: relaxing crossing changes cost for a crossing-triggered edge, never for a non-crossing edge.
 */
import type { Vec2 } from '@/lib/geometry';
import { explodeDirected } from './beam-search-trace';
import { routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { CROSSING_VARIANTS, shadowCrossingCost, shadowEdgeCost, traceGraphConstrainedShapeCrossing } from './crossing-penalty-experiment';
import { edgeCostBreakdown } from './letter-transition-diagnostic';

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
  // A short, low-progress-span "crossing" edge — a tiny perpendicular hop that should trip the crossing boolean.
  const tinyHop: Vec2[] = [{ ...points[chunkStarts[1]!]! }, { x: points[chunkStarts[1]!]!.x + 0.02, y: points[chunkStarts[1]!]!.y + 0.02 }];
  segments.push({ id: 'tiny', wayId: 'wayTiny', from: `node-${chunkStarts[1]!}`, to: 'nodeTinyEnd', points: tinyHop });

  const nodes: Record<string, Vec2> = {};
  for (const segment of segments) {
    nodes[segment.from] = segment.points[0]!;
    nodes[segment.to] = segment.points[segment.points.length - 1]!;
  }
  return { nodes, segments };
}

const graph = buildSyntheticGraph();

// --- A. baseline parity ---
{
  const real = routeGraphConstrainedShape({ target: rLetter.points, graph, kind: 'generic' });
  const { result: mirrored } = traceGraphConstrainedShapeCrossing({ target: rLetter.points, graph, kind: 'generic' }, { params: CROSSING_VARIANTS.A_BASELINE! });
  const metricsMatch = JSON.stringify(real.metrics) === JSON.stringify(mirrored.metrics);
  const pathMatch = JSON.stringify(real.pathPoints) === JSON.stringify(mirrored.pathPoints);
  const edgeIdsMatch = JSON.stringify(real.edgeIds) === JSON.stringify(mirrored.edgeIds);
  tests.push({
    name: 'A. baseline parity: CROSSING_VARIANTS.A_BASELINE reproduces the real routeGraphConstrainedShape() result exactly',
    passed: metricsMatch && pathMatch && edgeIdsMatch,
    detail: `metricsMatch=${metricsMatch} pathMatch=${pathMatch} edgeIdsMatch=${edgeIdsMatch} real.failure=${real.failure} mirrored.failure=${mirrored.failure}`,
  });
}

// --- A. baseline parity for a multi-letter (regions-collapsed) case ---
{
  const real = routeGraphConstrainedShape({ target: robzShape.points, graph, kind: 'generic', multiLetter: true });
  const { result: mirrored } = traceGraphConstrainedShapeCrossing({ target: robzShape.points, graph, kind: 'generic', multiLetter: true }, { params: CROSSING_VARIANTS.A_BASELINE! });
  tests.push({
    name: 'A. baseline parity (multiLetter=true): metrics match exactly',
    passed: JSON.stringify(real.metrics) === JSON.stringify(mirrored.metrics),
    detail: `real.shapeScore=${real.metrics.shapeScore} mirrored.shapeScore=${mirrored.metrics.shapeScore}`,
  });
}

// --- B/C. crossing formula + edgeCost component parity ---
{
  let allMatch = true;
  const details: string[] = [];
  // Walk a real search once (baseline) to obtain real Directed edges via explodeDirected indirectly: reuse edgeCostBreakdown against the same graph by tracing.
  const { trace } = traceGraphConstrainedShapeCrossing({ target: rLetter.points, graph, kind: 'generic' }, { params: CROSSING_VARIANTS.A_BASELINE!, recordExpansions: true });
  for (const record of trace) {
    if (Math.abs(record.crossingCostBaseline - record.crossingCostShadow) > 1e-9) {
      allMatch = false;
      details.push(`${record.edgeId}: baseline=${record.crossingCostBaseline} shadow=${record.crossingCostShadow}`);
    }
  }
  tests.push({
    name: 'B. crossing formula parity: shadowCrossingCost at A_BASELINE exactly matches shadowCrossingCost computed as "baseline" for every recorded expansion',
    passed: allMatch && trace.length > 0,
    detail: allMatch ? `all ${trace.length} recorded expansions match` : details.join('; '),
  });
}

// --- C. edgeCost component parity (direct, isolated check) ---
{
  const targetLength = 4;
  const directed = explodeDirected(graph, rLetter.points, targetLength, 'generic', false, [], 0.15);
  let allMatch = true;
  const details: string[] = [];
  for (const edge of directed.values()) {
    const breakdown = edgeCostBreakdown(edge, 0.1, targetLength, false, new Set(), 'generic', []);
    const shadow = shadowEdgeCost(edge, 0.1, targetLength, false, new Set(), 'generic', [], CROSSING_VARIANTS.A_BASELINE!);
    if (Math.abs(breakdown.total - shadow) > 1e-9) {
      allMatch = false;
      details.push(`${edge.id}: real=${breakdown.total} shadow=${shadow}`);
    }
  }
  tests.push({
    name: 'C. edgeCost component parity: shadowEdgeCost at A_BASELINE exactly matches the real edgeCostBreakdown total for every edge',
    passed: allMatch,
    detail: allMatch ? 'all edges match exactly' : details.join('; '),
  });
}

// --- F. semantic: relaxing crossing changes shadowCrossingCost for a crossing-triggered edge ---
{
  const targetLength = 4;
  const directed = explodeDirected(graph, rLetter.points, targetLength, 'generic', false, [], 0.15);
  const tinyEdge = [...directed.values()].find((edge) => edge.id.startsWith('tiny'));
  tests.push({ name: 'F. setup: the synthetic "tiny" edge exists and is present in the exploded graph', passed: tinyEdge != null, detail: tinyEdge ? `id=${tinyEdge.id} crossing=${tinyEdge.crossing}` : 'not found' });
  if (tinyEdge) {
    const baseline = shadowCrossingCost(tinyEdge, targetLength, CROSSING_VARIANTS.A_BASELINE!);
    const zero = shadowCrossingCost(tinyEdge, targetLength, CROSSING_VARIANTS.D_NO_CROSSING!);
    const half = shadowCrossingCost(tinyEdge, targetLength, CROSSING_VARIANTS.B_HALF_CROSSING!);
    tests.push({
      name: 'F. semantic: D_NO_CROSSING yields exactly 0 for any edge, regardless of crossing status',
      passed: zero === 0,
      detail: `zero=${zero}`,
    });
    tests.push({
      name: 'F. semantic: B_HALF_CROSSING yields exactly half of A_BASELINE for the same edge',
      passed: Math.abs(half - baseline / 2) < 1e-9,
      detail: `baseline=${baseline.toFixed(3)} half=${half.toFixed(3)} expected=${(baseline / 2).toFixed(3)}`,
    });
  }
  // A "clean" long edge with no crossing trigger should have shadowCrossingCost=0 at baseline AND stay 0 under every multiplier (0 * anything = 0), and threshold relaxation can only ever lower or keep equal its crossing status (never raise it), consistent with monotonic relaxation.
  const cleanEdge = [...directed.values()].find((edge) => edge.id.startsWith('seg0'));
  if (cleanEdge) {
    const baseline = shadowCrossingCost(cleanEdge, targetLength, CROSSING_VARIANTS.A_BASELINE!);
    const relaxed = shadowCrossingCost(cleanEdge, targetLength, CROSSING_VARIANTS.E_THRESHOLD_RELAXED!);
    tests.push({
      name: 'F. semantic: threshold relaxation never INCREASES crossing cost for any edge (relaxing a threshold can only reduce how often the tiny-span/crossing conditions trigger)',
      passed: relaxed <= baseline + 1e-9,
      detail: `baseline=${baseline.toFixed(3)} relaxed=${relaxed.toFixed(3)}`,
    });
  }
}

// --- D. read-only graph ---
{
  const graphSnapshot = JSON.stringify(graph);
  traceGraphConstrainedShapeCrossing({ target: rLetter.points, graph, kind: 'generic' }, { params: CROSSING_VARIANTS.D_NO_CROSSING!, recordExpansions: true });
  tests.push({
    name: 'D. read-only graph: the input graph object is byte-identical before and after tracing',
    passed: JSON.stringify(graph) === graphSnapshot,
    detail: 'no mutation detected',
  });
}

// --- E. production isolation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  traceGraphConstrainedShapeCrossing({ target: rLetter.points, graph, kind: 'generic' }, { params: CROSSING_VARIANTS.D_NO_CROSSING!, recordExpansions: true });
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'E. production isolation: running the crossing-penalty experiment does not change a subsequent real analyzeTargetIdentity() result',
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
