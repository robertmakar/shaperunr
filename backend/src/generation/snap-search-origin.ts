/**
 * DEVELOPMENT ONLY. Street-lock the experimental search origin.
 *
 * Raw GPS is preserved as the user location. Neighborhood collection,
 * placements, and graph-constrained search use the snapped pedestrian
 * coordinate so nearby GPS samples share one street-locked origin.
 */
import type { Coordinate } from '@/lib/geo';
import { distanceMeters, offsetCoordinate } from '@/lib/shape-projection';

import { locatePedestrianEdgeSets, type LocateEdgeHit } from '../routing/valhalla';

export const SEARCH_ORIGIN_SNAP = {
  radiusMeters: 125,
} as const;

export type SearchOriginSnap = {
  originalLatitude: number;
  originalLongitude: number;
  snappedLatitude: number;
  snappedLongitude: number;
  snapDistanceMeters: number;
  snapped: boolean;
  wayId?: number;
  fallbackReason?: string;
};

export function originalLocation(snap: SearchOriginSnap): Coordinate {
  return { latitude: snap.originalLatitude, longitude: snap.originalLongitude };
}

export function searchOriginFromSnap(snap: SearchOriginSnap): Coordinate {
  return { latitude: snap.snappedLatitude, longitude: snap.snappedLongitude };
}

export function identitySearchOrigin(location: Coordinate, fallbackReason = 'identity'): SearchOriginSnap {
  return {
    originalLatitude: location.latitude,
    originalLongitude: location.longitude,
    snappedLatitude: location.latitude,
    snappedLongitude: location.longitude,
    snapDistanceMeters: 0,
    snapped: false,
    fallbackReason,
  };
}

export function searchOriginFromLocateHit(
  original: Coordinate,
  edge: LocateEdgeHit | null,
  radiusMeters = SEARCH_ORIGIN_SNAP.radiusMeters,
): SearchOriginSnap {
  return searchOriginFromLocateEdges(original, edge ? [edge] : [], radiusMeters);
}

export function searchOriginFromLocateEdges(
  original: Coordinate,
  edges: readonly LocateEdgeHit[],
  radiusMeters = SEARCH_ORIGIN_SNAP.radiusMeters,
): SearchOriginSnap {
  const node = closestPedestrianNode(original, edges, radiusMeters);
  if (node) {
    return {
      originalLatitude: original.latitude,
      originalLongitude: original.longitude,
      snappedLatitude: node.latitude,
      snappedLongitude: node.longitude,
      snapDistanceMeters: node.distanceMeters,
      snapped: true,
      wayId: node.wayId,
    };
  }
  const edge = closestLocateEdge(edges.filter((item) => item.distanceMeters <= radiusMeters));
  if (!edge || !Number.isFinite(edge.distanceMeters) || edge.distanceMeters > radiusMeters) {
    return identitySearchOrigin(original, edges.length === 0 ? 'no_pedestrian_edge' : 'beyond_radius');
  }
  return {
    originalLatitude: original.latitude,
    originalLongitude: original.longitude,
    snappedLatitude: edge.snapped.latitude,
    snappedLongitude: edge.snapped.longitude,
    snapDistanceMeters: distanceMeters(original, edge.snapped),
    snapped: true,
    wayId: edge.wayId,
  };
}

export function closestLocateEdge(edges: readonly LocateEdgeHit[]): LocateEdgeHit | null {
  let best: LocateEdgeHit | null = null;
  for (const edge of edges) {
    if (!best || edge.distanceMeters < best.distanceMeters) {
      best = edge;
    }
  }
  return best;
}

export function placementDistanceFromUser(
  userLocation: Coordinate,
  searchOrigin: Coordinate,
  eastMeters: number,
  northMeters: number,
): number {
  return distanceMeters(userLocation, offsetCoordinate(searchOrigin, eastMeters, northMeters));
}

export function connectorEndpoints(
  userLocation: Coordinate,
  searchOrigin: Coordinate,
  shapeStartLocal: { x: number; y: number } | undefined,
): { from: Coordinate; to: Coordinate | null } {
  if (!shapeStartLocal) {
    return { from: userLocation, to: null };
  }
  return {
    from: userLocation,
    to: offsetCoordinate(searchOrigin, shapeStartLocal.x, shapeStartLocal.y),
  };
}

export async function snapSearchOrigin(location: Coordinate): Promise<SearchOriginSnap> {
  try {
    const [set] = await locatePedestrianEdgeSets([location], SEARCH_ORIGIN_SNAP.radiusMeters, { verbose: true });
    return searchOriginFromLocateEdges(location, set?.edges ?? []);
  } catch {
    return identitySearchOrigin(location, 'locate_failed');
  }
}

function closestPedestrianNode(
  original: Coordinate,
  edges: readonly LocateEdgeHit[],
  radiusMeters: number,
): { latitude: number; longitude: number; distanceMeters: number; wayId?: number } | null {
  let best: { latitude: number; longitude: number; distanceMeters: number; wayId?: number } | null = null;
  for (const edge of edges) {
    if (edge.distanceMeters > radiusMeters) {
      continue;
    }
    const shape = edge.shape ?? [];
    const endpoints =
      shape.length <= 1 ? shape : ([shape[0], shape[shape.length - 1]] as const);
    for (const vertex of endpoints) {
      if (!vertex) {
        continue;
      }
      const distance = distanceMeters(original, vertex);
      if (distance > radiusMeters) {
        continue;
      }
      if (!best || distance < best.distanceMeters) {
        best = {
          latitude: vertex.latitude,
          longitude: vertex.longitude,
          distanceMeters: distance,
          wayId: edge.wayId,
        };
      }
    }
  }
  return best;
}
