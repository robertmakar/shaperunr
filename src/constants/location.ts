import type { Coordinate } from '@/lib/geo';

/**
 * DEVELOPMENT FALLBACK LOCATION
 *
 * Cairo, Egypt. Used when the user has not granted location permission,
 * location services are unavailable, or the current platform cannot provide
 * a position (including web for this milestone).
 *
 * This is not a generated running route origin.
 */
export const DEVELOPMENT_FALLBACK_LOCATION: Coordinate = {
  latitude: 30.0444,
  longitude: 31.2357,
};
