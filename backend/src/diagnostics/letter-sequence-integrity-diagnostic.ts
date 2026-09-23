/**
 * DEVELOPMENT ONLY. Independent letter visitation & sequence integrity
 * diagnostic — observation only, never called from the live route-
 * generation/scoring/gate path.
 *
 * Established (prior tasks): whole-route order/jumpFit cannot reliably
 * perform both "is this a physically good route" AND "were the letters
 * visited in the right order" — Scenario I (skip a whole letter) scores
 * 0.659 and already passes order>=0.6 today; Scenario K (wrong sequence)
 * crosses 0.6 under every tested jumpAllow relaxation. This file builds
 * an INDEPENDENT signal that does not read scoreOrderedPath, jumpFit, or
 * whole-route order at all, and tests whether it can do the sequence job
 * on its own.
 *
 * Step 1 — existing geometry this reuses, unmodified:
 *   - buildWalkableWordShape / letterBoundariesFromWordShape: per-letter
 *     target polylines and their projected progress ranges (already used
 *     throughout this investigation).
 *   - extractWholeRouteProgressSequence (whole-route-order-diagnostic.ts):
 *     the SAME 80-sample whole-route resample + projectPointOnPolyline
 *     used everywhere else, reused here for CHRONOLOGICAL route order —
 *     the one piece of information broad-order (median GLOBAL progress
 *     per letter) deliberately does not use, since median-by-letter is
 *     insensitive to WHEN in the route those points occurred.
 *   - computeInkOnlyOccupancy / TargetIdentity.letters[i].coverage: reused
 *     unchanged for per-letter physical-coverage confidence.
 *
 * The NEW capability this file adds: assigning EVERY route sample (in
 * chronological route order, not grouped by letter) to at most one
 * letter, then run-length-encoding consecutive same-letter samples into
 * VISITATION BLOCKS — this is what makes an R→O→R→B→Z-style revisit
 * sequence observable, which per-letter grouping (used everywhere else
 * in this investigation) structurally cannot see.
 */
import { distance2, projectPointOnPolyline, type Vec2 } from '@/lib/geometry';
import type { LetterShapeVariant } from '@/lib/letter-shapes';

import { coverageThresholdMeters } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape, type LetterBoundary } from './multi-letter-trace';
import { extractWholeRouteProgressSequence } from './whole-route-order-diagnostic';

// ---------------------------------------------------------------------------
// Step 2 — per-sample letter assignment (chronological route order).
// ---------------------------------------------------------------------------

export type SampleAssignment = {
  sampleIndex: number;
  point: Vec2;
  letter: string | null;
  letterIndex: number | null;
  progress: number;
  perpendicularDistance: number | null;
};

/** For each of the 80 whole-route resampled points (in real route order), finds the CLOSEST letter whose window (same distance+progress test used throughout this investigation) contains it — never grouped by letter first, so chronological order is preserved exactly as the route walked it. */
export function assignRouteSamplesToLetters(word: string, target: readonly Vec2[], route: readonly Vec2[], geometryVariant: LetterShapeVariant): { assignments: SampleAssignment[]; boundaries: LetterBoundary[] } {
  const shape = buildWalkableWordShape(word, { letterVariant: geometryVariant });
  const boundaries = letterBoundariesFromWordShape(shape).boundaries;
  const samples = extractWholeRouteProgressSequence(route, target);
  if (!shape.word || boundaries.length === 0 || target.length < 2) {
    return { assignments: samples.map((s) => ({ sampleIndex: s.sampleIndex, point: s.point, letter: null, letterIndex: null, progress: s.progress, perpendicularDistance: null })), boundaries };
  }
  const wordThreshold = coverageThresholdMeters(target);

  const assignments: SampleAssignment[] = samples.map((s) => {
    let best: { letter: string; letterIndex: number; distance: number } | null = null;
    for (let i = 0; i < boundaries.length; i += 1) {
      const b = boundaries[i]!;
      const inRange = s.progress >= b.projectedStartProgress - 0.03 && s.progress <= b.projectedEndProgress + 0.03;
      if (!inRange) continue;
      if (s.perpendicularDistance > wordThreshold * 2) continue;
      if (!best || s.perpendicularDistance < best.distance) {
        best = { letter: b.letter, letterIndex: i, distance: s.perpendicularDistance };
      }
    }
    return { sampleIndex: s.sampleIndex, point: s.point, letter: best?.letter ?? null, letterIndex: best?.letterIndex ?? null, progress: s.progress, perpendicularDistance: best?.distance ?? null };
  });
  return { assignments, boundaries };
}

// ---------------------------------------------------------------------------
// Step 3 — run-length-encode into visitation blocks; derive the observed
// sequence WITH repeats preserved.
// ---------------------------------------------------------------------------

export type VisitationBlock = {
  letter: string;
  letterIndex: number;
  startSampleIndex: number;
  endSampleIndex: number;
  sampleCount: number;
  routeDistanceUnits: number;
};

