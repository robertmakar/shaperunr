import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';

export type Coordinate = {
  latitude: number;
  longitude: number;
};

export type BoundingBox = {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
};

export type MapRegion = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

export function isValidCoordinate(value: {
  latitude?: number;
  longitude?: number;
} | null | undefined): value is Coordinate {
  if (value == null) {
    return false;
  }

  const { latitude, longitude } = value;

  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

export function boundingBoxForCoordinates(coordinates: Coordinate[]): BoundingBox | null {
  const first = coordinates[0];

  if (!first) {
    return null;
  }

  return coordinates.reduce<BoundingBox>(
    (box, point) => ({
      minLatitude: Math.min(box.minLatitude, point.latitude),
      maxLatitude: Math.max(box.maxLatitude, point.latitude),
      minLongitude: Math.min(box.minLongitude, point.longitude),
      maxLongitude: Math.max(box.maxLongitude, point.longitude),
    }),
    {
      minLatitude: first.latitude,
      maxLatitude: first.latitude,
      minLongitude: first.longitude,
      maxLongitude: first.longitude,
    },
  );
}

export function regionForCoordinates(coordinates: Coordinate[], paddingFactor = 1.7): MapRegion {
  const box = boundingBoxForCoordinates(coordinates);

  if (!box) {
    return {
      latitude: DEVELOPMENT_FALLBACK_LOCATION.latitude,
      longitude: DEVELOPMENT_FALLBACK_LOCATION.longitude,
      latitudeDelta: 0.04,
      longitudeDelta: 0.04,
    };
  }

  const latitudeDelta = Math.max((box.maxLatitude - box.minLatitude) * paddingFactor, 0.008);
  const longitudeDelta = Math.max((box.maxLongitude - box.minLongitude) * paddingFactor, 0.008);

  return {
    latitude: (box.minLatitude + box.maxLatitude) / 2,
    longitude: (box.minLongitude + box.maxLongitude) / 2,
    latitudeDelta,
    longitudeDelta,
  };
}

export function translateCoordinates(
  coordinates: Coordinate[],
  from: Coordinate,
  to: Coordinate,
): Coordinate[] {
  const latitudeOffset = to.latitude - from.latitude;
  const longitudeOffset = to.longitude - from.longitude;

  return coordinates.map((point) => ({
    latitude: point.latitude + latitudeOffset,
    longitude: point.longitude + longitudeOffset,
  }));
}

export function osmEmbedBbox(coordinates: Coordinate[], paddingFactor = 1.35): string {
  const box = boundingBoxForCoordinates(coordinates);

  if (!box) {
    return '31.215,30.03,31.26,30.07';
  }

  const latPad = Math.max((box.maxLatitude - box.minLatitude) * (paddingFactor - 1), 0.003);
  const lonPad = Math.max((box.maxLongitude - box.minLongitude) * (paddingFactor - 1), 0.003);

  return [
    box.minLongitude - lonPad,
    box.minLatitude - latPad,
    box.maxLongitude + lonPad,
    box.maxLatitude + latPad,
  ].join(',');
}
