/**
 * DEVELOPMENT ONLY. Mechanism B — checkpoint-style positional anchoring, a
 * diagnostic-only shadow state/cost extension for graph-shape-goal-
 * mirror.ts's beam search. Never wired into graph-shape.ts, and does NOT
 * reuse checkpoint-route-generator.ts's implementation — this represents
 * the CONCEPTUAL idea (require reaching a graph node near each letter
 * before advancing past it) directly inside the beam search's own
 * state/cost model, to test whether the mechanism itself (not the whole
 * checkpoint-v1 architecture) is what matters.
 *
 * Step 9's checkpoint definition: tested representative positions are the
 * letter's PLACED-target start, midpoint, and end point (never the
 * abstract word-shape geometry) — configurable per experiment, not
 * hard-coded to one choice.
 *
 * Step 8's snapping: reuses the REAL, already-validated
 * snapCheckpointToGraph() (checkpoint-route-experiment.ts) unchanged —
 * not reimplemented — to find the K nearest graph nodes to each
 * checkpoint's representative point.
 *
 * Mechanism: each letter i gets one bit in a per-state `extraMask`
 * bitmask. An edge whose endpoint (`edge.to`) matches one of letter i's K
 * snapped nodes sets bit i on the resulting child state (via
 * ExtraMaskUpdateFn — see graph-shape-goal-mirror.ts). The cost augmenter
 * then adds a penalty when an edge's progress moves past a PRECEDING
 * letter's window while that letter's bit is still unset in the PARENT
 * state — i.e. "you moved on before anchoring the letter behind you."
 * This is implemented as an additive, finite (not infinite/hard-blocking)
 * penalty, keeping it in the same additive-cost architecture as Mechanism
 * A and avoiding NaN/Infinity propagation through cost comparisons — the
 * task's "require" language is realized as a configurable but always
 * finite, strongly-weighted penalty, documented here rather than silently
 * assumed to be a hard constraint.
 */
import type { Vec2 } from '@/lib/geometry';
import type { LetterBoundary } from './multi-letter-trace';
import type { ShapeGraph } from '../generation/graph-shape';
import { snapCheckpointToGraph, type CheckpointSnap } from './checkpoint-route-experiment';
import type { Directed, EdgeCostAugmenterFn, ExtraMaskUpdateFn, SearchState } from './graph-shape-goal-mirror';
import { resolveActiveLetter, sliceLetterStrokePolyline } from './letter-stroke-proximity-diagnostic';

export type CheckpointMode = 'midpoint' | 'startEnd';

export type LetterCheckpoint = {
  letterIndex: number;
  letter: string;
  position: 'start' | 'mid' | 'end';
  targetCoordinate: Vec2;
  snap: CheckpointSnap;
};

/** Builds K-nearest-node checkpoints for each letter, in the SAME local-meters frame as the corridor graph — reuses snapCheckpointToGraph() unchanged. mode='midpoint' -> 1 checkpoint/letter at its stroke midpoint; mode='startEnd' -> 2 checkpoints/letter (start and end of its stroke). */
export function buildLetterCheckpoints(boundaries: readonly LetterBoundary[], target: readonly Vec2[], graph: ShapeGraph, k: number, mode: CheckpointMode): LetterCheckpoint[] {
  const checkpoints: LetterCheckpoint[] = [];
  boundaries.forEach((boundary, letterIndex) => {
    const stroke = sliceLetterStrokePolyline(target, boundary);
    if (stroke.length < 2) return;
    const positions: Array<{ position: 'start' | 'mid' | 'end'; point: Vec2 }> =
      mode === 'midpoint'
        ? [{ position: 'mid', point: stroke[Math.floor(stroke.length / 2)]! }]
        : [
            { position: 'start', point: stroke[0]! },
            { position: 'end', point: stroke[stroke.length - 1]! },
          ];
    for (const { position, point } of positions) {
      const snap = snapCheckpointToGraph({ index: letterIndex, targetProgress: boundary.projectedStartProgress, targetCoordinate: point, targetLetter: boundary.letter }, graph, k);
      checkpoints.push({ letterIndex, letter: boundary.letter, position, targetCoordinate: point, snap });
    }
  });
  return checkpoints;
}

/**
 * Single-letter variant of buildLetterCheckpoints — builds checkpoint(s)
 * for ONLY the given target letter, preserving its TRUE index in the full
 * word (letterIndex = targetIndex, not 0), so the existing
 * makeCheckpointAnchoringAugmenter's "preceding letter" logic naturally
 * reduces to "penalize passing this one letter without anchoring it" when
 * fed a single-letter checkpoint list alongside the FULL word boundaries.
 * Reuses the exact same stroke-slicing and node-snapping as the
 * multi-letter builder — no new geometry logic.
 */
