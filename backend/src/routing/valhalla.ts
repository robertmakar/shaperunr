/**
 * Valhalla HTTP client.
 *
 * Why these endpoints (Valhalla docs, September 2026):
 *
 * /locate + costing=pedestrian
 *   Correlates a lat/lng to the nearest pedestrian-accessible edge.
 *   Returns correlated_lat/lon and way_id. The letter drawing's raw
 *   coordinates are NOT assumed runnable.
 *
 * /trace_route + shape_match=map_snap
 *   Treats the snapped samples as a GPS-like trace and returns the path
 *   on the OSM graph that best explains that trace. This is the primary
 *   generator: it follows the letter corridor along real edges instead of
 *   shortest-path between a handful of via points (which would cut bowls).
 *
 * /route + through locations
 *   Fallback only when map matching cannot connect the trace (pen-up jumps
 *   between letters). Still Valhalla pedestrian geometry — never interpolated.
 *
 * /status
 *   Liveness check for the local container.
 *
 * Valhalla itself is not implemented here. It must run as a separate service.
 */

import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import type { Coordinate } from '@/lib/geo';
import { distanceMeters } from '@/lib/shape-projection';

import { config, localOsmFiles } from '../config';
import type { RouteFailure, RouteFailureCode } from '../types';

const PEDESTRIAN_COSTING = {
  costing: 'pedestrian',
  costing_options: {
    pedestrian: {
      walkway_factor: 0.85,
      sidewalk_factor: 0.9,
      alley_factor: 2,
      driveway_factor: 5,
      use_ferry: 0,
    },
  },
} as const;

export type ValhallaLatLng = {
  lat: number;
  lon: number;
  type?: 'break' | 'through' | 'via' | 'break_through';
  radius?: number;
};

export type SnappedPoint = {
  input: Coordinate;
  snapped: Coordinate;
  wayId?: number;
  distanceMeters: number;
};

export type ValhallaPath = {
  coordinates: Coordinate[];
  distanceMeters: number;
  method: 'trace_route' | 'route_through' | 'route_breaks';
};

export type LocateEdgeHit = {
  snapped: Coordinate;
  wayId?: number;
  distanceMeters: number;
  headingDegrees?: number;
  shape?: Coordinate[];
  edgeId?: string;
  endNodeId?: string;
};

export type LocateEdgeSet = {
  input: Coordinate;
  edges: LocateEdgeHit[];
};

export class ValhallaRequestError extends Error {
  readonly code: RouteFailureCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: RouteFailureCode, message: string, status = 502, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ValhallaRequestError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toFailure(candidateId?: string): RouteFailure {
    return {
      code: this.code,
      message: this.message,
      candidateId,
      details: this.details,
    };
  }
}

export async function checkValhallaStatus(): Promise<{ ok: true; version?: string } | { ok: false; error: RouteFailure }> {
  const diagnostic = await diagnoseValhalla();
  if (!diagnostic.ready) {
    return {
      ok: false,
      error: {
        code: diagnostic.errorCode ?? 'VALHALLA_UNAVAILABLE',
        message: diagnostic.message,
      },
    };
  }
  return { ok: true, version: diagnostic.version };
}

export type ValhallaDiagnostic = {
  reachable: boolean;
  tileDataAvailable: boolean;
  pedestrianRoutingAvailable: boolean;
  cairoCovered: boolean;
  ready: boolean;
  version?: string;
  tilesetLastModified?: number;
  cairoSnapDistanceMeters?: number;
  cairoWayId?: number;
  message: string;
  errorCode?: RouteFailureCode;
  localFiles: ReturnType<typeof localOsmFiles>;
};

/**
 * Distinguishes "port is open" from "Egypt pedestrian tiles can snap Cairo".
 * Used by GET /health. Does not generate letter routes.
 */
