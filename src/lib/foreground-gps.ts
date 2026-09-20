import * as Location from 'expo-location';
import { Platform } from 'react-native';

import { RUN_TRACKING, gpsFixFromLocation, type GpsFix } from '@/lib/run-tracking';
import {
  getLocationPermissionState,
  requestLocationPermission,
  type LocationFailureReason,
  type LocationPermissionState,
} from '@/lib/location';

export type ForegroundWatch = {
  remove: () => void;
};

export type StartForegroundWatchResult =
  | { ok: true; watch: ForegroundWatch }
  | { ok: false; reason: LocationFailureReason };

/**
 * Foreground GPS watch only. Never requests background permission
 * and never starts background location updates.
 */
export async function startForegroundPositionWatch(input: {
  onFix: (fix: GpsFix) => void;
  onError?: (message: string) => void;
}): Promise<StartForegroundWatchResult> {
  const servicesEnabled = await Location.hasServicesEnabledAsync().catch(() => false);
  if (!servicesEnabled) {
    return { ok: false, reason: 'unavailable' };
  }

  let permission: LocationPermissionState = await getLocationPermissionState();
  if (permission !== 'granted') {
    permission = await requestLocationPermission();
  }

  if (permission === 'denied') {
    return { ok: false, reason: 'denied' };
  }
  if (permission === 'restricted') {
    return { ok: false, reason: 'restricted' };
  }
  if (permission !== 'granted') {
    return { ok: false, reason: 'unavailable' };
  }

  try {
    const subscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: RUN_TRACKING.distanceIntervalMeters,
        timeInterval: RUN_TRACKING.timeIntervalMs,
        mayShowUserSettingsDialog: true,
      },
      (location) => {
        input.onFix(gpsFixFromLocation(location));
      },
      (message) => {
        input.onError?.(message);
      },
    );

    return {
      ok: true,
      watch: {
        remove: () => {
          subscription.remove();
        },
      },
    };
  } catch {
    return { ok: false, reason: Platform.OS === 'web' ? 'unavailable' : 'failed' };
  }
}
