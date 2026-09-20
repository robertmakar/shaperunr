/**
 * Street-network layer.
 *
 * This file separates:
 *   A. obtaining a runnable street graph
 *   B. pathfinding on that graph
 *
 * PRODUCTION is not implemented here. The only graph builder in this milestone
 * is a DEVELOPMENT-ONLY orthogonal grid. It is not OpenStreetMap, and routes
 * produced from it must not be shown to users as real runs.
 *
 * ---------------------------------------------------------------------------
 * Recommended future architecture (researched September 2026)
 * ---------------------------------------------------------------------------
 *
 * Mobile client
 *   Sends { word, start, targetDistance } to a ShapeRunr backend.
 *   Does not query Overpass, OSRM, ORS, GraphHopper, or Mapbox in a loop.
 *
 * Backend
 *   1. Street network (A)
 *      Source: OpenStreetMap via Geofabrik extracts, not the public Overpass
 *      instance. Egypt extract (`egypt-latest.osm.pbf`) is published by
 *      Geofabrik (~169 MB as of 2026-09-08) and includes Cairo streets,
 *      footways, and paths present in OSM.
 *
 *      Public Overpass (overpass-api.de): community instance. Occasional use
 *      ~10k queries / 1 GB per day; regular apps should assume ~100 queries /
 *      10 MB per day across all users. Commercial use should self-host or pay
 *      (Geofabrik Overpass from EUR 40/month). Do not hammer from phones.
 *
 *   2. Routing (B)
 *      Self-host Valhalla with a pedestrian costing profile on the Egypt
 *      (later planet) extract.
 *
 *      Why Valhalla over the alternatives for ShapeRunr:
 *      - OSM-native; pedestrian costing favors walkways/footpaths, avoids
 *        stairs/alleys slightly; supports via/through points so a letter
 *        polyline can guide the route without inventing streets.
 *      - `/trace_route` map-matching can snap a target shape onto real edges.
 *      - Time-distance matrix, isochrones, and (recently) linear_cost_factors
 *        for biasing edges near the target drawing — useful for custom
 *        optimization later.
 *      - Tiled graph: regional extracts, no per-request vendor quota.
 *
 *      OSRM (foot.lua): very fast via-point routing; weaker pedestrian costing
 *      and map-matching than Valhalla. FOSSGIS demo
 *      (router.project-osrm.org / routing.openstreetmap.de) is fair-use,
 *      ~1 req/s, not for production or substantial commercial use. Self-host
 *      if used.
 *
 *      GraphHopper: foot + hike profiles, self-host or cloud. Cloud free tier
 *      is 500 credits/day and non-commercial; a many-waypoint shape search
 *      would burn credits quickly. Paid: Basic 5,000 credits/day, Standard
 *      15,000/day at 199€/month, Premium 50,000/day at 479€/month. Routing
 *      with 2–10 locations = 1 credit; >10 locations costs locations/10.
 *
 *      OpenRouteService: foot-walking, 50 waypoints, 6,000 km foot max.
 *      Standard free key: 2,000 directions/day, 40/min at api.heigit.org
 *      (api.openrouteservice.org deprecated, shut-off 28 Sep 2026). Not
 *      enough for combinatorial shape search from every client. On-prem ORS
 *      is the unlimited option.
 *
 *      Mapbox Directions walking: up to 25 coordinates, sidewalks/trails.
 *      100k requests/month free, then $2 / 1k (100k–500k). 25 waypoints is
 *      too coarse for letter geometry; custom graph optimization is not
 *      exposed. Fine as a later navigation layer, not as the generator.
 *
 * Production routing lives in `backend/` (Valhalla + OSM pedestrian tiles).
 * This file still only builds a DEVELOPMENT-ONLY orthogonal grid.
 * Do not present mock-grid paths as real runs.
 */

import type { Coordinate } from '@/lib/geo';
import { distanceMeters, localMeters, offsetCoordinate } from '@/lib/shape-projection';

export type StreetNode = {
  id: string;
  coordinate: Coordinate;
};

export type StreetEdge = {
  from: string;
  to: string;
  distanceMeters: number;
  geometry: Coordinate[];
};

export type StreetGraph = {
  source: StreetNetworkSource;
  nodes: Map<string, StreetNode>;
  adjacency: Map<string, StreetEdge[]>;
};

export type StreetNetworkSource =
  | { kind: 'development-mock'; developmentOnly: true }
  | { kind: 'osm-extract' }
  | { kind: 'routing-engine'; engine: 'valhalla' | 'osrm' | 'graphhopper' | 'openrouteservice' };

export type DevelopmentGridOptions = {
  center: Coordinate;
  eastExtentMeters: number;
  northExtentMeters: number;
  spacingMeters?: number;
};

const DEFAULT_SPACING_METERS = 35;

