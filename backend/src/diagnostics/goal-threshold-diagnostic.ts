/**
 * DEVELOPMENT ONLY. Goal-progress-threshold diagnostic — tests whether the
 * graph search's goal condition (coverage >= GRAPH_SHAPE.goalCoverage AND
 * progress >= GRAPH_SHAPE.goalProgress) causes final-letter truncation, or
 * whether the beam simply never carries a viable state farther.
 * Never wired into production; graph-shape.ts is never touched.
 *
 * Reuses, unmodified in behaviour:
 * - routeGraphConstrainedShapeMirror / REAL_ISGOAL (graph-shape-goal-mirror.ts),
 *   with its new read-only SearchObserver hook (no observer => no change).
 * - GRAPH_SHAPE constants (goalCoverage, progressBins, maxRouteFactor,
 *   corridorMeters) and TARGET_IDENTITY.maxForwardJump for viability.
 * - forwardRatio (street-fit.ts) for the backtracking check, with the SAME
 *   0.45 backtracking limit classifyFailure uses ("too_much_backtrack").
 *
 * IMPORTANT (verified from graph-shape.ts beamSearch, lines 551-614): the
 * real search does NOT stop when it first finds a goal. It keeps expanding
 * until the beam is empty or GRAPH_SHAPE.maxExpansions is reached, and then
 * returns the LOWEST-COST goal state it ever goal-checked (bestGoal), or
 * bestAny if none. "Premature goal" can therefore only mean goal SELECTION
 * (a cheap early goal state beats farther states), never early exit. The
 * telemetry below is built around that fact.
 */
import { polylineLength, type Vec2 } from '@/lib/geometry';

import { coverageThresholdMeters } from '../generation/target-identity';
import { scorePolylines } from '../scoring/shape-match';
import type { LetterBoundary } from './multi-letter-trace';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { decomposeTargetSpan } from './target-span-decomposition-diagnostic';
import { decomposeContinuity } from './continuity-decomposition-diagnostic';
import { measureSubStrokeCoverage, zStrokeRanges } from './z-checkpoint-repair-experiment';
import { buildRoutePieces, progressStop } from './z-diagonal-direction-diagnostic';

import { GRAPH_SHAPE } from '../generation/graph-shape';
import { TARGET_IDENTITY } from '../generation/target-identity';
import { forwardRatio } from './street-fit';
import { REAL_ISGOAL, mirrorCoverMask, type Directed, type GoalCheckFn, type SearchObserver, type SearchState } from './graph-shape-goal-mirror';


// ---------------------------------------------------------------------------
// Fixed parameters — declared before any corpus run.
// ---------------------------------------------------------------------------

export const GOAL_THRESHOLDS = [0.88, 0.92, 0.96, 0.99] as const;

export const GOAL_DIAGNOSTIC = {
  /** A continuation is "substantially" farther when its progress exceeds the returned state's by at least this much (≈ 42% of Z's diagonal, ≈ 21% of CAIRO's O). */
  substantialProgress: 0.03,
  /** Backtracking limit: classifyFailure's too_much_backtrack threshold (backtracking > 0.45). */
  maxBacktracking: 0.45,
} as const;

