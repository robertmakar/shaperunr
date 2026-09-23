/**
 * DEVELOPMENT ONLY. Read-only graph-construction audit helpers: connected
 * components of a ShapeGraph, the nearest geometric gap between two
 * components, near-miss endpoints (endpoints that land close to another
 * component's geometry but were not merged into a shared node), and the
 * shortest path between components in a (larger) raw graph. Nothing here
 * changes graph construction; graph-shape.ts is never touched.
 */
import { distanceToPolyline, projectPointOnPolyline, type Vec2 } from '@/lib/geometry';

import type { ShapeGraph, GraphSegment } from '../generation/graph-shape';

export type Components = {
  nodeComponent: Map<string, number>;
  segmentComponent: Map<string, number>;
  sizes: Map<number, { nodes: number; segments: number }>;
};

/** Union-find over segment endpoints (the ONLY way buildShapeGraph connects segments). */
export function connectedComponents(graph: ShapeGraph): Components {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const id of Object.keys(graph.nodes)) parent.set(id, id);
  for (const s of graph.segments) {
    if (!parent.has(s.from)) parent.set(s.from, s.from);
    if (!parent.has(s.to)) parent.set(s.to, s.to);
    const a = find(s.from);
    const b = find(s.to);
    if (a !== b) parent.set(a, b);
  }
  const rootIndex = new Map<string, number>();
  const nodeComponent = new Map<string, number>();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!rootIndex.has(r)) rootIndex.set(r, rootIndex.size);
    nodeComponent.set(id, rootIndex.get(r)!);
  }
  const segmentComponent = new Map<string, number>();
  const sizes = new Map<number, { nodes: number; segments: number }>();
  for (const [, c] of nodeComponent) {
    const s = sizes.get(c) ?? { nodes: 0, segments: 0 };
    s.nodes += 1;
    sizes.set(c, s);
  }
  for (const s of graph.segments) {
    const c = nodeComponent.get(s.from)!;
    segmentComponent.set(s.id, c);
    sizes.get(c)!.segments += 1;
  }
  return { nodeComponent, segmentComponent, sizes };
}

export type Gap = { distance: number; pointA: Vec2; pointB: Vec2; segmentA: string; segmentB: string };

/** Minimum distance between two sets of polylines (vertex-to-polyline in both directions — exact for straight segment pieces up to vertex sampling). */
export function nearestGap(a: readonly GraphSegment[], b: readonly GraphSegment[]): Gap | null {
  let best: Gap | null = null;
  const consider = (from: readonly GraphSegment[], to: readonly GraphSegment[], swap: boolean) => {
    for (const sa of from) {
      for (const p of sa.points) {
        for (const sb of to) {
          const hit = projectPointOnPolyline(p, sb.points);
          if (!best || hit.distance < best.distance) {
            best = swap
              ? { distance: hit.distance, pointA: hit.point, pointB: p, segmentA: sb.id, segmentB: sa.id }
              : { distance: hit.distance, pointA: p, pointB: hit.point, segmentA: sa.id, segmentB: sb.id };
          }
        }
      }
    }
  };
  consider(a, b, false);
  consider(b, a, true);
  return best;
}

export type NearMiss = { endpoint: Vec2; ofSegment: string; toSegment: string; distance: number; toInterior: boolean };

/** Endpoints of `a` lying within `tolerance` of any segment of `b` (never merged, because buildShapeGraph only merges identical snapped endpoint ids). `toInterior` = the closest point is not an endpoint of the other segment (a T-junction). */
export function nearMissEndpoints(a: readonly GraphSegment[], b: readonly GraphSegment[], tolerance: number): NearMiss[] {
  const out: NearMiss[] = [];
  for (const sa of a) {
    for (const endpoint of [sa.points[0]!, sa.points[sa.points.length - 1]!]) {
      for (const sb of b) {
        const hit = projectPointOnPolyline(endpoint, sb.points);
        if (hit.distance > tolerance) continue;
        const e0 = sb.points[0]!;
        const e1 = sb.points[sb.points.length - 1]!;
        const toInterior = Math.min(Math.hypot(hit.point.x - e0.x, hit.point.y - e0.y), Math.hypot(hit.point.x - e1.x, hit.point.y - e1.y)) > 1;
        out.push({ endpoint, ofSegment: sa.id, toSegment: sb.id, distance: hit.distance, toInterior });
      }
    }
  }
  return out.sort((x, y) => x.distance - y.distance);
}

/** Dijkstra (by segment length, undirected) from any node in `from` to any node in `to`. */
export function shortestPathBetween(graph: ShapeGraph, from: ReadonlySet<string>, to: ReadonlySet<string>): { segments: GraphSegment[]; lengthMeters: number } | null {
  const adj = new Map<string, Array<{ seg: GraphSegment; next: string; len: number }>>();
  for (const s of graph.segments) {
    let len = 0;
    for (let i = 1; i < s.points.length; i += 1) len += Math.hypot(s.points[i]!.x - s.points[i - 1]!.x, s.points[i]!.y - s.points[i - 1]!.y);
    (adj.get(s.from) ?? adj.set(s.from, []).get(s.from)!).push({ seg: s, next: s.to, len });
    (adj.get(s.to) ?? adj.set(s.to, []).get(s.to)!).push({ seg: s, next: s.from, len });
  }
  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; seg: GraphSegment }>();
  const done = new Set<string>();
  const queue: Array<{ n: string; d: number }> = [];
  for (const n of from) {
    dist.set(n, 0);
    queue.push({ n, d: 0 });
  }
  while (queue.length) {
    queue.sort((x, y) => x.d - y.d);
    const cur = queue.shift()!;
    if (done.has(cur.n)) continue;
    done.add(cur.n);
    if (to.has(cur.n)) {
      const segments: GraphSegment[] = [];
      let c = cur.n;
      while (prev.has(c)) {
        const p = prev.get(c)!;
        segments.push(p.seg);
        c = p.node;
      }
      return { segments: segments.reverse(), lengthMeters: cur.d };
    }
    for (const e of adj.get(cur.n) ?? []) {
      const nd = cur.d + e.len;
      if (nd < (dist.get(e.next) ?? Infinity)) {
        dist.set(e.next, nd);
        prev.set(e.next, { node: cur.n, seg: e.seg });
        queue.push({ n: e.next, d: nd });
      }
    }
  }
  return null;
}

/** Minimum distance from any vertex of a segment to the target polyline (the quantity filterCorridorSegments compares against GRAPH_SHAPE.corridorMeters). */
export function segmentDistanceToTarget(segment: { points: readonly Vec2[] }, target: readonly Vec2[]): number {
  return Math.min(...segment.points.map((p) => distanceToPolyline(p, target)));
}