export function createDevelopmentStreetGrid(options: DevelopmentGridOptions): StreetGraph {
  const spacing = options.spacingMeters ?? DEFAULT_SPACING_METERS;
  const colCount = Math.max(2, Math.floor((options.eastExtentMeters * 2) / spacing) + 1);
  const rowCount = Math.max(2, Math.floor((options.northExtentMeters * 2) / spacing) + 1);
  const originEast = -((colCount - 1) * spacing) / 2;
  const originNorth = -((rowCount - 1) * spacing) / 2;

  const nodes = new Map<string, StreetNode>();
  const adjacency = new Map<string, StreetEdge[]>();

  const idFor = (col: number, row: number) => `${col},${row}`;

  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const id = idFor(col, row);
      nodes.set(id, {
        id,
        coordinate: offsetCoordinate(
          options.center,
          originEast + col * spacing,
          originNorth + row * spacing,
        ),
      });
      adjacency.set(id, []);
    }
  }

  const connect = (fromId: string, toId: string) => {
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    const list = adjacency.get(fromId);
    if (!from || !to || !list) {
      return;
    }
    list.push({
      from: fromId,
      to: toId,
      distanceMeters: distanceMeters(from.coordinate, to.coordinate),
      geometry: [from.coordinate, to.coordinate],
    });
  };

  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      if (col + 1 < colCount) {
        connect(idFor(col, row), idFor(col + 1, row));
        connect(idFor(col + 1, row), idFor(col, row));
      }
      if (row + 1 < rowCount) {
        connect(idFor(col, row), idFor(col, row + 1));
        connect(idFor(col, row + 1), idFor(col, row));
      }
    }
  }

  return {
    source: { kind: 'development-mock', developmentOnly: true },
    nodes,
    adjacency,
  };
}

export function nearestNodeId(graph: StreetGraph, coordinate: Coordinate): string | null {
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const origin = coordinate;

  for (const node of graph.nodes.values()) {
    const delta = localMeters(origin, node.coordinate);
    const distance = Math.hypot(delta.x, delta.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = node.id;
    }
  }

  return bestId;
}

export function shortestPathCoordinates(
  graph: StreetGraph,
  fromCoordinate: Coordinate,
  toCoordinate: Coordinate,
): Coordinate[] {
  const fromId = nearestNodeId(graph, fromCoordinate);
  const toId = nearestNodeId(graph, toCoordinate);
  if (!fromId || !toId) {
    return [];
  }
  if (fromId === toId) {
    const node = graph.nodes.get(fromId);
    return node ? [node.coordinate] : [];
  }

  const nodeIds = dijkstra(graph, fromId, toId);
  const coordinates: Coordinate[] = [];
  for (const id of nodeIds) {
    const node = graph.nodes.get(id);
    if (node) {
      coordinates.push(node.coordinate);
    }
  }
  return coordinates;
}

export function routeThroughWaypoints(graph: StreetGraph, waypoints: Coordinate[]): Coordinate[] {
  if (waypoints.length === 0) {
    return [];
  }

  const route: Coordinate[] = [];
  for (let index = 1; index < waypoints.length; index += 1) {
    const start = waypoints[index - 1];
    const end = waypoints[index];
    if (!start || !end) {
      continue;
    }
    const leg = shortestPathCoordinates(graph, start, end);
    if (leg.length === 0) {
      continue;
    }
    if (route.length > 0) {
      route.push(...leg.slice(1));
    } else {
      route.push(...leg);
    }
  }

  return route;
}

function dijkstra(graph: StreetGraph, startId: string, goalId: string): string[] {
  const distance = new Map<string, number>([[startId, 0]]);
  const previous = new Map<string, string>();
  const heap = new MinHeap();
  heap.push(startId, 0);

  while (!heap.isEmpty()) {
    const current = heap.pop();
    if (!current) {
      break;
    }
    if (current.id === goalId) {
      break;
    }
    const best = distance.get(current.id);
    if (best == null || current.priority > best) {
      continue;
    }

    const edges = graph.adjacency.get(current.id) ?? [];
    for (const edge of edges) {
      const nextDistance = current.priority + edge.distanceMeters;
      if (nextDistance < (distance.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distance.set(edge.to, nextDistance);
        previous.set(edge.to, current.id);
        heap.push(edge.to, nextDistance);
      }
    }
  }

  if (!previous.has(goalId) && startId !== goalId) {
    return [];
  }

  const path = [goalId];
  let cursor = goalId;
  while (cursor !== startId) {
    const parent = previous.get(cursor);
    if (!parent) {
      return [];
    }
    path.push(parent);
    cursor = parent;
  }
  path.reverse();
  return path;
}

class MinHeap {
  private items: { id: string; priority: number }[] = [];

  isEmpty() {
    return this.items.length === 0;
  }

  push(id: string, priority: number) {
    this.items.push({ id, priority });
    this.bubbleUp(this.items.length - 1);
  }

  pop(): { id: string; priority: number } | undefined {
    const root = this.items[0];
    const last = this.items.pop();
    if (last && this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return root;
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const currentItem = this.items[index];
      const parentItem = this.items[parent];
      if (!currentItem || !parentItem || parentItem.priority <= currentItem.priority) {
        break;
      }
      this.items[parent] = currentItem;
      this.items[index] = parentItem;
      index = parent;
    }
  }

  private bubbleDown(index: number) {
    const length = this.items.length;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const smallestItem = this.items[smallest];
      const leftItem = this.items[left];
      const rightItem = this.items[right];

      if (left < length && leftItem && smallestItem && leftItem.priority < smallestItem.priority) {
        smallest = left;
      }
      const currentSmallest = this.items[smallest];
      if (right < length && rightItem && currentSmallest && rightItem.priority < currentSmallest.priority) {
        smallest = right;
      }
      if (smallest === index) {
        break;
      }
      const a = this.items[index];
      const b = this.items[smallest];
      if (a && b) {
        this.items[index] = b;
        this.items[smallest] = a;
      }
      index = smallest;
    }
  }
}
