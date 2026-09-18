import { getDevelopmentApiUrl } from '@/constants/api';
import type { Coordinate } from '@/lib/geo';

export type RealRouteSource = 'valhalla';

export type RealRouteFailure = {
  code: string;
  message: string;
  candidateId?: string;
};

export type RealGeneratedRoute = {
  id: string;
  source: RealRouteSource;
  developmentOnly: true;
  coordinates: Coordinate[];
  targetCoordinates: Coordinate[];
  distanceMeters: number;
  shapeScore: number;
  coverage: number;
  scoreBreakdown: {
    proximity: number;
    coverage: number;
    order: number;
    lengthFit: number;
    detour: number;
    backtrack: number;
    finalScore: number;
  };
  metadata: {
    rotationDegrees: number;
    scale: number;
    placement: string;
    method: 'trace_route' | 'route_through';
    connectedFromStart: boolean;
    startSnapDistanceMeters: number;
    lengthError: number;
    distanceError: number;
    detourRatio: number;
    backtrackRatio: number;
  };
};

export type RealGenerateRoutesResponse = {
  source: RealRouteSource;
  developmentOnly: true;
  warning: string;
  word: string;
  target: {
    coordinates: Coordinate[];
    lengthMeters: number;
  };
  start: Coordinate;
  elapsedMs: number;
  routes: RealGeneratedRoute[];
  failures: RealRouteFailure[];
};

export type RealGenerateRoutesError = {
  ok: false;
  status: number;
  code: string;
  message: string;
  failures: RealRouteFailure[];
};

export async function generateRealRoutesFromBackend(input: {
  word: string;
  start: Coordinate;
  targetDistanceMeters: number;
}): Promise<
  { ok: true; data: RealGenerateRoutesResponse } | RealGenerateRoutesError
> {
  const baseUrl = getDevelopmentApiUrl();
  if (!baseUrl) {
    return {
      ok: false,
      status: 0,
      code: 'API_URL_MISSING',
      message:
        'Set EXPO_PUBLIC_API_URL to the RunShape backend (see backend/README.md). localhost is not hard-coded because it breaks on physical devices.',
      failures: [],
    };
  }

  try {
    const response = await fetch(`${baseUrl}/generate-routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        word: input.word,
        latitude: input.start.latitude,
        longitude: input.start.longitude,
        targetDistance: input.targetDistanceMeters,
      }),
    });

    const payload = (await response.json()) as
      | RealGenerateRoutesResponse
      | { error?: { code?: string; message?: string; failures?: RealRouteFailure[] } };

    if (!response.ok) {
      const error = 'error' in payload ? payload.error : undefined;
      return {
        ok: false,
        status: response.status,
        code: error?.code ?? 'NO_ROUTE',
        message: error?.message ?? 'Real route generation failed.',
        failures: error?.failures ?? [],
      };
    }

    return { ok: true, data: payload as RealGenerateRoutesResponse };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      code: 'BACKEND_UNAVAILABLE',
      message:
        error instanceof Error
          ? `Cannot reach the RunShape backend at ${baseUrl}. ${error.message}`
          : 'Cannot reach the RunShape backend.',
      failures: [],
    };
  }
}
