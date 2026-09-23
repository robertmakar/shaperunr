/**
 * DEVELOPMENT ONLY. Beam-survival tracer — records every state the mirror
 * search creates, with a stable diagnostic ID, its parent, and its exact
 * fate (dedupe-rejected / truncated / survived / unexpanded at the cap),
 * using only the read-only SearchObserver hooks of graph-shape-goal-mirror.ts.
 * The search itself, its state representation and its cost are untouched.
 * graph-shape.ts is never touched.
 *
 * Stroke metrics reuse the existing definitions:
 * - Z stroke ink: measureSubStrokeCoverage over zStrokeRanges (the same
 *   top/diagonal/bottom "ink" numbers every prior Z report used, e.g.
 *   ROBZ #1 baseline 1/1/0). A stroke counts as HELD when its ink >=
 *   PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold (0.6).
 * - Cost decomposition: edgeCostBreakdown (letter-transition-diagnostic.ts),
 *   the term-by-term transcription of graph-shape.ts's edgeCost, replayed
 *   along the state's ancestry with each step's real parent progress and
 *   used-edge set; the replayed total is checked against state.cost.
 */
import type { Vec2 } from '@/lib/geometry';

import { GRAPH_SHAPE, type ShapeKind } from '../generation/graph-shape';
import type { Directed, SearchObserver, SearchState } from './graph-shape-goal-mirror';
import { edgeCostBreakdown, type EdgeCostBreakdown } from './letter-transition-diagnostic';
import { measureSubStrokeCoverage } from './z-checkpoint-repair-experiment';
import { PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';
import { forwardRatio, type TargetRegion } from './street-fit';

export const STROKE_HELD = PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold;

export type Fate = 'start' | 'dedupe_rejected' | 'truncated' | 'survived';

export type StateRecord = {
  id: number;
  parentId: number | null;
  /** Layer whose expansion created this state (-1 for start states). It enters beam `createdInLayer + 1` if it survives. */
  createdInLayer: number;
  state: SearchState;
  edgeId: string | null;
  stepCost: number;
  fate: Fate;
  dedupeKey: string | null;
  /** Dedupe: the cost already held for the key, and the record that held it (the state it lost to). */
  dedupePreviousCost: number | null;
  dedupeHolderId: number | null;
  /** Truncation: rank in the sorted next-list, and the cost of the last kept state. */
  truncationRank: number | null;
  truncationCutoffCost: number | null;
  truncationListSize: number | null;
  isGoal: boolean;
  expanded: boolean;
  childrenCreated: number;
  childrenAccepted: number;
  childrenSurvived: number;
  edgesFiltered: { edge_reuse: number; undirected_reuse: number; length_cap: number };
};

export type LayerRecord = {
  layer: number;
  beamSize: number;
  expansionsAtStart: number;
  created: number;
  dedupeRejected: number;
  pushed: number;
  kept: number;
  truncated: number;
};

export type Trace = {
  records: StateRecord[];
  byState: WeakMap<SearchState, StateRecord>;
  layers: LayerRecord[];
  directed: ReadonlyMap<string, Directed>;
  finish: { reason: 'beam_exhausted' | 'max_expansions'; expansions: number; layers: number; best: SearchState | null; bestGoal: SearchState | null } | null;
  /** States in the last beam that the loop never expanded because the expansion cap ended the search. */
  unexpandedAtCap: number[];
};

export function createBeamTracer(): { observer: SearchObserver; trace: Trace } {
  const records: StateRecord[] = [];
  const byState = new WeakMap<SearchState, StateRecord>();
  const layers: LayerRecord[] = [];
  const keyHolder = new Map<string, number>();
  const trace: Trace = { records, byState, layers, directed: new Map(), finish: null, unexpandedAtCap: [] };
  let lastBeam: readonly SearchState[] = [];

  const make = (state: SearchState, parent: StateRecord | null, layer: number, edgeId: string | null, stepCost: number, fate: Fate): StateRecord => {
    const r: StateRecord = {
      id: records.length,
      parentId: parent?.id ?? null,
      createdInLayer: layer,
      state,
      edgeId,
      stepCost,
      fate,
      dedupeKey: null,
      dedupePreviousCost: null,
      dedupeHolderId: null,
      truncationRank: null,
      truncationCutoffCost: null,
      truncationListSize: null,
      isGoal: false,
      expanded: false,
      childrenCreated: 0,
      childrenAccepted: 0,
      childrenSurvived: 0,
      edgesFiltered: { edge_reuse: 0, undirected_reuse: 0, length_cap: 0 },
    };
    records.push(r);
    byState.set(state, r);
    return r;
  };
  const layerRec = (layer: number): LayerRecord => {
    let l = layers[layer];
    if (!l) {
      l = { layer, beamSize: 0, expansionsAtStart: 0, created: 0, dedupeRejected: 0, pushed: 0, kept: 0, truncated: 0 };
      layers[layer] = l;
    }
    return l;
  };

  const observer: SearchObserver = {
    onStarts: (starts) => {
      for (const s of starts) make(s, null, -1, s.edgeIds[0] ?? null, s.cost, 'start');
    },
    onLayer: (beam, expansions, layer, directed) => {
      trace.directed = directed;
      const l = layerRec(layer);
      l.beamSize = beam.length;
      l.expansionsAtStart = expansions;
      for (const s of beam) {
        const r = byState.get(s);
        if (r) r.expanded = true;
      }
      lastBeam = beam;
    },
    onGoal: (state) => {
      const r = byState.get(state);
      if (r) r.isGoal = true;
    },
    onEdgeFiltered: (parent, _edge, reason) => {
      const r = byState.get(parent);
      if (r) r.edgesFiltered[reason] += 1;
    },
    onChild: (child, parent, edge, stepCost, key, previousBestCost, accepted, layer) => {
      const p = byState.get(parent) ?? null;
      const r = make(child, p, layer, edge.id, stepCost, accepted ? 'survived' : 'dedupe_rejected');
      r.dedupeKey = key;
      r.dedupePreviousCost = previousBestCost;
      const l = layerRec(layer);
      l.created += 1;
      if (p) p.childrenCreated += 1;
      if (accepted) {
        l.pushed += 1;
        if (p) p.childrenAccepted += 1;
        keyHolder.set(key, r.id);
      } else {
        l.dedupeRejected += 1;
        r.dedupeHolderId = keyHolder.get(key) ?? null;
      }
    },
    onTruncate: (sorted, kept, layer) => {
      const l = layerRec(layer);
      l.kept = kept;
      l.truncated = sorted.length - kept;
      const cutoff = kept > 0 ? sorted[kept - 1]!.cost : null;
      sorted.forEach((s, i) => {
        const r = byState.get(s);
        if (!r) return;
        r.truncationRank = i;
        r.truncationCutoffCost = cutoff;
        r.truncationListSize = sorted.length;
        if (i >= kept) r.fate = 'truncated';
        else {
          const p = r.parentId !== null ? records[r.parentId] : null;
          if (p) p.childrenSurvived += 1;
        }
      });
    },
    onFinish: (info) => {
      trace.finish = { reason: info.reason, expansions: info.expansions, layers: info.layers, best: info.best, bestGoal: info.bestGoal };
      // The loop exits BEFORE expanding the beam it just built when the cap is reached.
      if (info.reason === 'max_expansions') {
        const lastExpanded = new Set(lastBeam);
        for (const r of records) if ((r.fate === 'survived' || r.fate === 'start') && !r.expanded && !lastExpanded.has(r.state)) trace.unexpandedAtCap.push(r.id);
      }
    },
  };
  return { observer, trace };
}

// ---------------------------------------------------------------------------
// Per-state derived metrics (lazy, cached by record id).
// ---------------------------------------------------------------------------

export type StrokeInk = { top: number; diagonal: number; bottom: number };
export type StateMetrics = {
  path: Vec2[];
  ink: StrokeInk;
  top: boolean;
  diag: boolean;
  bottom: boolean;
  topDiag: boolean;
  all3: boolean;
  searchCoverage: number;
  meanPerp: number;
  headingFit: number;
  backtracking: number;
};

export function pathOf(state: SearchState, directed: ReadonlyMap<string, Directed>): Vec2[] {
  const points: Vec2[] = [];
  for (const id of state.edgeIds) {
    const e = directed.get(id);
    if (!e) continue;
    points.push(...(points.length ? e.points.slice(1) : e.points).map((p) => ({ ...p })));
  }
  return points;
}

function bitCount(value: number): number {
  let c = 0;
  let b = value >>> 0;
  while (b) {
    c += b & 1;
    b >>>= 1;
  }
  return c;
}

export function createMetricCache(trace: Trace, target: readonly Vec2[], ranges: Array<{ label: string; start: number; end: number }>) {
  const cache = new Map<number, StateMetrics>();
  return (r: StateRecord): StateMetrics => {
    const hit = cache.get(r.id);
    if (hit) return hit;
    const path = pathOf(r.state, trace.directed);
    const inks = path.length >= 2 ? measureSubStrokeCoverage(path, target, ranges) : [];
    const g = (l: string) => inks.find((s) => s.label === l)?.occupancy ?? 0;
    const ink = { top: g('top'), diagonal: g('diagonal'), bottom: g('bottom') };
    const edges = r.state.edgeIds.map((id) => trace.directed.get(id)).filter((e): e is Directed => Boolean(e));
    const len = edges.reduce((s, e) => s + e.length, 0) || 1;
    const seq = [edges[0]?.startProgress ?? 0, ...edges.map((e) => Math.min(1, Math.max(0, e.endProgress)))];
    const m: StateMetrics = {
      path,
      ink,
      top: ink.top >= STROKE_HELD,
      diag: ink.diagonal >= STROKE_HELD,
      bottom: ink.bottom >= STROKE_HELD,
      topDiag: ink.top >= STROKE_HELD && ink.diagonal >= STROKE_HELD,
      all3: ink.top >= STROKE_HELD && ink.diagonal >= STROKE_HELD && ink.bottom >= STROKE_HELD,
      searchCoverage: bitCount(r.state.covered) / GRAPH_SHAPE.progressBins,
      meanPerp: edges.reduce((s, e) => s + e.meanPerp * e.length, 0) / len,
      headingFit: edges.reduce((s, e) => s + e.headingFit * e.length, 0) / len,
      backtracking: 1 - (forwardRatio(seq) ?? 1),
    };
    cache.set(r.id, m);
    return m;
  };
}

// ---------------------------------------------------------------------------
// Ancestry + exact cost decomposition.
// ---------------------------------------------------------------------------

export function ancestry(trace: Trace, r: StateRecord): StateRecord[] {
  const chain: StateRecord[] = [];
  let cur: StateRecord | undefined = r;
  while (cur) {
    chain.push(cur);
    cur = cur.parentId !== null ? trace.records[cur.parentId] : undefined;
  }
  return chain.reverse();
}

export type CostDecomposition = { terms: Omit<EdgeCostBreakdown, 'total'>; total: number; stateCost: number; matches: boolean };

/**
 * Replays edgeCostBreakdown along the ancestry exactly as the search charged
 * it: the start edge at progress 0 with an empty used-set (startStates), then
 * each child edge with its PARENT's progress and PARENT's used-undirected set.
 * `matches` confirms the sum equals the search's own state.cost.
 */
export function decomposeCost(trace: Trace, r: StateRecord, targetLength: number, loop: boolean, kind: ShapeKind, regions: readonly TargetRegion[]): CostDecomposition {
  const chain = ancestry(trace, r);
  const terms = { base: 0, perp: 0, heading: 0, backward: 0, skip: 0, detour: 0, crossing: 0, interior: 0, repeat: 0, reverseWalk: 0, regionSkip: 0, followBonus: 0, overlapBonus: 0 };
  let total = 0;
  for (let i = 0; i < chain.length; i += 1) {
    const rec = chain[i]!;
    const edge = trace.directed.get(rec.edgeId ?? '') as Directed | undefined;
    if (!edge) continue;
    const parent = i > 0 ? chain[i - 1]!.state : null;
    const b = edgeCostBreakdown(edge as never, parent ? parent.progress : 0, targetLength, loop, parent ? parent.usedUndirected : new Set(), kind, regions);
    total += b.total;
    for (const k of Object.keys(terms) as Array<keyof typeof terms>) terms[k] += b[k];
  }
  return { terms, total, stateCost: r.state.cost, matches: Math.abs(total - r.state.cost) < 1e-6 };
}

/** Exact scaled "coverage-reward" term for the cost counterfactual: (k-1) x (followBonus + overlapBonus) of the edge, i.e. those two terms scaled by k. */
export function coverageRewardDelta(edge: Directed, factor: number): number {
  const followBonus = -Math.min(edge.followMeters, 80) * 0.12;
  const overlapBonus = -Math.min(edge.overlapMeters, 120) * 0.08;
  return (factor - 1) * (followBonus + overlapBonus);
}
