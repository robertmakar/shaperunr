import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { translateCoordinates, type Coordinate } from '@/lib/geo';

export type Difficulty = 'Easy' | 'Moderate';

export type MockRoute = {
  id: number;
  distanceKm: number;
  durationMin: number;
  difficulty: Difficulty;
  matchPercent: number;
  /** Geographic polyline. DEVELOPMENT MOCK ROUTES only — not generated letter-routes. */
  coordinates: Coordinate[];
};

const BASE_DISTANCE_KM = 4;

/**
 * DEVELOPMENT MOCK ROUTES
 *
 * Temporary Cairo coordinates for map-foundation work.
 * These are NOT generated ROBZ (or any other word) street routes.
 * getMockRoutes() may translate this geometry to the user's start coordinate
 * for map context only. That translation is still mock data.
 */
const ROUTE_TEMPLATES: MockRoute[] = [
  {
    id: 1,
    distanceKm: 3.8,
    durationMin: 24,
    difficulty: 'Easy',
    matchPercent: 92,
    coordinates: [
      { latitude: 30.0444, longitude: 31.2357 },
      { latitude: 30.0479, longitude: 31.2357 },
      { latitude: 30.0479, longitude: 31.2412 },
      { latitude: 30.0456, longitude: 31.2412 },
      { latitude: 30.0456, longitude: 31.2375 },
      { latitude: 30.0416, longitude: 31.2441 },
      { latitude: 30.0489, longitude: 31.2474 },
      { latitude: 30.0489, longitude: 31.2532 },
      { latitude: 30.0415, longitude: 31.2532 },
      { latitude: 30.0449, longitude: 31.2576 },
    ],
  },
  {
    id: 2,
    distanceKm: 4.4,
    durationMin: 27,
    difficulty: 'Easy',
    matchPercent: 87,
    coordinates: [
      { latitude: 30.0558, longitude: 31.2198 },
      { latitude: 30.061, longitude: 31.218 },
      { latitude: 30.0656, longitude: 31.2219 },
      { latitude: 30.0644, longitude: 31.2271 },
      { latitude: 30.0592, longitude: 31.2258 },
      { latitude: 30.0608, longitude: 31.2202 },
      { latitude: 30.0546, longitude: 31.223 },
      { latitude: 30.0508, longitude: 31.2188 },
      { latitude: 30.0526, longitude: 31.2146 },
      { latitude: 30.0568, longitude: 31.2164 },
    ],
  },
  {
    id: 3,
    distanceKm: 3.2,
    durationMin: 20,
    difficulty: 'Moderate',
    matchPercent: 81,
    coordinates: [
      { latitude: 30.0368, longitude: 31.2292 },
      { latitude: 30.0414, longitude: 31.2258 },
      { latitude: 30.0458, longitude: 31.2296 },
      { latitude: 30.0502, longitude: 31.2248 },
      { latitude: 30.0546, longitude: 31.2288 },
      { latitude: 30.0588, longitude: 31.2242 },
    ],
  },
];

export function getMockRoutes(
  requestedKm: number,
  origin: Coordinate = DEVELOPMENT_FALLBACK_LOCATION,
): MockRoute[] {
  const scale = requestedKm / BASE_DISTANCE_KM;

  return ROUTE_TEMPLATES.map((route) => ({
    ...route,
    distanceKm: Math.round(route.distanceKm * scale * 10) / 10,
    durationMin: Math.max(1, Math.round(route.durationMin * scale)),
    coordinates: translateCoordinates(route.coordinates, DEVELOPMENT_FALLBACK_LOCATION, origin),
  }));
}

export function getMockRouteById(id: number): MockRoute | undefined {
  return ROUTE_TEMPLATES.find((route) => route.id === id);
}

export function getRouteCoordinates(
  id: number,
  origin: Coordinate = DEVELOPMENT_FALLBACK_LOCATION,
): Coordinate[] {
  const template = getMockRouteById(id);
  const coordinates = template?.coordinates ?? ROUTE_TEMPLATES[0]?.coordinates ?? [];
  return translateCoordinates(coordinates, DEVELOPMENT_FALLBACK_LOCATION, origin);
}
