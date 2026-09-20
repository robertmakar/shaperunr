import { getDevelopmentApiUrl } from '@/constants/api';
import type { Coordinate } from '@/lib/geo';

export type ExperimentalUserRoute = {
  id: string;
  shapeCoordinates: Coordinate[];
  fullRouteCoordinates: Coordinate[];
  connectorCoordinates: Coordinate[];
  shapeDistance: number;
  connectorDistance: number;
  totalDistance: number;
  shapeScore: number;
  coverage: number;
  order: number;
  heading: number;
  backtrack: number;
  placement: {
    eastMeters: number;
    northMeters: number;
  };
  rotation: number;
  scale: number;
  distanceFromUser: number;
};

export type ExperimentalGenerateRoutesResponse = {
  status: 'ok' | 'no_viable_shape';
  word: string;
  targetDistance: number;
  routes: ExperimentalUserRoute[];
  message?: string;
};

export type ExperimentalGenerateRoutesError = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * Hard ceiling on how long the app will wait for a route search.
 *
 * The backend pipeline itself always terminates (verified: real requests
 * range from ~4s for a normal match up to ~19s for a large, ultimately
 * infeasible 8km search) — there was previously no client-side bound at
 * all, so a hung/dropped connection (flaky Wi-Fi, a LAN IP that stopped
 * being reachable, etc.) left the Finding screen spinning forever with no
 * way to recover short of manually backing out. This gives real, slow
 * requests several times their observed worst case, while guaranteeing
 * the UI always reaches an honest error instead of hanging indefinitely.
 */
export const EXPERIMENTAL_ROUTES_REQUEST_TIMEOUT_MS = 45_000;

export function experimentalNoMatchCopy(word: string): {
  title: string;
  body: string;
  tries: string[];
} {
  return {
    title: 'NO STRONG MATCH FOUND',
    body: `We couldn't find a walkable route nearby that clearly matches "${word}".`,
    tries: ['a different word', 'a shorter distance', 'another area'],
  };
}

export function parseExperimentalRoutesResponse(payload: unknown): ExperimentalGenerateRoutesResponse | null {
  if (payload == null || typeof payload !== 'object') {
    return null;
  }
  const body = payload as Partial<ExperimentalGenerateRoutesResponse>;
  if (body.status !== 'ok' && body.status !== 'no_viable_shape') {
    return null;
  }
  if (typeof body.word !== 'string' || typeof body.targetDistance !== 'number' || !Array.isArray(body.routes)) {
    return null;
  }
  const routes = body.routes.filter(isExperimentalUserRoute);
  if (body.status === 'ok' && routes.length === 0) {
    return null;
  }
  if (body.status === 'no_viable_shape') {
    return {
      status: 'no_viable_shape',
      word: body.word,
      targetDistance: body.targetDistance,
      routes: [],
      message: typeof body.message === 'string' ? body.message : 'No strong walkable match was found nearby.',
    };
  }
  return {
    status: 'ok',
    word: body.word,
    targetDistance: body.targetDistance,
    routes,
  };
}

/** DEVELOPMENT ONLY. Explains parser drops without changing parse behavior. */
export function describeExperimentalParse(payload: unknown): {
  jsonStatus: unknown;
  rawRouteCount: number;
  acceptedRouteCount: number;
  firstRouteId: unknown;
  parsedStatus: ExperimentalGenerateRoutesResponse['status'] | null;
  dropReason: string | null;
} {
  const jsonStatus = isRecord(payload) ? payload.status : undefined;
  const rawRoutes = isRecord(payload) && Array.isArray(payload.routes) ? payload.routes : [];
  const firstRoute = rawRoutes[0];
  const acceptedRouteCount = rawRoutes.filter(isExperimentalUserRoute).length;
  const parsed = parseExperimentalRoutesResponse(payload);
  let dropReason: string | null = null;
  if (!parsed) {
    if (payload == null || typeof payload !== 'object') {
      dropReason = 'payload_not_object';
    } else if (jsonStatus !== 'ok' && jsonStatus !== 'no_viable_shape') {
      dropReason = `unsupported_status:${String(jsonStatus)}`;
    } else if (typeof (payload as { word?: unknown }).word !== 'string') {
      dropReason = 'word_not_string';
    } else if (typeof (payload as { targetDistance?: unknown }).targetDistance !== 'number') {
      dropReason = `targetDistance_type:${typeof (payload as { targetDistance?: unknown }).targetDistance}`;
    } else if (!Array.isArray((payload as { routes?: unknown }).routes)) {
      dropReason = 'routes_not_array';
    } else if (jsonStatus === 'ok' && acceptedRouteCount === 0) {
      dropReason = 'ok_status_but_no_routes_passed_shape_guard';
    } else {
      dropReason = 'malformed';
    }
  }
  return {
    jsonStatus,
    rawRouteCount: rawRoutes.length,
    acceptedRouteCount,
    firstRouteId: isRecord(firstRoute) ? firstRoute.id : undefined,
    parsedStatus: parsed?.status ?? null,
    dropReason,
  };
}

