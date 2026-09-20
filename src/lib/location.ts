import { Platform } from 'react-native';
import * as Location from 'expo-location';

import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { isValidCoordinate, type Coordinate } from '@/lib/geo';

export { DEVELOPMENT_FALLBACK_LOCATION };

const LOCATION_TIMEOUT_MS = 12_000;
const REVERSE_GEOCODE_TIMEOUT_MS = 6_000;

export type LocationPermissionState = 'undetermined' | 'granted' | 'denied' | 'restricted' | 'unavailable';

export type LocationFailureReason = 'denied' | 'restricted' | 'unavailable' | 'timeout' | 'failed';

export type LocationResult =
  | { ok: true; coordinate: Coordinate }
  | { ok: false; reason: LocationFailureReason };

export async function getLocationPermissionState(): Promise<LocationPermissionState> {
  if (Platform.OS === 'web') {
    return 'undetermined';
  }

  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      return 'unavailable';
    }

    const permission = await Location.getForegroundPermissionsAsync();
    return mapPermissionResponse(permission);
  } catch {
    return 'unavailable';
  }
}

export async function requestLocationPermission(): Promise<LocationPermissionState> {
  if (Platform.OS === 'web') {
    return 'unavailable';
  }

  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      return 'unavailable';
    }

    const permission = await Location.requestForegroundPermissionsAsync();
    return mapPermissionResponse(permission);
  } catch {
    return 'unavailable';
  }
}

export async function getCurrentLocation(): Promise<LocationResult> {
  if (Platform.OS === 'web') {
    return { ok: false, reason: 'unavailable' };
  }

  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      return { ok: false, reason: 'unavailable' };
    }

    const permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) {
      return { ok: false, reason: permissionFailureReason(permission) };
    }

    try {
      const current = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        LOCATION_TIMEOUT_MS,
      );
      return coordinateFromPosition(current);
    } catch (error) {
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown) {
        const fallback = coordinateFromPosition(lastKnown);
        if (fallback.ok) {
          return fallback;
        }
      }

      return { ok: false, reason: isTimeoutError(error) ? 'timeout' : 'failed' };
    }
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export async function requestAndGetCurrentLocation(): Promise<LocationResult> {
  const permission = await requestLocationPermission();

  if (permission === 'granted') {
    return getCurrentLocation();
  }

  if (permission === 'denied') {
    return { ok: false, reason: 'denied' };
  }

  if (permission === 'restricted') {
    return { ok: false, reason: 'restricted' };
  }

  return { ok: false, reason: 'unavailable' };
}

/** Foreground GPS for experimental FIND MY ROUTE. Never requests background. */
export async function getForegroundLocationForSearch(): Promise<LocationResult> {
  const state = await getLocationPermissionState();
  if (state === 'granted') {
    return getCurrentLocation();
  }
  return requestAndGetCurrentLocation();
}

/**
 * Human-readable place name for a coordinate (e.g. "Park Slope, NY"), for
 * display only — never used for routing. Resolves to null (never lat/long)
 * on web, on timeout, or if the device can't reverse geocode.
 */
export async function reverseGeocodeLabel(coordinate: Coordinate): Promise<string | null> {
  if (Platform.OS === 'web') {
    return null;
  }

  try {
    const results = await withTimeout(
      Location.reverseGeocodeAsync(coordinate),
      REVERSE_GEOCODE_TIMEOUT_MS,
    );
    const place = results[0];
    if (!place) {
      return null;
    }

    const locality = place.city ?? place.subregion ?? place.district ?? null;
    const region = place.region ?? null;

    if (locality && region && locality !== region) {
      return `${locality}, ${region}`;
    }

    return locality ?? region ?? null;
  } catch {
    return null;
  }
}

export function searchLocationNeededCopy(reason: LocationFailureReason): {
  title: string;
  body: string;
  action: string;
} {
  if (reason === 'restricted') {
    return {
      title: 'LOCATION NEEDED',
      body: 'Location access is turned off. Enable it in Settings, then try again.',
      action: 'OPEN SETTINGS',
    };
  }
  if (reason === 'unavailable' || reason === 'timeout' || reason === 'failed') {
    return {
      title: 'LOCATION NEEDED',
      body: 'Location access is required to find a route near you. Turn on Location Services and try again.',
      action: 'TRY AGAIN',
    };
  }
  return {
    title: 'LOCATION NEEDED',
    body: 'Location access is required to find a route near you.',
    action: 'TRY AGAIN',
  };
}

export function resolveStartCoordinate(
  latitude?: number,
  longitude?: number,
): { coordinate: Coordinate; isFallback: boolean } {
  const candidate = {
    latitude: latitude ?? Number.NaN,
    longitude: longitude ?? Number.NaN,
  };

  if (isValidCoordinate(candidate)) {
    return { coordinate: candidate, isFallback: false };
  }

  return {
    coordinate: DEVELOPMENT_FALLBACK_LOCATION,
    isFallback: true,
  };
}

function mapPermissionResponse(permission: Location.LocationPermissionResponse): LocationPermissionState {
  if (permission.status === Location.PermissionStatus.GRANTED) {
    return 'granted';
  }

  if (permission.status === Location.PermissionStatus.UNDETERMINED) {
    return 'undetermined';
  }

  if (!permission.canAskAgain) {
    return 'restricted';
  }

  return 'denied';
}

function permissionFailureReason(permission: Location.LocationPermissionResponse): LocationFailureReason {
  const state = mapPermissionResponse(permission);
  if (state === 'restricted') {
    return 'restricted';
  }
  if (state === 'unavailable') {
    return 'unavailable';
  }
  return 'denied';
}

function coordinateFromPosition(position: Location.LocationObject): LocationResult {
  const coordinate = {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
  };

  if (!isValidCoordinate(coordinate)) {
    return { ok: false, reason: 'failed' };
  }

  return { ok: true, coordinate };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout';
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('timeout')), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