function bitCount(value: number): number {
  let count = 0;
  let bits = value >>> 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

export function stateCoverage(state: SearchState): number {
  return bitCount(state.covered) / GRAPH_SHAPE.progressBins;
}

// ---------------------------------------------------------------------------
// One-variable goal variant.
// ---------------------------------------------------------------------------

/**
 * REAL_ISGOAL with ONLY the progress threshold replaced. Loop / O-kind
 * branches are delegated to REAL_ISGOAL untouched (they never read
 * goalProgress). The coverage condition is the real one, unchanged.
 * makeProgressThresholdGoal(GRAPH_SHAPE.goalProgress) is proven equal to
 * REAL_ISGOAL in the self-test and re-checked on every corpus candidate.
 */
export function makeProgressThresholdGoal(threshold: number): GoalCheckFn {
  return (ctx) => {
    if (ctx.kind === 'O' || ctx.loop) return REAL_ISGOAL(ctx);
    const coverage = bitCount(ctx.state.covered) / ctx.bins;
    if (coverage < GRAPH_SHAPE.goalCoverage) return false;
    return ctx.state.progress >= threshold;
  };
}

// ---------------------------------------------------------------------------
// Prefix replay + viability.
// ---------------------------------------------------------------------------

export type PrefixReplay = { progress: number[]; coverage: number[] };

/** Replays a state's edge sequence exactly as the search built it: progress_i = clamp01(edge.endProgress), covered |= coverMask(start, end). */
export function replayPrefix(state: SearchState, directed: ReadonlyMap<string, Directed>, loop: boolean): PrefixReplay {
  let covered = 0;
  const progress: number[] = [];
  const coverage: number[] = [];
  for (const id of state.edgeIds) {
    const edge = directed.get(id);
    if (!edge) continue;
    covered |= mirrorCoverMask(edge.startProgress, edge.endProgress, loop);
    progress.push(Math.min(1, Math.max(0, edge.endProgress)));
    coverage.push(bitCount(covered) / GRAPH_SHAPE.progressBins);
  }
  return { progress, coverage };
}

export type Viability = {
  viable: boolean;
  connected: boolean;
  routeDistanceValid: boolean;
  proximityValid: boolean;
  noImpossibleJump: boolean;
  backtrackingValid: boolean;
};

/**
 * "Viable continuation" — built only from constraints the search / its
 * failure classifier already use:
 * - connected: every consecutive edge pair shares a node (edge.to === next.from).
 * - routeDistanceValid: state.length <= targetLength * GRAPH_SHAPE.maxRouteFactor
 *   (the search's own pruning rule; re-checked, not assumed).
 * - proximityValid (corridor/target proximity): the state's LAST edge has
 *   meanPerp <= GRAPH_SHAPE.corridorMeters (the corridor width the search
 *   uses for start edges) — the state is currently on/near the target.
 * - noImpossibleJump: no edge starts more than TARGET_IDENTITY.maxForwardJump
 *   (0.12) of target progress beyond the progress reached before it.
 * - backtrackingValid: 1 - forwardRatio(progress sequence) <= 0.45
 *   (classifyFailure's too_much_backtrack limit).
 */
export function assessViability(state: SearchState, directed: ReadonlyMap<string, Directed>, targetLength: number): Viability {
  const edges = state.edgeIds.map((id) => directed.get(id)).filter((e): e is Directed => Boolean(e));
  let connected = edges.length === state.edgeIds.length;
  let noImpossibleJump = true;
  let previousProgress = edges[0]?.startProgress ?? 0;
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]!;
    if (i > 0 && edges[i - 1]!.to !== edge.from) connected = false;
    if (edge.minProgress - previousProgress > TARGET_IDENTITY.maxForwardJump) noImpossibleJump = false;
    previousProgress = Math.min(1, Math.max(0, edge.endProgress));
  }
  const routeDistanceValid = state.length <= targetLength * GRAPH_SHAPE.maxRouteFactor + 1e-6;
  const last = edges[edges.length - 1];
  const proximityValid = last ? last.meanPerp <= GRAPH_SHAPE.corridorMeters : false;
  const sequence = [edges[0]?.startProgress ?? 0, ...edges.map((e) => Math.min(1, Math.max(0, e.endProgress)))];
  const fwd = forwardRatio(sequence) ?? 1;
  const backtrackingValid = 1 - fwd <= GOAL_DIAGNOSTIC.maxBacktracking;
  return { viable: connected && routeDistanceValid && proximityValid && noImpossibleJump && backtrackingValid, connected, routeDistanceValid, proximityValid, noImpossibleJump, backtrackingValid };
}

// ---------------------------------------------------------------------------
// Telemetry collector (a SearchObserver).
// ---------------------------------------------------------------------------

export type BeamSnapshotSummary = {
  layer: number;
  size: number;
  viableCount: number;
  viableNonGoalCount: number;
  maxProgress: number;
  maxViableProgress: number | null;
  maxCoverage: number;
  viableBeyond: number; // viable states with progress > reference + substantialProgress
  viableWithin5: number; // progress >= 0.95
  viableWithin10: number; // >= 0.90
  viableWithin20: number; // >= 0.80
};

export type GoalEventSummary = { layer: number; progress: number; coverage: number; cost: number; lastSatisfied: 'progress' | 'coverage' | 'joint' };