export async function generateExperimentalRoutesFromBackend(input: {
  word: string;
  start: Coordinate;
  targetDistanceMeters: number;
  /** Lets a caller (e.g. the user backing out of the Finding presentation) abort the in-flight HTTP request. */
  signal?: AbortSignal;
}): Promise<
  { ok: true; data: ExperimentalGenerateRoutesResponse } | ExperimentalGenerateRoutesError
> {
  const baseUrl = getDevelopmentApiUrl();
  if (!baseUrl) {
    console.log('[generate-routes-experimental] API_URL_MISSING EXPO_PUBLIC_API_URL is not set');
    return {
      ok: false,
      status: 0,
      code: 'API_URL_MISSING',
      message: 'Route search is unavailable right now.',
    };
  }

  const requestBody = {
    word: input.word,
    latitude: input.start.latitude,
    longitude: input.start.longitude,
    targetDistance: input.targetDistanceMeters,
  };
  const requestUrl = `${baseUrl}/generate-routes-experimental`;
  console.log('[find-my-route][phone-request]', {
    word: input.word,
    selectedDistanceKm: input.targetDistanceMeters / 1000,
    targetDistanceMeters: input.targetDistanceMeters,
    latitude: input.start.latitude,
    longitude: input.start.longitude,
    expoPublicApiUrl: process.env.EXPO_PUBLIC_API_URL ?? null,
    apiUrl: baseUrl,
    requestUrl,
    path: '/generate-routes-experimental',
    apiUrlLooksLocalhost: isLocalhostUrl(baseUrl),
  });
  console.log('[experimental client] request', { apiUrl: baseUrl, requestUrl, ...requestBody });
  console.log('[generate-routes-experimental] request', { apiUrl: baseUrl, requestUrl, ...requestBody });

  // A caller-provided signal (e.g. the user backing out) and an internal
  // timeout both need to be able to cancel the same fetch, so they're
  // combined into one controller rather than relying on newer
  // AbortSignal.any()/timeout() statics that may not exist in this runtime.
  const requestController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, EXPERIMENTAL_ROUTES_REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => requestController.abort();
  input.signal?.addEventListener('abort', onExternalAbort);

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(requestBody),
      signal: requestController.signal,
    });

    const payload: unknown = await response.json();
    const parseInfo = describeExperimentalParse(payload);
    const firstRoute = isRecord(payload) && Array.isArray(payload.routes) ? payload.routes[0] : undefined;
    const diagnostics = isRecord(payload) && isRecord(payload.diagnostics) ? payload.diagnostics : null;
    console.log('[find-my-route][phone-response]', {
      httpStatus: response.status,
      responseStatus: parseInfo.jsonStatus,
      errorCode: !response.ok ? readApiError(payload).code : null,
      errorMessage: !response.ok ? readApiError(payload).message : null,
      returnedRoutes: parseInfo.rawRouteCount,
      acceptedRoutes: parseInfo.acceptedRouteCount,
      parsedStatus: parseInfo.parsedStatus,
      dropReason: parseInfo.dropReason,
      diagnostics: diagnostics
        ? {
            received: diagnostics.received,
            rejectedBy: diagnostics.rejectedBy,
            stages: diagnostics.stages,
            snapped: isRecord(diagnostics.search) && isRecord(diagnostics.search.originSnap)
              ? {
                  latitude: diagnostics.search.originSnap.snappedLatitude,
                  longitude: diagnostics.search.originSnap.snappedLongitude,
                  wayId: diagnostics.search.originSnap.wayId,
                  snapDistanceMeters: diagnostics.search.originSnap.snapDistanceMeters,
                }
              : null,
          }
        : null,
    });
    console.log('[experimental client] response status', response.status);
    console.log('[experimental client] response JSON status', parseInfo.jsonStatus);
    console.log('[experimental client] routes count', parseInfo.rawRouteCount);
    console.log('[experimental client] first route id', parseInfo.firstRouteId);
    console.log('[generate-routes-experimental] response', {
      httpStatus: response.status,
      status: parseInfo.jsonStatus,
      word: isRecord(payload) ? payload.word : undefined,
      targetDistance: isRecord(payload) ? payload.targetDistance : undefined,
      targetDistanceType: isRecord(payload) ? typeof payload.targetDistance : undefined,
      routeCount: parseInfo.rawRouteCount,
      acceptedRouteCount: parseInfo.acceptedRouteCount,
      firstRouteId: parseInfo.firstRouteId,
      parsedStatus: parseInfo.parsedStatus,
      dropReason: parseInfo.dropReason,
      firstRouteFieldTypes: isRecord(firstRoute)
        ? {
            id: typeof firstRoute.id,
            heading: typeof firstRoute.heading,
            backtrack: typeof firstRoute.backtrack,
            rotation: typeof firstRoute.rotation,
            scale: typeof firstRoute.scale,
            placement: isRecord(firstRoute.placement)
              ? typeof firstRoute.placement.eastMeters
              : typeof firstRoute.placement,
          }
        : undefined,
      rejectedBy: isRecord(payload) && isRecord(payload.diagnostics) ? payload.diagnostics.rejectedBy : undefined,
      received: isRecord(payload) && isRecord(payload.diagnostics) ? payload.diagnostics.received : undefined,
      stages: isRecord(payload) && isRecord(payload.diagnostics) ? payload.diagnostics.stages : undefined,
    });
    if (!response.ok) {
      const error = readApiError(payload);
      console.log('[experimental client] http not ok', { httpStatus: response.status, code: error.code });
      return {
        ok: false,
        status: response.status,
        code: error.code,
        message: 'We couldn’t find a walkable route right now.',
      };
    }

    const data = parseExperimentalRoutesResponse(payload);
    if (!data) {
      console.log('[experimental client] parse dropped payload', parseInfo);
      return {
        ok: false,
        status: response.status,
        code: 'MALFORMED_RESPONSE',
        message: 'We couldn’t find a walkable route right now.',
      };
    }
    console.log('[experimental client] parsed', {
      status: data.status,
      routes: data.routes.length,
      firstRouteId: data.routes[0]?.id,
    });
    return { ok: true, data };
  } catch (error) {
    const code = timedOut ? 'TIMEOUT' : 'BACKEND_UNAVAILABLE';
    console.log('[find-my-route][phone-response]', {
      httpStatus: 0,
      responseStatus: null,
      errorCode: code,
      errorMessage: error instanceof Error ? error.message : String(error),
      returnedRoutes: 0,
      acceptedRoutes: 0,
      parsedStatus: null,
      dropReason: timedOut ? 'request_timeout' : 'fetch_failed',
      diagnostics: null,
    });
    console.log('[experimental client] fetch failed', {
      timedOut,
      error: error instanceof Error ? error.message : error,
    });
    console.log(`[generate-routes-experimental] ${code}`, error instanceof Error ? error.message : error);
    return {
      ok: false,
      status: 0,
      code,
      message: timedOut
        ? 'The route search timed out. Please try again.'
        : 'We couldn’t find a walkable route right now.',
    };
  } finally {
    clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function isExperimentalUserRoute(value: unknown): value is ExperimentalUserRoute {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const route = value as Partial<ExperimentalUserRoute>;
  return (
    typeof route.id === 'string' &&
    Array.isArray(route.shapeCoordinates) &&
    Array.isArray(route.fullRouteCoordinates) &&
    Array.isArray(route.connectorCoordinates) &&
    typeof route.shapeDistance === 'number' &&
    typeof route.connectorDistance === 'number' &&
    typeof route.totalDistance === 'number' &&
    typeof route.shapeScore === 'number' &&
    typeof route.coverage === 'number' &&
    typeof route.order === 'number' &&
    typeof route.heading === 'number' &&
    typeof route.backtrack === 'number' &&
    typeof route.rotation === 'number' &&
    typeof route.scale === 'number' &&
    typeof route.distanceFromUser === 'number' &&
    route.placement != null &&
    typeof route.placement.eastMeters === 'number' &&
    typeof route.placement.northMeters === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return /localhost|127\.0\.0\.1/.test(value);
  }
}

function readApiError(payload: unknown): { code: string; message: string } {
  if (payload != null && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: { code?: string; message?: string } }).error;
    return {
      code: error?.code ?? 'NO_ROUTE',
      message: error?.message ?? 'Route search failed.',
    };
  }
  return { code: 'NO_ROUTE', message: 'Route search failed.' };
}
