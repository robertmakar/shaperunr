/**
 * DEVELOPMENT ONLY. Graph-constrained shape router entry.
 *
 * Ideal shape → nearby pedestrian graph (Valhalla /locate verbose) →
 * score edges for FOLLOWING the target → beam-search connected paths →
 * evaluate the shape separately from any start connector.
 *
 * Valhalla limitation: `/locate` returns directed edge geometry, way ids,
 * and (sometimes) end-node ids, but not a full adjacency list. Connectivity
 * is reconstructed by snapping polyline endpoints (~8 m). Mid-block streets
 * that merely pass near each other are not joined. This does not invent
 * pedestrian links. It also cannot recover junctions that Valhalla omitted
 * from the locate response.
 *
 * Search itself makes no /route or /trace_route calls.
 */
import type { Coordinate } from '@/lib/geo';
import { polylineLength, resamplePolyline, type Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters, offsetCoordinate } from '@/lib/shape-projection';

import { locatePedestrianEdgeSets } from '../routing/valhalla';
import {
  buildShapeGraph,
  GRAPH_SHAPE,
  GRAPH_SHAPE_EXPERIMENT,
  routeGraphConstrainedShape,
  type GraphSegment,
  type GraphShapeResult,
  type ShapeKind,
} from './graph-shape';

export { GRAPH_SHAPE, GRAPH_SHAPE_EXPERIMENT, routeGraphConstrainedShape } from './graph-shape';

const LOCATE_CHUNK = 16;

export type ShapeGraphCollection = {
  segments: Array<Omit<GraphSegment, 'from' | 'to'>>;
  valhallaCalls: number;
};

export type StartConnector = {
  points: Vec2[];
  lengthMeters: number;
};

export function startConnector(origin: Vec2, pathStart: Vec2 | undefined): StartConnector {
  if (!pathStart) {
    return { points: [], lengthMeters: 0 };
  }
  const lengthMeters = Math.hypot(pathStart.x - origin.x, pathStart.y - origin.y);
  if (lengthMeters < 1) {
    return { points: [], lengthMeters: 0 };
  }
  return {
    points: [origin, pathStart],
    lengthMeters,
  };
}

export async function collectPedestrianShapeGraph(
  origin: Coordinate,
  target: readonly Vec2[],
): Promise<ShapeGraphCollection> {
  const length = polylineLength(target);
  const sampleCount = Math.max(24, Math.round(length / 22));
  const samples = resamplePolyline(target, sampleCount);
  const coordinates = samples.map((point) => offsetCoordinate(origin, point.x, point.y));
  return collectEdgesAtCoordinates(origin, coordinates, GRAPH_SHAPE.corridorMeters);
}

export const NEIGHBORHOOD_COLLECT = {
  radiusMeters: 2400,
  stepMeters: 320,
  locateRadiusMeters: 170,
} as const;

/** Neighborhood pedestrian edges around a point. Locate only; no /route. */
export async function collectNeighborhoodShapeGraph(
  origin: Coordinate,
  options: {
    radiusMeters?: number;
    stepMeters?: number;
    locateRadiusMeters?: number;
  } = {},
): Promise<ShapeGraphCollection> {
  const radius = options.radiusMeters ?? NEIGHBORHOOD_COLLECT.radiusMeters;
  const step = options.stepMeters ?? NEIGHBORHOOD_COLLECT.stepMeters;
  const locateRadius = options.locateRadiusMeters ?? NEIGHBORHOOD_COLLECT.locateRadiusMeters;
  const samples: Coordinate[] = [];
  for (let east = -radius; east <= radius; east += step) {
    for (let north = -radius; north <= radius; north += step) {
      if (Math.hypot(east, north) > radius + 1) {
        continue;
      }
      samples.push(offsetCoordinate(origin, east, north));
    }
  }
  return collectEdgesAtCoordinates(origin, samples, locateRadius);
}

export function routeCollectedGraph(input: {
  target: readonly Vec2[];
  collection: ShapeGraphCollection;
  kind?: ShapeKind;
}): GraphShapeResult {
  return routeGraphConstrainedShape({
    target: input.target,
    kind: input.kind,
    graph: buildShapeGraph(input.collection.segments),
  });
}

export function shapeKindFromWord(word: string): ShapeKind {
  const trimmed = word.trim().toUpperCase();
  if (trimmed === 'O' || trimmed === 'Z' || trimmed === 'L') {
    return trimmed;
  }
  return 'generic';
}

async function collectEdgesAtCoordinates(
  origin: Coordinate,
  coordinates: Coordinate[],
  locateRadiusMeters: number,
): Promise<ShapeGraphCollection> {
  const edgeSets = await locateInChunks(coordinates, locateRadiusMeters);
  const seen = new Set<string>();
  const segments: Array<Omit<GraphSegment, 'from' | 'to'>> = [];

  for (const set of edgeSets) {
    for (const edge of set.edges) {
      const shape = edge.shape && edge.shape.length >= 2 ? edge.shape : null;
      if (!shape) {
        continue;
      }
      const id =
        edge.edgeId ??
        `way:${edge.wayId ?? 'anon'}:${shape[0]?.latitude.toFixed(5)},${shape[0]?.longitude.toFixed(5)}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const points = coordinatesToLocalMeters(origin, shape);
      if (polylineLength(points) < 4) {
        continue;
      }
      segments.push({
        id,
        wayId: edge.wayId != null ? String(edge.wayId) : id,
        points,
      });
    }
  }

  return {
    segments,
    valhallaCalls: Math.ceil(Math.max(coordinates.length, 1) / LOCATE_CHUNK),
  };
}

async function locateInChunks(coordinates: Coordinate[], radius: number) {
  const results: Awaited<ReturnType<typeof locatePedestrianEdgeSets>> = [];
  for (let index = 0; index < coordinates.length; index += LOCATE_CHUNK) {
    const located = await locatePedestrianEdgeSets(coordinates.slice(index, index + LOCATE_CHUNK), radius, {
      verbose: true,
    });
    results.push(...located);
  }
  return results;
}
