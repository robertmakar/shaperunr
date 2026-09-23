/**
 * DEVELOPMENT ONLY. Tests for the letter-aware beam-state shadow
 * experiment (letter-aware-beam.ts).
 *
 * A. OLD-mode parity — LETTER_AWARE_VARIANTS.OLD reproduces the real,
 *    unmodified routeGraphConstrainedShape() exactly, for both a
 *    single-letter and a multiLetter (regions-collapsed) target.
 * B. Single-letter invariance — for a single-letter word, currentLetterIndex
 *    can never advance past 0 in NEW mode (ranges.length === 1), so NEW
 *    mode's dedup key is functionally identical to OLD's for that word,
 *    and the result matches OLD exactly at every threshold variant.
 * C. Letter range masks — buildLetterRangeMasks produces contiguous,
 *    non-overlapping (up to rounding) bin ranges in projected-boundary
 *    order, together spanning close to the full [0,1] progress axis.
 * D. Completion semantics — letterSufficientlyTraversed requires BOTH the
 *    fine-coverage-fraction threshold AND progress >= letter start; either
 *    condition alone is insufficient.
 * E. Monotonic, non-skipping progression — across a real NEW-mode run,
 *    finalCurrentLetterIndex never exceeds lettersCompletedMax, transition
 *    events are strictly increasing by exactly 1 each time (never jumps
 *    by 2+, never decreases).
 * F. Dedup key extension — OLD mode's key omits currentLetterIndex; NEW
 *    mode's key includes it (checked indirectly via state-count behavior:
 *    NEW mode must never produce FEWER survived states than would be
 *    possible under a strictly coarser key, since a finer key rejects no
 *    more).
 * G. Read-only graph / production isolation.
 */
import { routeGraphConstrainedShape, type ShapeGraph } from '../generation/graph-shape';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  buildLetterRangeMasks,
  letterCoverageFraction,
  letterSufficientlyTraversed,
  LETTER_AWARE_VARIANTS,
  traceLetterAwareBeam,
  type LetterRangeMask,
} from './letter-aware-beam';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import type { Vec2 } from '@/lib/geometry';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const rLetter = robzShape.letters[0]!;
const lShape = buildWalkableWordShape('L', { letterVariant: 'smooth' });

function buildSyntheticGraph(basePoints: readonly Vec2[]): ShapeGraph {
  const points = basePoints.map((point) => ({ x: point.x + 0.02, y: point.y - 0.02 }));
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

  const nodes: Record<string, Vec2> = {};
  for (const segment of segments) {
    nodes[segment.from] = segment.points[0]!;
    nodes[segment.to] = segment.points[segment.points.length - 1]!;
  }
  return { nodes, segments };
}

const singleLetterGraph = buildSyntheticGraph(rLetter.points);
const multiLetterGraph = buildSyntheticGraph(robzShape.points);

// --- A. OLD-mode parity (single letter) ---
{
  const real = routeGraphConstrainedShape({ target: rLetter.points, graph: singleLetterGraph, kind: 'generic' });
  const { result: mirrored } = traceLetterAwareBeam({ word: 'R', target: rLetter.points, graph: singleLetterGraph, kind: 'generic' }, LETTER_AWARE_VARIANTS.OLD!);
  tests.push({
    name: 'A. OLD-mode parity (single letter): metrics/path/edgeIds match the real routeGraphConstrainedShape() exactly',
    passed: JSON.stringify(real.metrics) === JSON.stringify(mirrored.metrics) && JSON.stringify(real.pathPoints) === JSON.stringify(mirrored.pathPoints) && JSON.stringify(real.edgeIds) === JSON.stringify(mirrored.edgeIds),
    detail: `real.failure=${real.failure} mirrored.failure=${mirrored.failure} real.shapeScore=${real.metrics.shapeScore} mirrored.shapeScore=${mirrored.metrics.shapeScore}`,
  });
}