export type SearchTelemetry = {
  threshold: number;
  finishReason: 'beam_exhausted' | 'max_expansions' | 'no_search';
  expansions: number;
  maxExpansions: number;
  maxExpansionsHit: boolean;
  layers: number;
  goalStatesEncountered: number;
  firstGoal: GoalEventSummary | null;
  bestProgressGoal: { layer: number; progress: number; coverage: number; cost: number } | null;
  returned: { isGoal: boolean; progress: number; coverage: number; cost: number; layerFound: number | null } | null;
  /** Beam in which the first goal was goal-checked (the "moment the first goal is found"). */
  atFirstGoal: BeamSnapshotSummary | null;
  /** Beam in which the RETURNED goal was goal-checked (the last bestGoal update). */
  atReturnedGoal: BeamSnapshotSummary | null;
  /** Last non-empty beam the search expanded. */
  finalBeam: BeamSnapshotSummary | null;
  /** Over the WHOLE search: the farthest-progress viable state ever present in a beam. */
  maxViableProgressEver: number | null;
  maxViableProgressEverLayer: number | null;
  maxViableProgressEverState: SearchState | null;
  /** Route geometry of that state, built from the search's OWN directed map (includes its trimmed '#start' edge). */
  maxViableProgressEverPoints: Vec2[] | null;
  viableStatesBeyondReturnedEver: number;
  /** States that reached progress >= threshold but failed ONLY the coverage condition (ever, beam states). */
  blockedByCoverageCount: number;
  blockedByCoverageMaxProgress: number | null;
  /** States with coverage >= goalCoverage but progress < threshold (ever). */
  blockedByProgressCount: number;
  runtimeMs: number;
};

