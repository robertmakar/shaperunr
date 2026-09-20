import type { Coordinate } from '@/lib/geo';
import { isValidCoordinate } from '@/lib/geo';
import { distanceMeters, polylineLengthMeters } from '@/lib/shape-projection';

/**
 * Foreground GPS run tracking. In-memory only — never written to disk.
 * Background location is intentionally not used.
 */
export const RUN_TRACKING = {
  minAccuracyMeters: 45,
  minStepMeters: 3,
  shapeArriveMeters: 25,
  distanceIntervalMeters: 5,
  timeIntervalMs: 1000,
} as const;

export type RunTrackingStatus =
  | 'idle'
  | 'requesting'
  | 'running'
  | 'paused'
  | 'denied'
  | 'finished';

export type RunCoursePhase = 'connecting' | 'drawing';

export type GpsFix = {
  coordinate: Coordinate;
  timestamp: number;
  accuracy: number | null;
};

export type RunTrackingSession = {
  status: RunTrackingStatus;
  elapsedRunningMs: number;
  runningSinceMs: number | null;
  pathSegments: Coordinate[][];
  position: Coordinate | null;
};

export function createRunTrackingSession(
  status: RunTrackingStatus = 'idle',
): RunTrackingSession {
  return {
    status,
    elapsedRunningMs: 0,
    runningSinceMs: null,
    pathSegments: [],
    position: null,
  };
}

export function startRunTrackingSession(nowMs: number): RunTrackingSession {
  return {
    status: 'running',
    elapsedRunningMs: 0,
    runningSinceMs: nowMs,
    pathSegments: [[]],
    position: null,
  };
}

export function pauseRunTrackingSession(
  session: RunTrackingSession,
  nowMs: number,
): RunTrackingSession {
  if (session.status !== 'running') {
    return session;
  }
  return {
    ...session,
    status: 'paused',
    elapsedRunningMs: elapsedRunMilliseconds(session, nowMs),
    runningSinceMs: null,
  };
}

export function resumeRunTrackingSession(
  session: RunTrackingSession,
  nowMs: number,
): RunTrackingSession {
  if (session.status !== 'paused') {
    return session;
  }
  return {
    ...session,
    status: 'running',
    runningSinceMs: nowMs,
    // A new segment prevents GPS reacquisition from adding a distance bridge.
    pathSegments: [...session.pathSegments, []],
  };
}

export function finishRunTrackingSession(
  session: RunTrackingSession,
  nowMs: number,
): RunTrackingSession {
  if (session.status !== 'running' && session.status !== 'paused') {
    return session;
  }
  return {
    ...session,
    status: 'finished',
    elapsedRunningMs:
      session.status === 'running'
        ? elapsedRunMilliseconds(session, nowMs)
        : session.elapsedRunningMs,
    runningSinceMs: null,
  };
}

export function elapsedRunMilliseconds(
  session: RunTrackingSession,
  nowMs: number,
): number {
  if (session.status !== 'running' || session.runningSinceMs == null) {
    return session.elapsedRunningMs;
  }
  return session.elapsedRunningMs + Math.max(0, nowMs - session.runningSinceMs);
}

export function appendRunSessionGpsFix(
  session: RunTrackingSession,
  fix: GpsFix,
): RunTrackingSession {
  if (session.status !== 'running') {
    return session;
  }
  const segmentIndex = Math.max(0, session.pathSegments.length - 1);
  const segment = session.pathSegments[segmentIndex] ?? [];
  const nextSegment = appendGpsFix(segment, fix);
  if (nextSegment.length === segment.length) {
    return {
      ...session,
      position: fix.coordinate,
    };
  }
  const pathSegments = [...session.pathSegments];
  pathSegments[segmentIndex] = nextSegment;
  return {
    ...session,
    pathSegments,
    position: fix.coordinate,
  };
}

export function runSessionPath(session: RunTrackingSession): Coordinate[] {
  return session.pathSegments.flat();
}

export function runSessionDistanceMeters(session: RunTrackingSession): number {
  return session.pathSegments.reduce(
    (total, segment) => total + liveRunDistanceMeters(segment),
    0,
  );
}

export function isRunTrackingActive(session: RunTrackingSession): boolean {
  return session.status === 'running';
}

export function shouldAcceptGpsFix(path: readonly Coordinate[], fix: GpsFix): boolean {
  if (!isValidCoordinate(fix.coordinate)) {
    return false;
  }
  if (fix.accuracy != null && fix.accuracy > RUN_TRACKING.minAccuracyMeters) {
    return false;
  }
  const previous = path[path.length - 1];
  if (!previous) {
    return true;
  }
  return distanceMeters(previous, fix.coordinate) >= RUN_TRACKING.minStepMeters;
}

export function appendGpsFix(path: readonly Coordinate[], fix: GpsFix): Coordinate[] {
  if (!shouldAcceptGpsFix(path, fix)) {
    return [...path];
  }
  return [...path, fix.coordinate];
}

export function liveRunDistanceMeters(path: readonly Coordinate[]): number {
  return polylineLengthMeters(path);
}

export function runCoursePhase(
  position: Coordinate | null,
  shapeStart: Coordinate | undefined,
): RunCoursePhase {
  if (!position || !shapeStart || !isValidCoordinate(shapeStart)) {
    return 'drawing';
  }
  return distanceMeters(position, shapeStart) > RUN_TRACKING.shapeArriveMeters ? 'connecting' : 'drawing';
}

export function runPermissionDeniedCopy(reason: 'denied' | 'restricted' | 'unavailable'): {
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
  if (reason === 'unavailable') {
    return {
      title: 'LOCATION NEEDED',
      body: 'Location access is required to track your run. Turn on Location Services and try again.',
      action: 'TRY AGAIN',
    };
  }
  return {
    title: 'LOCATION NEEDED',
    body: 'Location access is required to track your run.',
    action: 'TRY AGAIN',
  };
}

export function formatElapsedClock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function elapsedMinutes(elapsedMs: number): number {
  return Math.max(0, elapsedMs / 60_000);
}

export function gpsFixFromLocation(location: {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
}): GpsFix {
  return {
    coordinate: {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    },
    timestamp: location.timestamp,
    accuracy: location.coords.accuracy,
  };
}