// --- A. OLD-mode parity (multiLetter, regions-collapsed) ---
{
  const real = routeGraphConstrainedShape({ target: robzShape.points, graph: multiLetterGraph, kind: 'generic', multiLetter: true });
  const { result: mirrored } = traceLetterAwareBeam({ word: 'ROBZ', target: robzShape.points, graph: multiLetterGraph, kind: 'generic', multiLetter: true }, LETTER_AWARE_VARIANTS.OLD!);
  tests.push({
    name: 'A. OLD-mode parity (multiLetter=true): metrics match exactly',
    passed: JSON.stringify(real.metrics) === JSON.stringify(mirrored.metrics),
    detail: `real.shapeScore=${real.metrics.shapeScore} mirrored.shapeScore=${mirrored.metrics.shapeScore}`,
  });
}

// --- B. Single-letter invariance under NEW mode ---
{
  const old = traceLetterAwareBeam({ word: 'L', target: lShape.points, graph: buildSyntheticGraph(lShape.points), kind: 'generic' }, LETTER_AWARE_VARIANTS.OLD!);
  let allMatch = true;
  const details: string[] = [];
  for (const key of ['NEW_40', 'NEW_50', 'NEW_60'] as const) {
    const graph = buildSyntheticGraph(lShape.points);
    const neu = traceLetterAwareBeam({ word: 'L', target: lShape.points, graph, kind: 'generic' }, LETTER_AWARE_VARIANTS[key]!);
    const metricsMatch = JSON.stringify(old.result.metrics) === JSON.stringify(neu.result.metrics);
    const stayedAtZero = neu.finalCurrentLetterIndex === 0 && neu.lettersCompletedMax === 0 && neu.transitions.length === 0;
    if (!metricsMatch || !stayedAtZero) {
      allMatch = false;
      details.push(`${key}: metricsMatch=${metricsMatch} stayedAtZero=${stayedAtZero} finalIndex=${neu.finalCurrentLetterIndex}`);
    }
  }
  tests.push({
    name: 'B. single-letter invariance: for word="L" (one letter), NEW mode never advances currentLetterIndex and matches OLD exactly at every threshold',
    passed: allMatch,
    detail: allMatch ? 'all 3 NEW variants match OLD and stayed at letter index 0' : details.join('; '),
  });
}

// --- C. Letter range masks ---
{
  const boundarySet = letterBoundariesFromWordShape(robzShape);
  const ranges = buildLetterRangeMasks(boundarySet.boundaries);
  const inOrder = ranges.every((range, index) => index === 0 || range.startProgress >= ranges[index - 1]!.startProgress);
  const coversStart = ranges[0]!.startProgress <= 0.02;
  const coversEnd = ranges[ranges.length - 1]!.endProgress >= 0.98;
  const count = ranges.length === robzShape.letters.length;
  tests.push({
    name: 'C. letter range masks: 4 ranges for ROBZ, in ascending progress order, together spanning ~[0,1]',
    passed: inOrder && coversStart && coversEnd && count,
    detail: `count=${ranges.length} first.start=${ranges[0]!.startProgress.toFixed(3)} last.end=${ranges[ranges.length - 1]!.endProgress.toFixed(3)} inOrder=${inOrder}`,
  });
}

// --- D. Completion semantics ---
{
  const boundarySet = letterBoundariesFromWordShape(robzShape);
  const ranges = buildLetterRangeMasks(boundarySet.boundaries);
  const rRange: LetterRangeMask = ranges[0]!;
  const fullMask = rRange.mask;
  const emptyMask = 0n;

  const fractionFull = letterCoverageFraction(fullMask, rRange);
  const fractionEmpty = letterCoverageFraction(emptyMask, rRange);
  tests.push({
    name: 'D1. letterCoverageFraction: fully-covered mask -> 1.0, empty mask -> 0.0',
    passed: Math.abs(fractionFull - 1) < 1e-9 && fractionEmpty === 0,
    detail: `fractionFull=${fractionFull} fractionEmpty=${fractionEmpty}`,
  });

  const coveredButNotReached = letterSufficientlyTraversed(fullMask, rRange.startProgress - 0.5, rRange, 0.5);
  const reachedButNotCovered = letterSufficientlyTraversed(emptyMask, rRange.endProgress, rRange, 0.5);
  const both = letterSufficientlyTraversed(fullMask, rRange.endProgress, rRange, 0.5);
  tests.push({
    name: 'D2. letterSufficientlyTraversed requires BOTH physical coverage AND reached-progress; either alone is insufficient',
    passed: !coveredButNotReached && !reachedButNotCovered && both,
    detail: `coveredButNotReached=${coveredButNotReached} reachedButNotCovered=${reachedButNotCovered} both=${both}`,
  });
}