export function createTelemetryObserver(input: { threshold: number; targetLength: number; loop: boolean }): { observer: SearchObserver; finish: (runtimeMs: number) => SearchTelemetry } {
  const { threshold, targetLength, loop } = input;
  let directedRef: ReadonlyMap<string, Directed> = new Map();
  const layers = new Map<number, readonly SearchState[]>();
  const viabilityCache = new WeakMap<SearchState, Viability>();
  const viabilityOf = (s: SearchState) => {
    let v = viabilityCache.get(s);
    if (!v) {
      v = assessViability(s, directedRef, targetLength);
      viabilityCache.set(s, v);
    }
    return v;
  };
  const goalStates = new WeakSet<SearchState>();
  let goalCount = 0;
  let firstGoal: { state: SearchState; layer: number } | null = null;
  let bestProgressGoal: { state: SearchState; layer: number } | null = null;
  let returnedLayer: number | null = null;
  let lastLayer = -1;
  let maxViable: { state: SearchState; layer: number } | null = null;
  const everViable: SearchState[] = [];
  let blockedByCoverageCount = 0;
  let blockedByCoverageMaxProgress: number | null = null;
  let blockedByProgressCount = 0;
  let finishInfo: Parameters<NonNullable<SearchObserver['onFinish']>>[0] | null = null;

  const observer: SearchObserver = {
    onLayer: (beam, _expansions, layer, directed) => {
      directedRef = directed;
      layers.set(layer, beam);
      lastLayer = layer;
      for (const s of beam) {
        const cov = stateCoverage(s);
        if (s.progress >= threshold && cov < GRAPH_SHAPE.goalCoverage) {
          blockedByCoverageCount += 1;
          blockedByCoverageMaxProgress = Math.max(blockedByCoverageMaxProgress ?? 0, s.progress);
        }
        if (cov >= GRAPH_SHAPE.goalCoverage && s.progress < threshold) blockedByProgressCount += 1;
        if (viabilityOf(s).viable) {
          everViable.push(s);
          if (!maxViable || s.progress > maxViable.state.progress || (s.progress === maxViable.state.progress && s.cost < maxViable.state.cost)) maxViable = { state: s, layer };
        }
      }
    },
    onGoal: (state, layer, becameBest) => {
      goalCount += 1;
      goalStates.add(state);
      if (!firstGoal) firstGoal = { state, layer };
      if (!bestProgressGoal || state.progress > bestProgressGoal.state.progress) bestProgressGoal = { state, layer };
      if (becameBest) returnedLayer = layer;
    },
    onFinish: (info) => {
      finishInfo = info;
    },
  };

  const summarize = (layer: number | null, reference: number): BeamSnapshotSummary | null => {
    if (layer === null) return null;
    const beam = layers.get(layer);
    if (!beam) return null;
    const viable = beam.filter((s) => viabilityOf(s).viable);
    return {
      layer,
      size: beam.length,
      viableCount: viable.length,
      viableNonGoalCount: viable.filter((s) => !goalStates.has(s)).length,
      maxProgress: beam.reduce((m, s) => Math.max(m, s.progress), 0),
      maxViableProgress: viable.length ? viable.reduce((m, s) => Math.max(m, s.progress), 0) : null,
      maxCoverage: beam.reduce((m, s) => Math.max(m, stateCoverage(s)), 0),
      viableBeyond: viable.filter((s) => s.progress > reference + GOAL_DIAGNOSTIC.substantialProgress).length,
      viableWithin5: viable.filter((s) => s.progress >= 0.95).length,
      viableWithin10: viable.filter((s) => s.progress >= 0.9).length,
      viableWithin20: viable.filter((s) => s.progress >= 0.8).length,
    };
  };

  const lastSatisfied = (state: SearchState): GoalEventSummary['lastSatisfied'] => {
    const replay = replayPrefix(state, directedRef, loop);
    const n = replay.progress.length;
    let coverageIndex = replay.coverage.findIndex((c) => c >= GRAPH_SHAPE.goalCoverage);
    if (coverageIndex < 0) coverageIndex = n - 1;
    let progressIndex = n - 1;
    while (progressIndex > 0 && replay.progress[progressIndex - 1]! >= threshold) progressIndex -= 1;
    return coverageIndex === progressIndex ? 'joint' : coverageIndex > progressIndex ? 'coverage' : 'progress';
  };

  const finish = (runtimeMs: number): SearchTelemetry => {
    const info = finishInfo;
    const returnedState = info?.best ?? null;
    const returnedIsGoal = Boolean(info?.bestGoal) && returnedState === info?.bestGoal;
    const reference = returnedState?.progress ?? 0;
    const fg = firstGoal as { state: SearchState; layer: number } | null;
    const bpg = bestProgressGoal as { state: SearchState; layer: number } | null;
    const mv = maxViable as { state: SearchState; layer: number } | null;
    return {
      threshold,
      finishReason: info?.reason ?? 'no_search',
      expansions: info?.expansions ?? 0,
      maxExpansions: GRAPH_SHAPE.maxExpansions,
      maxExpansionsHit: info?.reason === 'max_expansions',
      layers: info?.layers ?? 0,
      goalStatesEncountered: goalCount,
      firstGoal: fg ? { layer: fg.layer, progress: fg.state.progress, coverage: stateCoverage(fg.state), cost: fg.state.cost, lastSatisfied: lastSatisfied(fg.state) } : null,
      bestProgressGoal: bpg ? { layer: bpg.layer, progress: bpg.state.progress, coverage: stateCoverage(bpg.state), cost: bpg.state.cost } : null,
      returned: returnedState ? { isGoal: returnedIsGoal, progress: returnedState.progress, coverage: stateCoverage(returnedState), cost: returnedState.cost, layerFound: returnedIsGoal ? returnedLayer : null } : null,
      atFirstGoal: summarize(fg?.layer ?? null, reference),
      atReturnedGoal: summarize(returnedIsGoal ? returnedLayer : null, reference),
      finalBeam: summarize(lastLayer >= 0 ? lastLayer : null, reference),
      maxViableProgressEver: mv?.state.progress ?? null,
      maxViableProgressEverLayer: mv?.layer ?? null,
      maxViableProgressEverState: mv?.state ?? null,
      maxViableProgressEverPoints: mv ? pointsOf(mv.state, directedRef) : null,
      viableStatesBeyondReturnedEver: everViable.filter((s) => s.progress > reference + GOAL_DIAGNOSTIC.substantialProgress).length,
      blockedByCoverageCount,
      blockedByCoverageMaxProgress,
      blockedByProgressCount,
      runtimeMs,
    };
  };
  return { observer, finish };
}

// ---------------------------------------------------------------------------
// Per-candidate case classification (Step 6).
// ---------------------------------------------------------------------------

export type TerminationCase = 'A_farther_viable_existed' | 'B_no_viable_beyond' | 'C_no_goal_found';

export function classifyTermination(t: SearchTelemetry): TerminationCase {
  if (!t.returned || !t.returned.isGoal) return 'C_no_goal_found';
  const farther = (t.maxViableProgressEver ?? 0) > t.returned.progress + GOAL_DIAGNOSTIC.substantialProgress;
  return farther ? 'A_farther_viable_existed' : 'B_no_viable_beyond';
}

