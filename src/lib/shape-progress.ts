import type { Coordinate } from '@/lib/geo';
import {
  polylineLength,
  projectPointOnPolyline,
} from '@/lib/geometry';
import {
  coordinatesToLocalMeters,
  distanceMeters,
  localMeters,
} from '@/lib/shape-projection';

export const SHAPE_PROGRESS = {
  startToleranceMeters: 25,
  pathToleranceMeters: 30,
  completionToleranceMeters: 30,
  completionProgress: 0.95,
  maxForwardProgressPerUpdate: 0.08,
  progressEvidenceSlack: 0.03,
  maxReliableMovementMeters: 120,
} as const;

export type ShapeProgressStatus =
  | 'on_your_way'
  | 'drawing'
  | 'complete';

export type ShapeProgressState = {
  progress: number;
  progressPercent: number;
  maxProgress: number;
  nearestShapeDistanceMeters: number;
  nearestShapeIndex: number | null;
  gpsSegmentIndex: number | null;
  reachedShapeStart: boolean;
  completed: boolean;
  currentStatus: ShapeProgressStatus;
  shapeTravelMeters: number;
  lastGpsCoordinate: Coordinate | null;
};

export function createShapeProgressState(): ShapeProgressState {
  return {
    progress: 0,
    progressPercent: 0,
    maxProgress: 0,
    nearestShapeDistanceMeters: Number.POSITIVE_INFINITY,
    nearestShapeIndex: null,
    gpsSegmentIndex: null,
    reachedShapeStart: false,
    completed: false,
    currentStatus: 'on_your_way',
    shapeTravelMeters: 0,
    lastGpsCoordinate: null,
  };
}

export function calculateShapeProgress(
  shapeCoordinates: readonly Coordinate[],
  gpsSegments: readonly (readonly Coordinate[])[],
): ShapeProgressState {
  let state = createShapeProgressState();
  for (const [gpsSegmentIndex, segment] of gpsSegments.entries()) {
    for (const [pointIndex, coordinate] of segment.entries()) {
      state = advanceShapeProgress(shapeCoordinates, coordinate, state, {
        gpsSegmentIndex,
        startsGpsSegment: pointIndex === 0,
      });
    }
  }
  return state;
}

export function advanceShapeProgress(
  shapeCoordinates: readonly Coordinate[],
  gpsCoordinate: Coordinate,
  previous = createShapeProgressState(),
  options: {
    gpsSegmentIndex?: number;
    startsGpsSegment?: boolean;
  } = {},
): ShapeProgressState {
  const shapeStart = shapeCoordinates[0];
  const shapeEnd = shapeCoordinates[shapeCoordinates.length - 1];
  if (!shapeStart || !shapeEnd || shapeCoordinates.length < 2) {
    return previous;
  }

  if (previous.completed) {
    return {
      ...previous,
      progress: 1,
      progressPercent: 100,
      maxProgress: 1,
      completed: true,
      currentStatus: 'complete',
    };
  }

  const localShape = coordinatesToLocalMeters(
    shapeStart,
    [...shapeCoordinates],
  );
  const projection = projectPointOnPolyline(
    localMeters(shapeStart, gpsCoordinate),
    localShape,
  );
  const reachedShapeStart =
    previous.reachedShapeStart ||
    distanceMeters(gpsCoordinate, shapeStart) <=
      SHAPE_PROGRESS.startToleranceMeters;

  if (!reachedShapeStart) {
    return {
      ...previous,
      nearestShapeDistanceMeters: projection.distance,
      nearestShapeIndex: projection.segmentIndex,
      gpsSegmentIndex: options.gpsSegmentIndex ?? previous.gpsSegmentIndex,
      progress: 0,
      progressPercent: 0,
      maxProgress: 0,
      currentStatus: 'on_your_way',
      lastGpsCoordinate: null,
    };
  }

  const lastGpsCoordinate = options.startsGpsSegment
    ? null
    : previous.lastGpsCoordinate;
  const movementMeters = lastGpsCoordinate
    ? distanceMeters(lastGpsCoordinate, gpsCoordinate)
    : 0;
  const reliableMovement =
    movementMeters <= SHAPE_PROGRESS.maxReliableMovementMeters
      ? movementMeters
      : 0;
  const shapeTravelMeters =
    previous.shapeTravelMeters + reliableMovement;
  const shapeLengthMeters = polylineLength(localShape);
  let maxProgress = previous.maxProgress;

  if (projection.distance <= SHAPE_PROGRESS.pathToleranceMeters) {
    const evidenceLimit =
      shapeLengthMeters > 0
        ? shapeTravelMeters / shapeLengthMeters +
          SHAPE_PROGRESS.progressEvidenceSlack
        : 0;
    const allowedForwardProgress = Math.max(
      previous.maxProgress + SHAPE_PROGRESS.maxForwardProgressPerUpdate,
      evidenceLimit,
    );
    maxProgress = Math.max(
      previous.maxProgress,
      Math.min(projection.progress, allowedForwardProgress, 1),
    );
  }

  const completed =
    maxProgress >= SHAPE_PROGRESS.completionProgress &&
    distanceMeters(gpsCoordinate, shapeEnd) <=
      SHAPE_PROGRESS.completionToleranceMeters;
  const progress = completed ? 1 : maxProgress;

  return {
    progress,
    progressPercent: completed ? 100 : Math.round(progress * 100),
    maxProgress: progress,
    nearestShapeDistanceMeters: projection.distance,
    nearestShapeIndex: projection.segmentIndex,
    gpsSegmentIndex: options.gpsSegmentIndex ?? previous.gpsSegmentIndex,
    reachedShapeStart: true,
    completed,
    currentStatus: completed ? 'complete' : 'drawing',
    shapeTravelMeters,
    lastGpsCoordinate: gpsCoordinate,
  };
}

