import type { Coordinate } from '@/lib/geo';
import { boundingBox2, polylineLength, type Vec2 } from '@/lib/geometry';

/** Mean Earth radius used by haversine length checks. */
const EARTH_RADIUS_METERS = 6_371_000;

/**
 * Approximate meters per degree of latitude. Longitude meters shrink with
 * cos(latitude); we never treat 1° lat as equal to 1° lng.
 */
export const METERS_PER_DEGREE_LATITUDE = 111_320;

export type ShapeProjectionOptions = {
  center: Coordinate;
  widthMeters: number;
  heightMeters: number;
  /** Counter-clockwise rotation in the east/north plane. 0 keeps the word upright. */
  rotationDegrees?: number;
};

export type GeographicShape = {
  coordinates: Coordinate[];
  center: Coordinate;
  widthMeters: number;
  heightMeters: number;
  rotationDegrees: number;
  lengthMeters: number;
};

export function metersPerDegreeLongitude(latitude: number): number {
  return METERS_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
}

export function offsetCoordinate(
  origin: Coordinate,
  eastMeters: number,
  northMeters: number,
): Coordinate {
  return {
    latitude: origin.latitude + northMeters / METERS_PER_DEGREE_LATITUDE,
    longitude: origin.longitude + eastMeters / metersPerDegreeLongitude(origin.latitude),
  };
}

export function localMeters(origin: Coordinate, point: Coordinate): Vec2 {
  return {
    x: (point.longitude - origin.longitude) * metersPerDegreeLongitude(origin.latitude),
    y: (point.latitude - origin.latitude) * METERS_PER_DEGREE_LATITUDE,
  };
}

export function coordinatesToLocalMeters(origin: Coordinate, coordinates: Coordinate[]): Vec2[] {
  return coordinates.map((point) => localMeters(origin, point));
}

export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const phi1 = (a.latitude * Math.PI) / 180;
  const phi2 = (b.latitude * Math.PI) / 180;
  const dPhi = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLambda = ((b.longitude - a.longitude) * Math.PI) / 180;
  const sine =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(sine), Math.sqrt(1 - sine));
}

export function polylineLengthMeters(coordinates: readonly Coordinate[]): number {
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

/**
 * Scale a normalized drawing so its polyline length matches a target run distance,
 * while preserving the drawing's aspect ratio.
 */
export function dimensionsForTargetLength(
  shape: { width: number; height: number; length: number },
  targetLengthMeters: number,
): { widthMeters: number; heightMeters: number } {
  const scale = shape.length === 0 ? 0 : targetLengthMeters / shape.length;
  return {
    widthMeters: shape.width * scale,
    heightMeters: shape.height * scale,
  };
}

/**
 * Project normalized drawing coordinates (x right, y up) into geographic
 * coordinates around a center. Width/height are physical meters, not degrees.
 */
export function projectShapeToGeographic(
  points: readonly Vec2[],
  options: ShapeProjectionOptions,
): GeographicShape {
  const rotationDegrees = options.rotationDegrees ?? 0;
  const bounds = boundingBox2(points);
  const coordinates = bounds
    ? points.map((point) =>
        projectPoint(point, bounds, options.center, options.widthMeters, options.heightMeters, rotationDegrees),
      )
    : [];

  return {
    coordinates,
    center: options.center,
    widthMeters: options.widthMeters,
    heightMeters: options.heightMeters,
    rotationDegrees,
    lengthMeters: polylineLengthMeters(coordinates),
  };
}

export function projectPoint(
  point: Vec2,
  bounds: NonNullable<ReturnType<typeof boundingBox2>>,
  center: Coordinate,
  widthMeters: number,
  heightMeters: number,
  rotationDegrees: number,
): Coordinate {
  const cx = bounds.minX + bounds.width / 2;
  const cy = bounds.minY + bounds.height / 2;
  const east = bounds.width === 0 ? 0 : ((point.x - cx) / bounds.width) * widthMeters;
  const north = bounds.height === 0 ? 0 : ((point.y - cy) / bounds.height) * heightMeters;
  const radians = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return offsetCoordinate(center, east * cos - north * sin, east * sin + north * cos);
}

export function localPolylineLength(points: readonly Vec2[]): number {
  return polylineLength(points);
}