export async function diagnoseValhalla(): Promise<ValhallaDiagnostic> {
  const localFiles = localOsmFiles();
  const base = {
    reachable: false,
    tileDataAvailable: false,
    pedestrianRoutingAvailable: false,
    cairoCovered: false,
    ready: false,
    localFiles,
  };

  let statusPayload: Record<string, unknown>;
  try {
    statusPayload = await valhallaRequest<Record<string, unknown>>('/status', { method: 'GET' }, 8000);
  } catch (error) {
    const failure = toFailure(error);
    return {
      ...base,
      message: localFiles.osmPbfPresent
        ? `${failure.message} If this is the first start, tiles may still be building — watch docker compose logs.`
        : `${failure.message} Egypt PBF is also missing at ${localFiles.osmPbfPath}.`,
      errorCode: failure.code,
    };
  }

  const version = typeof statusPayload.version === 'string' ? statusPayload.version : undefined;
  const tilesetLastModified =
    typeof statusPayload.tileset_last_modified === 'number'
      ? statusPayload.tileset_last_modified
      : undefined;
  const tileDataAvailable =
    (tilesetLastModified != null && tilesetLastModified > 0) || localFiles.valhallaTilesPresent;

  try {
    const [cairoSnap] = await locatePedestrianPoints([DEVELOPMENT_FALLBACK_LOCATION], 250);
    const pedestrianRoutingAvailable = true;
    const cairoCovered = Boolean(
      cairoSnap && Number.isFinite(cairoSnap.distanceMeters) && cairoSnap.distanceMeters <= 250,
    );
    const ready = pedestrianRoutingAvailable && cairoCovered;

    let message: string;
    if (ready) {
      message = 'Valhalla available — Egypt pedestrian graph snapped downtown Cairo.';
    } else if (!cairoCovered) {
      message =
        'Valhalla is reachable and accepted pedestrian costing, but did not snap 30.0444, 31.2357 to a nearby edge. Tiles may still be building, or this is not the Egypt extract.';
    } else {
      message = 'Valhalla is reachable but pedestrian routing is not ready.';
    }

    return {
      ...base,
      reachable: true,
      tileDataAvailable: tileDataAvailable || cairoCovered,
      pedestrianRoutingAvailable,
      cairoCovered,
      ready,
      version,
      tilesetLastModified,
      cairoSnapDistanceMeters: cairoSnap?.distanceMeters,
      cairoWayId: cairoSnap?.wayId,
      message,
      errorCode: ready ? undefined : 'NO_PEDESTRIAN_NETWORK',
    };
  } catch (error) {
    const failure = toFailure(error);
    return {
      ...base,
      reachable: true,
      tileDataAvailable,
      version,
      tilesetLastModified,
      message: `Valhalla /status succeeded, but pedestrian /locate at Cairo failed. ${failure.message}`,
      errorCode: failure.code,
    };
  }
}

export async function locatePedestrianPoints(
  points: Coordinate[],
  searchRadiusMeters: number,
): Promise<SnappedPoint[]> {
  if (points.length === 0) {
    return [];
  }

  const payload = await valhallaRequest<unknown>('/locate', {
    method: 'POST',
    body: {
      verbose: false,
      locations: points.map((point) => ({
        lat: point.latitude,
        lon: point.longitude,
        radius: searchRadiusMeters,
      })),
      ...PEDESTRIAN_COSTING,
    },
  });

  const rows = Array.isArray(payload) ? payload : [];
  return points.map((input, index) => {
    const edge = pickClosestEdge(parseLocateEdges(rows[index], input), input);
    if (!edge) {
      return {
        input,
        snapped: input,
        distanceMeters: Number.POSITIVE_INFINITY,
      };
    }
    return {
      input,
      snapped: edge.snapped,
      wayId: edge.wayId,
      distanceMeters: edge.distanceMeters,
    };
  });
}

export async function locatePedestrianEdgeSets(
  points: Coordinate[],
  searchRadiusMeters: number,
  options: { verbose?: boolean } = {},
): Promise<LocateEdgeSet[]> {
  if (points.length === 0) {
    return [];
  }

  const payload = await valhallaRequest<unknown>('/locate', {
    method: 'POST',
    body: {
      verbose: options.verbose ?? false,
      locations: points.map((point) => ({
        lat: point.latitude,
        lon: point.longitude,
        radius: searchRadiusMeters,
      })),
      ...PEDESTRIAN_COSTING,
    },
  });

  const rows = Array.isArray(payload) ? payload : [];
  return points.map((input, index) => ({
    input,
    edges: parseLocateEdges(rows[index], input).filter(
      (edge) => edge.distanceMeters <= searchRadiusMeters,
    ),
  }));
}