export function shapeProgressCoordinates(
  shapeCoordinates: readonly Coordinate[],
  progress: number,
): Coordinate[] {
  return splitShapeAtProgress(shapeCoordinates, progress).completed;
}

/** The mirror of `shapeProgressCoordinates` — everything from the same progress cut point to the shape's end. */
export function remainingShapeProgressCoordinates(
  shapeCoordinates: readonly Coordinate[],
  progress: number,
): Coordinate[] {
  return splitShapeAtProgress(shapeCoordinates, progress).remaining;
}

/**
 * Cuts the shape's own coordinates at `progress` (0–1 along its total
 * length) into a completed prefix and a remaining suffix that share the
 * exact same interpolated cut point — so a map drawing both as separate
 * overlays never shows a seam or gap between them. Shared by
 * `shapeProgressCoordinates` and `remainingShapeProgressCoordinates` so
 * there is exactly one place that computes where the cut falls.
 */
function splitShapeAtProgress(
  shapeCoordinates: readonly Coordinate[],
  progress: number,
): { completed: Coordinate[]; remaining: Coordinate[] } {
  const first = shapeCoordinates[0];
  if (!first || shapeCoordinates.length < 2) {
    return { completed: [], remaining: [] };
  }
  if (progress <= 0) {
    return { completed: [], remaining: [...shapeCoordinates] };
  }
  if (progress >= 1) {
    return { completed: [...shapeCoordinates], remaining: [] };
  }

  const local = coordinatesToLocalMeters(first, [...shapeCoordinates]);
  const totalLength = polylineLength(local);
  const targetLength = totalLength * progress;
  const completed: Coordinate[] = [first];
  let traveled = 0;

  for (let index = 0; index < local.length - 1; index += 1) {
    const start = local[index];
    const end = local[index + 1];
    const geographicEnd = shapeCoordinates[index + 1];
    if (!start || !end || !geographicEnd) {
      continue;
    }
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    if (traveled + segmentLength <= targetLength) {
      completed.push(geographicEnd);
      traveled += segmentLength;
      continue;
    }
    const ratio =
      segmentLength === 0
        ? 0
        : (targetLength - traveled) / segmentLength;
    const cutPoint = interpolateCoordinate(
      shapeCoordinates[index] as Coordinate,
      geographicEnd,
      ratio,
    );
    completed.push(cutPoint);
    return { completed, remaining: [cutPoint, ...shapeCoordinates.slice(index + 1)] };
  }
  return { completed, remaining: [] };
}

function interpolateCoordinate(
  start: Coordinate,
  end: Coordinate,
  ratio: number,
): Coordinate {
  const t = Math.max(0, Math.min(1, ratio));
  return {
    latitude: start.latitude + (end.latitude - start.latitude) * t,
    longitude: start.longitude + (end.longitude - start.longitude) * t,
  };
}