export function buildSingleLetterCheckpoint(boundaries: readonly LetterBoundary[], targetIndex: number, target: readonly Vec2[], graph: ShapeGraph, k: number, mode: CheckpointMode): LetterCheckpoint[] {
  const boundary = boundaries[targetIndex];
  if (!boundary) return [];
  const stroke = sliceLetterStrokePolyline(target, boundary);
  if (stroke.length < 2) return [];
  const positions: Array<{ position: 'start' | 'mid' | 'end'; point: Vec2 }> =
    mode === 'midpoint'
      ? [{ position: 'mid', point: stroke[Math.floor(stroke.length / 2)]! }]
      : [
          { position: 'start', point: stroke[0]! },
          { position: 'end', point: stroke[stroke.length - 1]! },
        ];
  return positions.map(({ position, point }) => ({
    letterIndex: targetIndex,
    letter: boundary.letter,
    position,
    targetCoordinate: point,
    snap: snapCheckpointToGraph({ index: targetIndex, targetProgress: boundary.projectedStartProgress, targetCoordinate: point, targetLetter: boundary.letter }, graph, k),
  }));
}

/** One bit per DISTINCT checkpoint (so startEnd mode uses 2 bits/letter). Returns the bit index for each checkpoint plus a lookup from node id -> bit indices it satisfies. */
export function indexCheckpointBits(checkpoints: readonly LetterCheckpoint[]): { nodeToBits: Map<string, number[]>; bitToLetterIndex: number[] } {
  const nodeToBits = new Map<string, number[]>();
  const bitToLetterIndex: number[] = [];
  checkpoints.forEach((checkpoint, bit) => {
    bitToLetterIndex.push(checkpoint.letterIndex);
    for (const candidate of checkpoint.snap.candidates) {
      const list = nodeToBits.get(candidate.nodeId) ?? [];
      list.push(bit);
      nodeToBits.set(candidate.nodeId, list);
    }
  });
  return { nodeToBits, bitToLetterIndex };
}

export function makeCheckpointExtraMaskUpdate(nodeToBits: ReadonlyMap<string, number[]>): ExtraMaskUpdateFn {
  return (_parentState: SearchState, edge: Directed) => {
    const bits = nodeToBits.get(edge.to);
    if (!bits || bits.length === 0) return 0;
    let mask = 0;
    for (const bit of bits) mask |= 1 << bit;
    return mask;
  };
}

export type CheckpointAnchoringConfig = { penaltyPerMissedCheckpoint: number };

/** Cost augmenter: penalizes an edge that advances progress past a PRECEDING letter's window while that letter's checkpoint bit(s) are still unset in the parent state. */
export function makeCheckpointAnchoringAugmenter(
  boundaries: readonly LetterBoundary[],
  bitToLetterIndex: readonly number[],
  checkpoints: readonly LetterCheckpoint[],
  config: CheckpointAnchoringConfig,
): EdgeCostAugmenterFn {
  return (edge, currentProgress, parentState) => {
    if (boundaries.length === 0) return 0;
    const activeLetter = resolveActiveLetter(edge.endProgress ?? currentProgress, boundaries);
    if (!activeLetter) return 0;
    const activeIndex = boundaries.indexOf(activeLetter);
    let missed = 0;
    for (let bit = 0; bit < checkpoints.length; bit += 1) {
      const letterIndex = bitToLetterIndex[bit]!;
      if (letterIndex >= activeIndex) continue; // only checkpoints for STRICTLY PRECEDING letters count as "behind"
      const hit = (parentState.extraMask & (1 << bit)) !== 0;
      if (!hit) missed += 1;
    }
    return missed * config.penaltyPerMissedCheckpoint;
  };
}

/** Diagnostic-only: which letters' checkpoints were actually hit by the FINAL route (post-search), for connectivity reporting. */
export function summarizeCheckpointConnectivity(finalExtraMask: number, checkpoints: readonly LetterCheckpoint[]): Array<{ letter: string; position: string; hit: boolean; nearestNodeDistanceMeters: number }> {
  return checkpoints.map((checkpoint, bit) => ({
    letter: checkpoint.letter,
    position: checkpoint.position,
    hit: (finalExtraMask & (1 << bit)) !== 0,
    nearestNodeDistanceMeters: checkpoint.snap.nearestDistanceMeters,
  }));
}