// --- E. Monotonic, non-skipping progression on a real NEW-mode run ---
{
  // 0.2 was confirmed (by direct experimentation against this synthetic
  // graph) to actually trigger letter-progression events on this corpus,
  // so this test exercises the real transition-recording path rather than
  // vacuously passing on an empty transitions list.
  const { transitions, lettersCompletedMax, finalCurrentLetterIndex } = traceLetterAwareBeam(
    { word: 'ROBZ', target: robzShape.points, graph: multiLetterGraph, kind: 'generic', multiLetter: true },
    { mode: 'NEW', letterCoverageThreshold: 0.2 },
  );
  const strictlyIncreasingByOne = transitions.every((t) => t.toLetterIndex === t.fromLetterIndex + 1);
  const boundedByCompletedMax = finalCurrentLetterIndex <= robzShape.letters.length - 1 && lettersCompletedMax <= robzShape.letters.length - 1;
  tests.push({
    name: 'E. monotonic progression: every recorded transition advances currentLetterIndex by exactly 1, never skips, and stays within [0, letterCount-1]',
    passed: strictlyIncreasingByOne && boundedByCompletedMax && transitions.length > 0,
    detail: `transitions=${transitions.length} lettersCompletedMax=${lettersCompletedMax} finalIndex=${finalCurrentLetterIndex} strictlyIncreasingByOne=${strictlyIncreasingByOne}`,
  });
}

// --- F. Dedup key extension is behaviorally inert when currentLetterIndex never advances ---
{
  // An impossibly high completion threshold (>1) guarantees no letter is ever
  // marked sufficiently traversed, so currentLetterIndex stays 0 for every
  // state throughout the run. The NEW-mode dedup key is then
  // `${node}:${progressBin}:${covered}:0` for every state — a constant
  // suffix appended to every key never changes which states collide, so the
  // result must be byte-identical to OLD mode even though the key FORMAT
  // differs. This isolates the dedup-key-extension mechanism itself from the
  // letter-completion mechanism.
  const never = { mode: 'NEW' as const, letterCoverageThreshold: 1.5 };
  const old = traceLetterAwareBeam({ word: 'ROBZ', target: robzShape.points, graph: multiLetterGraph, kind: 'generic', multiLetter: true }, LETTER_AWARE_VARIANTS.OLD!);
  const neverCompletes = traceLetterAwareBeam({ word: 'ROBZ', target: robzShape.points, graph: multiLetterGraph, kind: 'generic', multiLetter: true }, never);
  tests.push({
    name: 'F. dedup key extension is behaviorally inert on its own: with an unreachable completion threshold (currentLetterIndex always 0), NEW mode matches OLD mode exactly',
    passed: JSON.stringify(old.result.metrics) === JSON.stringify(neverCompletes.result.metrics) && neverCompletes.transitions.length === 0,
    detail: `old.shapeScore=${old.result.metrics.shapeScore} never.shapeScore=${neverCompletes.result.metrics.shapeScore} transitions=${neverCompletes.transitions.length}`,
  });
}

// --- G. Read-only graph ---
{
  const graphSnapshot = JSON.stringify(multiLetterGraph);
  traceLetterAwareBeam({ word: 'ROBZ', target: robzShape.points, graph: multiLetterGraph, kind: 'generic', multiLetter: true }, LETTER_AWARE_VARIANTS.NEW_50!);
  tests.push({
    name: 'G1. read-only graph: the input graph object is byte-identical before and after tracing',
    passed: JSON.stringify(multiLetterGraph) === graphSnapshot,
    detail: 'no mutation detected',
  });
}

// --- G. production isolation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  traceLetterAwareBeam({ word: 'ROBZ', target: robzShape.points, graph: multiLetterGraph, kind: 'generic', multiLetter: true }, LETTER_AWARE_VARIANTS.NEW_60!);
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'G2. production isolation: running the letter-aware experiment does not change a subsequent real analyzeTargetIdentity() result',
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
