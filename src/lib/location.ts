import { Platform } from 'react-native';
import * as Location from 'expo-location';

import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { isValidCoordinate, type Coordinate } from '@/lib/geo';

export { DEVELOPMENT_FALLBACK_LOCATION };

const LOCATION_TIMEOUT_MS = 12_000;

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