export async function tracePedestrianShape(shape: Coordinate[]): Promise<ValhallaPath> {
  if (shape.length < 2) {
    throw new ValhallaRequestError('NO_ROUTE', 'Need at least two snapped points to map-match.');
  }

  const payload = await valhallaRequest<ValhallaTripResponse>('/trace_route', {
    method: 'POST',
    body: {
      shape: shape.map((point) => ({ lat: point.latitude, lon: point.longitude })),
      shape_match: 'map_snap',
      ...PEDESTRIAN_COSTING,
      directions_options: { units: 'kilometers' },
      trace_options: {
        search_radius: 50,
        gps_accuracy: 25,
        breakage_distance: 5000,
        interpolation_distance: 15,
        turn_penalty_factor: 400,
      },
    },
  });

  return pathFromTrip(payload, 'trace_route');
}

export async function routeThroughPedestrianPoints(points: Coordinate[]): Promise<ValhallaPath> {
  if (points.length < 2) {
    throw new ValhallaRequestError('NO_ROUTE', 'Need at least two locations to route.');
  }

  const locations: ValhallaLatLng[] = points.map((point, index) => ({
    lat: point.latitude,
    lon: point.longitude,
    type: index === 0 || index === points.length - 1 ? 'break' : 'through',
    radius: 50,
  }));

  const payload = await valhallaRequest<ValhallaTripResponse>('/route', {
    method: 'POST',
    body: {
      locations,
      ...PEDESTRIAN_COSTING,
      directions_options: { units: 'kilometers' },
    },
  });

  return pathFromTrip(payload, 'route_through');
}

export async function routeViaBreakLocations(points: Coordinate[]): Promise<ValhallaPath> {
  if (points.length < 2) {
    throw new ValhallaRequestError('NO_ROUTE', 'Need at least two break locations to route.');
  }

  const locations: ValhallaLatLng[] = points.map((point) => ({
    lat: point.latitude,
    lon: point.longitude,
    type: 'break',
    radius: 35,
  }));

  const payload = await valhallaRequest<ValhallaTripResponse>('/route', {
    method: 'POST',
    body: {
      locations,
      ...PEDESTRIAN_COSTING,
      directions_options: { units: 'kilometers' },
    },
  });

  return pathFromTrip(payload, 'route_breaks');
}

export async function routePedestrianLeg(from: Coordinate, to: Coordinate): Promise<ValhallaPath> {
  return routeViaBreakLocations([from, to]);
}

type LocateEdge = {
  way_id?: number;
  correlated_lat: number;
  correlated_lon: number;
  heading?: number;
  distance?: number;
  edge_info?: {
    way_id?: number;
    shape?: string;
  };
  edge?: {
    access?: { pedestrian?: boolean };
    end_node?: { value?: number };
  };
  edge_id?: { value?: number };
};

type ValhallaTripResponse = {
  trip?: {
    legs?: Array<{ shape?: string; summary?: { length?: number } }>;
    summary?: { length?: number };
  };
  error?: string;
  error_code?: number;
};

function parseLocateEdges(row: unknown, input: Coordinate): LocateEdgeHit[] {
  if (!row || typeof row !== 'object') {
    return [];
  }
  const edges = (row as { edges?: LocateEdge[] }).edges;
  if (!Array.isArray(edges) || edges.length === 0) {
    return [];
  }

  const hits: LocateEdgeHit[] = [];
  for (const edge of edges) {
    if (
      typeof edge.correlated_lat !== 'number' ||
      typeof edge.correlated_lon !== 'number' ||
      !Number.isFinite(edge.correlated_lat) ||
      !Number.isFinite(edge.correlated_lon)
    ) {
      continue;
    }
    if (edge.edge?.access && edge.edge.access.pedestrian === false) {
      continue;
    }
    const snapped = {
      latitude: edge.correlated_lat,
      longitude: edge.correlated_lon,
    };
    const wayId = typeof edge.way_id === 'number' ? edge.way_id : edge.edge_info?.way_id;
    const headingDegrees = typeof edge.heading === 'number' ? edge.heading : undefined;
    const shape =
      typeof edge.edge_info?.shape === 'string' && edge.edge_info.shape.length > 0
        ? decodePolyline6(edge.edge_info.shape)
        : undefined;
    hits.push({
      snapped,
      wayId: typeof wayId === 'number' ? wayId : undefined,
      distanceMeters:
        typeof edge.distance === 'number' && Number.isFinite(edge.distance)
          ? edge.distance
          : distanceMeters(input, snapped),
      headingDegrees,
      shape,
      edgeId: edge.edge_id?.value != null ? String(edge.edge_id.value) : undefined,
      endNodeId: edge.edge?.end_node?.value != null ? String(edge.edge.end_node.value) : undefined,
    });
  }
  return hits;
}