export function pointsOf(state: SearchState, directed: ReadonlyMap<string, Directed>): Vec2[] {
  const points: Vec2[] = [];
  for (const id of state.edgeIds) {
    const edge = directed.get(id);
    if (!edge) continue;
    points.push(...(points.length ? edge.points.slice(1) : edge.points).map((p) => ({ ...p })));
  }
  return points;
}

// ---------------------------------------------------------------------------
// Route quality helpers (shared with goal-selection-diagnostic).
// ---------------------------------------------------------------------------

export type RouteQuality = {
  shapeScore: number;
  coverage: number;
  targetCoverage: number;
  order: number;
  targetSpan: number;
  backtracking: number;
  routeTarget: number;
  feasible: boolean;
  failure: string | null;
  wordTraversalPhysical: boolean;
  letters: Array<{ letter: string; rawInk: number; coverage: number; physicallyCovered: boolean }>;
  routeFinalProgress: number | null;
  routeMaxOnTargetProgress: number | null;
  routeLengthMeters: number;
  /** decomposeContinuity(...).continuityValid — the existing continuity check. */
  continuityValid: boolean;
};

export type FinalLetter = {
  letter: string;
  start: number;
  mid: number;
  end: number;
  enters: boolean;
  reachesMid: boolean;
  reachesEnd: boolean;
  rawInk: number;
  coverage: number;
  physicallyCovered: boolean;
  zStrokeInk?: { top: number; diagonal: number; bottom: number };
};

/** Route quality of a route, via the existing scorers (scorePolylines, decomposeTargetSpan, evaluatePhysicalWordTraversal, progressStop). */
export function routeQuality(word: string, target: Vec2[], path: Vec2[], failure: string | null): RouteQuality | null {
  if (path.length < 2) return null;
  const scored = scorePolylines(path, target);
  const span = decomposeTargetSpan(word, target, path, 'smooth');
  const physical = evaluatePhysicalWordTraversal(word, target, path, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
  const stop = progressStop(buildRoutePieces(path, target), target);
  return {
    shapeScore: scored.score,
    coverage: scored.coverage,
    targetCoverage: 0,
    order: scored.breakdown.order,
    targetSpan: span.targetSpan,
    backtracking: scored.details.backtrackRatio,
    routeTarget: span.lengthRatioProjected,
    feasible: failure === null,
    failure,
    wordTraversalPhysical: physical.wordTraversalPhysical,
    letters: physical.letters.map((l) => ({ letter: l.letter, rawInk: l.rawInkCoverage, coverage: l.coverage, physicallyCovered: l.physicallyCovered })),
    routeFinalProgress: stop.finalPieceProgress,
    routeMaxOnTargetProgress: stop.maxOnTargetProgress,
    routeLengthMeters: polylineLength(path),
    continuityValid: decomposeContinuity(word, target, path, 'smooth').continuityValid,
  };
}

/** Final-letter window + reach/ink for a route (Z also gets its per-stroke ink). */
export function finalLetterOf(word: string, target: Vec2[], path: Vec2[], boundary: LetterBoundary, q: RouteQuality | null): FinalLetter | null {
  if (!q || path.length < 2) return null;
  const pieces = buildRoutePieces(path, target);
  const radius = coverageThresholdMeters(target);
  const on = pieces.filter((p) => p.perpendicularDistance <= radius);
  const start = boundary.projectedStartProgress;
  const end = boundary.projectedEndProgress;
  const mid = (start + end) / 2;
  const maxOn = on.length ? Math.max(...on.map((p) => p.progressB)) : -1;
  const letter = q.letters[q.letters.length - 1]!;
  const out: FinalLetter = {
    letter: boundary.letter,
    start,
    mid,
    end,
    enters: on.some((p) => p.progress >= start && p.progress <= end),
    reachesMid: maxOn >= mid,
    reachesEnd: maxOn >= end - 0.01,
    rawInk: letter.rawInk,
    coverage: letter.coverage,
    physicallyCovered: letter.physicallyCovered,
  };
  if (boundary.letter === 'Z') {
    const ink = measureSubStrokeCoverage(path, target, zStrokeRanges(boundary));
    const g = (l: string) => ink.find((s) => s.label === l)?.occupancy ?? 0;
    out.zStrokeInk = { top: g('top'), diagonal: g('diagonal'), bottom: g('bottom') };
  }
  void word;
  return out;
}

