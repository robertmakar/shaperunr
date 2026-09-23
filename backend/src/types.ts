import type { Coordinate } from '@/lib/geo';
import type { LetterShapeVariant } from '@/lib/letter-shapes';
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
  | 'MALFORMED_RESPONSE'
  | 'NO_VIABLE_SHAPE';

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
  shapeCoordinates?: Coordinate[];
  connectorCoordinates?: Coordinate[];
  distanceMeters: number;
  shapeScore: number;
  coverage: number;
  scoreBreakdown: ShapeScoreBreakdown;
  metadata: {
    rotationDegrees: number;
    scale: number;
    placement: 'start-anchored' | 'offset';
    offsetAcrossMeters: number;
    method: 'trace_route' | 'route_through' | 'route_breaks' | 'graph_constrained';
    connectedFromStart: boolean;
    startSnapDistanceMeters: number;
    lengthError: number;
    distanceError: number;
    detourRatio: number;
    backtrackRatio: number;
    score: ShapeMatchResult;
    connectorDistanceMeters?: number;
    graphShapeScore?: number;
    failureReason?: string | null;
    shapeRouteDistanceMeters?: number;
    totalDistanceMeters?: number;
    quality?: 'excellent' | 'acceptable' | 'weak';
    headingAgreementDegrees?: number;
    largestGap?: number;
    eastMeters?: number;
    northMeters?: number;
    distanceFromUserMeters?: number;
    connected?: boolean;
    /** Which letter geometry produced this route's target shape. Absent on routes built before this field existed (the legacy candidate-generator.ts path never sets it) — always present for graph_constrained routes. */
    geometryVariant?: LetterShapeVariant;
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
  status?: 'ok' | 'weak_candidates' | 'no_viable_shape';
  message?: string;
  suggestions?: string[];
};

export type ApiErrorBody = {
  error: {
    code: RouteFailureCode;
    message: string;
    failures?: RouteFailure[];
  };
};