function pickClosestEdge(edges: LocateEdgeHit[], _input: Coordinate): LocateEdgeHit | null {
  let best: LocateEdgeHit | null = null;
  for (const edge of edges) {
    if (!best || edge.distanceMeters < best.distanceMeters) {
      best = edge;
    }
  }
  return best;
}

function pathFromTrip(
  payload: ValhallaTripResponse,
  method: ValhallaPath['method'],
): ValhallaPath {
  const legs = payload.trip?.legs ?? [];
  const coordinates: Coordinate[] = [];

  for (const leg of legs) {
    if (!leg.shape) {
      continue;
    }
    const decoded = decodePolyline6(leg.shape);
    if (coordinates.length > 0) {
      coordinates.push(...decoded.slice(1));
    } else {
      coordinates.push(...decoded);
    }
  }

  if (coordinates.length < 2) {
    throw new ValhallaRequestError(
      'MALFORMED_RESPONSE',
      'Valhalla returned a trip without decodable pedestrian geometry.',
      502,
      { method },
    );
  }

  return {
    coordinates,
    distanceMeters: polylineLengthFromCoordinates(coordinates),
    method,
  };
}

export function decodePolyline6(encoded: string): Coordinate[] {
  const coordinates: Coordinate[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 1e6;

  const nextDelta = () => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      if (index >= encoded.length) {
        throw new ValhallaRequestError('MALFORMED_RESPONSE', 'Truncated Valhalla polyline6 geometry.');
      }
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += nextDelta();
    lng += nextDelta();
    coordinates.push({
      latitude: lat / factor,
      longitude: lng / factor,
    });
  }

  return coordinates;
}

function polylineLengthFromCoordinates(coordinates: Coordinate[]): number {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (previous && current) {
      length += distanceMeters(previous, current);
    }
  }
  return length;
}

async function valhallaRequest<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: Record<string, unknown> } = {},
  timeoutMs = config.valhallaTimeoutMs,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = options.method ?? 'POST';

  try {
    const response = await fetch(`${config.valhallaUrl}${path}`, {
      method,
      headers:
        method === 'POST'
          ? { 'content-type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
      body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new ValhallaRequestError(
          'MALFORMED_RESPONSE',
          `Valhalla ${path} returned non-JSON.`,
          response.status,
        );
      }
    }

    if (!response.ok) {
      throw mapValhallaHttpError(path, response.status, payload);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ValhallaRequestError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ValhallaRequestError(
        'VALHALLA_TIMEOUT',
        `Valhalla ${path} timed out after ${timeoutMs} ms.`,
        504,
      );
    }
    throw new ValhallaRequestError(
      'VALHALLA_UNAVAILABLE',
      `Cannot reach Valhalla at ${config.valhallaUrl}. ${error instanceof Error ? error.message : 'Unknown error'}`,
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

function mapValhallaHttpError(path: string, status: number, payload: unknown): ValhallaRequestError {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const errorCode = typeof record.error_code === 'number' ? record.error_code : undefined;
  const message =
    typeof record.error === 'string'
      ? record.error
      : `Valhalla ${path} failed with HTTP ${status}.`;

  if (errorCode === 171 || errorCode === 154 || errorCode === 442) {
    return new ValhallaRequestError('NO_ROUTE', message, status, { errorCode, path });
  }
  if (status === 400) {
    return new ValhallaRequestError('NO_ROUTE', message, status, { errorCode, path });
  }
  return new ValhallaRequestError('VALHALLA_UNAVAILABLE', message, status, { errorCode, path });
}

function toFailure(error: unknown): RouteFailure {
  if (error instanceof ValhallaRequestError) {
    return error.toFailure();
  }
  return {
    code: 'VALHALLA_UNAVAILABLE',
    message: error instanceof Error ? error.message : 'Valhalla request failed.',
  };
}