/** Null (unassigned) samples are skipped, never breaking a run by themselves — only a DIFFERENT letter's samples start a new block. This is deliberate: a route sample briefly falling into a connector gap between two consecutive same-letter samples should not fragment one real visit into two. */
export function deriveVisitationBlocks(assignments: readonly SampleAssignment[]): VisitationBlock[] {
  const blocks: VisitationBlock[] = [];
  let current: VisitationBlock | null = null;
  for (const a of assignments) {
    if (a.letter === null || a.letterIndex === null) continue;
    if (current && current.letter === a.letter) {
      current.endSampleIndex = a.sampleIndex;
      current.sampleCount += 1;
      const previousPoint = assignments.find((x) => x.sampleIndex === current!.endSampleIndex - 1)?.point;
      if (previousPoint) current.routeDistanceUnits += distance2(previousPoint, a.point);
    } else {
      current = { letter: a.letter, letterIndex: a.letterIndex, startSampleIndex: a.sampleIndex, endSampleIndex: a.sampleIndex, sampleCount: 1, routeDistanceUnits: 0 };
      blocks.push(current);
    }
  }
  return blocks;
}

export function deriveObservedSequence(blocks: readonly VisitationBlock[]): string[] {
  return blocks.map((b) => b.letter);
}

// ---------------------------------------------------------------------------
// Step 6 — sequence integrity: skip/reorder detection, revisit tolerance.
// ---------------------------------------------------------------------------

export type SequenceIntegrityResult = {
  observedSequence: string[];
  firstOccurrenceOrder: string[];
  missingLetters: string[];
  /** True if every intended letter's FIRST occurrence in the route appears in the correct relative order — a legitimate local revisit (e.g. R->O->R->B->Z) does not violate this, since R's FIRST occurrence still precedes O's. */
  sequenceValid: boolean;
  reorderedPairs: Array<{ earlier: string; later: string }>;
  hasRevisit: boolean;
  revisitedLetters: string[];
};

export function evaluateSequenceIntegrity(observedSequence: readonly string[], intendedLetters: readonly string[]): SequenceIntegrityResult {
  const firstOccurrenceOrder: string[] = [];
  const firstOccurrenceIndex = new Map<string, number>();
  observedSequence.forEach((letter, index) => {
    if (!firstOccurrenceIndex.has(letter)) {
      firstOccurrenceIndex.set(letter, index);
      firstOccurrenceOrder.push(letter);
    }
  });

  const missingLetters = intendedLetters.filter((l) => !firstOccurrenceIndex.has(l));

  const reorderedPairs: Array<{ earlier: string; later: string }> = [];
  for (let i = 0; i < intendedLetters.length; i += 1) {
    for (let j = i + 1; j < intendedLetters.length; j += 1) {
      const a = intendedLetters[i]!;
      const b = intendedLetters[j]!;
      const idxA = firstOccurrenceIndex.get(a);
      const idxB = firstOccurrenceIndex.get(b);
      if (idxA !== undefined && idxB !== undefined && idxA > idxB) {
        reorderedPairs.push({ earlier: b, later: a });
      }
    }
  }

  const letterCounts = new Map<string, number>();
  for (const letter of observedSequence) letterCounts.set(letter, (letterCounts.get(letter) ?? 0) + 1);
  const revisitedLetters = [...letterCounts.entries()].filter(([, count]) => count > 1).map(([letter]) => letter);

  return {
    observedSequence: [...observedSequence],
    firstOccurrenceOrder,
    missingLetters,
    sequenceValid: missingLetters.length === 0 && reorderedPairs.length === 0,
    reorderedPairs,
    hasRevisit: revisitedLetters.length > 0,
    revisitedLetters,
  };
}

// ---------------------------------------------------------------------------
// Step 5 — visitation confidence (combination signal: coverage + route position).
// ---------------------------------------------------------------------------

export type LetterVisitationConfidence = {
  letter: string;
  letterIndex: number;
  visited: boolean;
  blockCount: number;
  totalSampleCount: number;
  totalRouteDistanceUnits: number;
  firstSampleIndex: number | null;
  lastSampleIndex: number | null;
  medianSampleIndex: number | null;
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** "Visited" = at least one block with a minimum sample count (not a single fleeting sample, which is more likely a street passing nearby than a real visit) — combination Signal E from Step 5. minBlockSampleCount defaults to 2 (out of 80 total whole-route samples), a deliberately low bar since it is combined with the per-letter physical-coverage confidence already computed elsewhere (this function reports raw evidence, not a final threshold decision). */
export function computeVisitationConfidence(boundaries: readonly LetterBoundary[], blocks: readonly VisitationBlock[], minBlockSampleCount = 2): LetterVisitationConfidence[] {
  return boundaries.map((boundary, letterIndex) => {
    const letterBlocks = blocks.filter((b) => b.letterIndex === letterIndex);
    const qualifyingBlocks = letterBlocks.filter((b) => b.sampleCount >= minBlockSampleCount);
    const allSampleIndices = letterBlocks.flatMap((b) => [b.startSampleIndex, b.endSampleIndex]);
    const totalSampleCount = letterBlocks.reduce((s, b) => s + b.sampleCount, 0);
    return {
      letter: boundary.letter,
      letterIndex,
      visited: qualifyingBlocks.length > 0,
      blockCount: letterBlocks.length,
      totalSampleCount,
      totalRouteDistanceUnits: letterBlocks.reduce((s, b) => s + b.routeDistanceUnits, 0),
      firstSampleIndex: allSampleIndices.length ? Math.min(...allSampleIndices) : null,
      lastSampleIndex: allSampleIndices.length ? Math.max(...allSampleIndices) : null,
      medianSampleIndex: allSampleIndices.length ? median(allSampleIndices) : null,
    };
  });
}

export function wordLetters(word: string, geometryVariant: LetterShapeVariant): string[] {
  return buildWalkableWordShape(word, { letterVariant: geometryVariant }).letters.map((l) => l.char);
}
