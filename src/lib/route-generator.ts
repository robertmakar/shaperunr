/**
 * DEVELOPMENT ONLY.
 *
 * Proves the pipeline:
 *   word → letter/word geometry → geographic projection → mock street graph
 *   → candidate paths → shape scoring → ranked results
 *
 * The mock street grid is not OpenStreetMap. Do not present these candidates
 * as real runnable routes.
 */

import type { Coordinate } from '@/lib/geo';
import { resamplePolyline } from '@/lib/geometry';
import { scoreRouteAgainstShape, type ShapeMatchResult } from '@/lib/shape-match';
import {
  coordinatesToLocalMeters,
  dimensionsForTargetLength,
  offsetCoordinate,
  polylineLengthMeters,
  projectShapeToGeographic,
} from '@/lib/shape-projection';
import {
  createDevelopmentStreetGrid,
  routeThroughWaypoints,
  type StreetGraph,
} from '@/lib/street-network';
import { buildWordShape, type WordShape } from '@/lib/word-shape';

export const ROUTE_GENERATOR_DEVELOPMENT_ONLY = true;

export const DEVELOPMENT_ROUTE_WARNING =
  'DEVELOPMENT ONLY — mock street grid, not a real OSM route.';

export type GenerateCandidateRoutesInput = {
  word: string;
  startCoordinate: Coordinate;
  targetDistanceMeters: number;
  letterSpacing?: number;
  maxCandidates?: number;
};

export type RankedRouteCandidate = {
  id: string;
  label: string;
  developmentOnly: true;
  coordinates: Coordinate[];
  targetCoordinates: Coordinate[];
  lengthMeters: number;
  rotationDegrees: number;
  widthMeters: number;
  heightMeters: number;
  scale: number;
  score: ShapeMatchResult;
};

export type RouteGenerationResult = {
  developmentOnly: true;
  warning: string;
  word: string;
  wordShape: WordShape;
  targetGeographic: Coordinate[];
  targetLengthMeters: number;
  candidates: RankedRouteCandidate[];
};

const ROTATIONS_DEGREES = [0, 45, 90, 180];
const SCALE_FACTORS = [0.9, 1, 1.15];
const WAYPOINT_COUNT = 72;

export function generateCandidateRoutes(
  input: GenerateCandidateRoutesInput,
): RouteGenerationResult {
  const wordShape = buildWordShape(input.word, { letterSpacing: input.letterSpacing });
  const baseSize = dimensionsForTargetLength(wordShape, input.targetDistanceMeters);
  const target = projectShapeToGeographic(wordShape.points, {
    center: input.startCoordinate,
    widthMeters: baseSize.widthMeters,
    heightMeters: baseSize.heightMeters,
    rotationDegrees: 0,
  });

  const maxExtent = Math.hypot(baseSize.widthMeters, baseSize.heightMeters) * 1.15;
  const graph = createDevelopmentStreetGrid({
    center: input.startCoordinate,
    eastExtentMeters: Math.max(500, maxExtent / 2 + 240),
    northExtentMeters: Math.max(500, maxExtent / 2 + 240),
    spacingMeters: 35,
  });

  const ranked: RankedRouteCandidate[] = [];
  let index = 0;

  for (const rotationDegrees of ROTATIONS_DEGREES) {
    for (const scale of SCALE_FACTORS) {
      const candidate = buildMockCandidate({
        id: `dev-${index}`,
        wordShape,
        startCoordinate: input.startCoordinate,
        widthMeters: baseSize.widthMeters * scale,
        heightMeters: baseSize.heightMeters * scale,
        rotationDegrees,
        scale,
        graph,
      });
      index += 1;
      if (candidate) {
        ranked.push(candidate);
      }
    }
  }

  ranked.sort((a, b) => b.score.score - a.score.score);

  return {
    developmentOnly: true,
    warning: DEVELOPMENT_ROUTE_WARNING,
    word: wordShape.word,
    wordShape,
    targetGeographic: target.coordinates,
    targetLengthMeters: target.lengthMeters,
    candidates: ranked.slice(0, input.maxCandidates ?? 3),
  };
}

function buildMockCandidate(input: {
  id: string;
  wordShape: WordShape;
  startCoordinate: Coordinate;
  widthMeters: number;
  heightMeters: number;
  rotationDegrees: number;
  scale: number;
  graph: StreetGraph;
}): RankedRouteCandidate | null {
  const projected = projectShapeToGeographic(input.wordShape.points, {
    center: input.startCoordinate,
    widthMeters: input.widthMeters,
    heightMeters: input.heightMeters,
    rotationDegrees: input.rotationDegrees,
  });

  if (projected.coordinates.length < 2) {
    return null;
  }

  const waypoints = resampleCoordinates(projected.coordinates, WAYPOINT_COUNT);

  const coordinates = routeThroughWaypoints(input.graph, waypoints);
  if (coordinates.length < 2) {
    return null;
  }

  return {
    id: input.id,
    label: `${input.rotationDegrees}° × ${input.scale.toFixed(2)}`,
    developmentOnly: true,
    coordinates,
    targetCoordinates: projected.coordinates,
    lengthMeters: polylineLengthMeters(coordinates),
    rotationDegrees: input.rotationDegrees,
    widthMeters: input.widthMeters,
    heightMeters: input.heightMeters,
    scale: input.scale,
    score: scoreRouteAgainstShape(coordinates, projected.coordinates),
  };
}

function resampleCoordinates(coordinates: Coordinate[], sampleCount: number): Coordinate[] {
  const origin = coordinates[0];
  if (!origin) {
    return [];
  }

  return resamplePolyline(coordinatesToLocalMeters(origin, coordinates), sampleCount).map((point) =>
    offsetCoordinate(origin, point.x, point.y),
  );
}
