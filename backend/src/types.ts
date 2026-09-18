import type { Coordinate } from '@/lib/geo';
import type { ShapeMatchResult, ShapeScoreBreakdown } from '@/lib/shape-match';
import type { WordShape } from '@/lib/word-shape';

export type RouteSource = 'valhalla';

export type GenerateRoutesRequest = {
  word: string;
  latitude: number;
  longitude: number;
  targetDistance: number;
};

export type RouteFailureCode =
  | 'VALIDATION_ERROR'
  | 'VALHALLA_UNAVAILABLE'
  | 'VALHALLA_TIMEOUT'
  | 'NO_PEDESTRIAN_NETWORK'
  | 'NO_ROUTE'
  | 'TARGET_TOO_SMALL'
  | 'TARGET_TOO_LARGE'
  | 'DISTANCE_OUT_OF_RANGE'
  | 'MALFORMED_RESPONSE';

export type RouteFailure = {
  code: RouteFailureCode;
  message: string;
  candidateId?: string;
  details?: Record<string, unknown>;
};

export type GeneratedRoute = {
  id: string;
  source: RouteSource;
  developmentOnly: true;
  coordinates: Coordinate[];
  targetCoordinates: Coordinate[];
  distanceMeters: number;
  shapeScore: number;
  coverage: number;
  scoreBreakdown: ShapeScoreBreakdown;
  metadata: {
    rotationDegrees: number;
    scale: number;
    placement: 'start-anchored' | 'offset';
    offsetAcrossMeters: number;
    method: 'trace_route' | 'route_through' | 'route_breaks';
    connectedFromStart: boolean;
    startSnapDistanceMeters: number;
    lengthError: number;
    distanceError: number;
    detourRatio: number;
    backtrackRatio: number;
    score: ShapeMatchResult;
  };
};

export type GenerateRoutesResponse = {
  source: RouteSource;
  developmentOnly: true;
  warning: string;
  word: string;
  wordShape: Pick<WordShape, 'word' | 'width' | 'height' | 'aspectRatio' | 'length'>;
  target: {
    coordinates: Coordinate[];
    lengthMeters: number;
  };
  start: Coordinate;
  elapsedMs: number;
  routes: GeneratedRoute[];
  failures: RouteFailure[];
  search: {
    specCount: number;
    rotationCount: number;
    placementCount: number;
    initialScale: number;
    maxAttempts: number;
    routedAttempts: number;
    inRangeCandidates: number;
    returnedRoutes: number;
    valhallaCalls: number;
  };
};

export type ApiErrorBody = {
  error: {
    code: RouteFailureCode;
    message: string;
    failures?: RouteFailure[];
  };
};
