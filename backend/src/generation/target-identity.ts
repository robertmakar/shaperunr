/**
 * DEVELOPMENT ONLY. Global target-identity metrics for experimental routes.
 *
 * Shape-match coverage/order can credit a short local scribble (or a
 * sausage through a thin wide word) without the walk actually traversing
 * the requested letter/word. These metrics measure connected target-span
 * and per-letter follow, not mere proximity to the point cloud.
 */
import {
  boundingBox2,
  distanceToPolyline,
  polylineLength,
  projectPointOnPolyline,
  resamplePolyline,
  type Vec2,
} from '@/lib/geometry';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';
import { scoreOrderedPath } from '@/lib/shape-order';
import { buildWalkableWordShape } from './walkable-target';
import type { GeneratedRoute } from '../types';

export const TARGET_IDENTITY = {
  sampleCount: 80,
  progressBins: 32,
  maxOffTargetGapSamples: 4,
  maxForwardJump: 0.12,
  maxBacktrack: 0.16,
  /**
   * Street corners often sit just outside the coverage radius. A sample this
   * close still continues the same ordered walk; isolated endpoints do not.
   */
  nearMissMultiplier: 2,
  minLetterCoverage: 0.32,
  minLetterOrder: 0.45,
} as const;

export type LetterIdentity = {
  letter: string;
  startProgress: number;
  endProgress: number;
  coverage: number;
  order: number;
  meaningfullyVisited: boolean;
};

export type TargetIdentity = {
  targetLengthMeters: number;
  routeLengthMeters: number;
  requestedDistanceMeters: number | null;
  targetBox: { width: number; height: number };
  routeBox: { width: number; height: number };
  coverageThresholdMeters: number;
  progressMin: number;
  progressMax: number;
  onTargetProgressMin: number | null;
  onTargetProgressMax: number | null;
  startProgress: number;
  endProgress: number;
  naiveSpan: number;
  targetSpan: number;
  spanOccupancy: number;
  largestTargetGap: number;
  meanRouteToTargetMeters: number;
  letters: LetterIdentity[];
  lettersVisited: number;
  lettersVisitedInOrder: boolean;
  wordTraversal: number;
  lengthRatioRequested: number | null;
  lengthRatioProjected: number;
  traversesMostOfWord: boolean;
};

export type ProductIdentityContext = {
  word?: string;
  targetDistance?: number;
};

export function coverageThresholdMeters(target: readonly Vec2[]): number {
  const targetLength = polylineLength(target);
  const box = boundingBox2(target);
  const minSpan = Math.min(box?.width ?? targetLength, box?.height ?? targetLength);
  return Math.max(18, Math.min(minSpan * 0.22, targetLength * 0.025));
}

export function analyzeTargetIdentity(input: {
  route: readonly Vec2[];
  target: readonly Vec2[];
  word?: string;
  requestedDistanceMeters?: number;
}): TargetIdentity {
  const route = input.route.map((point) => ({ ...point }));
  const target = input.target.map((point) => ({ ...point }));
  const targetLength = polylineLength(target);
  const routeLength = polylineLength(route);
  const targetBox = boxOf(target);
  const routeBox = boxOf(route);
  const threshold = coverageThresholdMeters(target);
  const sampledRoute = resamplePolyline(route, TARGET_IDENTITY.sampleCount);
  const sampledTarget = resamplePolyline(target, TARGET_IDENTITY.sampleCount);
  const projections = sampledRoute.map((point) => projectPointOnPolyline(point, target));
  const progressValues = projections.map((item) => item.progress);
  const progressMin = progressValues.length === 0 ? 0 : Math.min(...progressValues);
  const progressMax = progressValues.length === 0 ? 0 : Math.max(...progressValues);
  const startProgress = progressValues[0] ?? 0;
  const endProgress = progressValues[progressValues.length - 1] ?? 0;

  const onTarget = projections
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.distance <= threshold);
  const onTargetProgress = onTarget.map((item) => item.progress);
  const onTargetProgressMin = onTargetProgress.length === 0 ? null : Math.min(...onTargetProgress);
  const onTargetProgressMax = onTargetProgress.length === 0 ? null : Math.max(...onTargetProgress);
  const naiveSpan =
    onTargetProgressMin == null || onTargetProgressMax == null
      ? 0
      : onTargetProgressMax - onTargetProgressMin;

  const connected = longestConnectedSpan(projections, threshold);
  const occupancy = spanOccupancy(projections, threshold, connected.start, connected.end, threshold);
  const occupiedSpan = connected.span * occupancy;
  const largestTargetGap = largestUnvisitedGap(sampledTarget, route, threshold);
  const meanRouteToTarget =
    sampledRoute.length === 0
      ? 0
      : sampledRoute.reduce((sum, point) => sum + distanceToPolyline(point, target), 0) / sampledRoute.length;

  const letters = letterIdentities(input.word ?? '', target, route, threshold);
  const visited = letters.filter((item) => item.meaningfullyVisited);
  const lettersVisitedInOrder = isIncreasing(visited.map((item) => item.startProgress));
  const wordTraversal = letters.length === 0 ? 0 : visited.length / letters.length;
  const traversesMostOfWord =
    letters.length <= 1
      ? occupiedSpan >= 0.55
      : wordTraversal >= 1 && lettersVisitedInOrder && occupiedSpan >= 0.7;

  return {
    targetLengthMeters: targetLength,
    routeLengthMeters: routeLength,
    requestedDistanceMeters: input.requestedDistanceMeters ?? null,
    targetBox,
    routeBox,
    coverageThresholdMeters: threshold,
    progressMin,
    progressMax,
    onTargetProgressMin,
    onTargetProgressMax,
    startProgress,
    endProgress,
    naiveSpan,
    targetSpan: occupiedSpan,
    spanOccupancy: occupancy,
    largestTargetGap,
    meanRouteToTargetMeters: meanRouteToTarget,
    letters,
    lettersVisited: visited.length,
    lettersVisitedInOrder,
    wordTraversal,
    lengthRatioRequested:
      input.requestedDistanceMeters && input.requestedDistanceMeters > 0
        ? routeLength / input.requestedDistanceMeters
        : null,
    lengthRatioProjected: targetLength <= 0 ? 0 : routeLength / targetLength,
    traversesMostOfWord,
  };
}

export function analyzeGeneratedRouteIdentity(
  route: GeneratedRoute,
  context: ProductIdentityContext,
): TargetIdentity {
  const origin =
    route.targetCoordinates[0] ?? route.shapeCoordinates?.[0] ?? route.coordinates[0] ?? {
      latitude: 0,
      longitude: 0,
    };
  const shape = route.shapeCoordinates ?? route.coordinates;
  return analyzeTargetIdentity({
    route: coordinatesToLocalMeters(origin, shape),
    target: coordinatesToLocalMeters(origin, route.targetCoordinates),
    word: context.word,
    requestedDistanceMeters: context.targetDistance,
  });
}

function letterIdentities(
  word: string,
  target: readonly Vec2[],
  route: readonly Vec2[],
  wordThreshold: number,
): LetterIdentity[] {
  const shape = buildWalkableWordShape(word);
  if (!shape.word || shape.letters.length === 0 || target.length < 2) {
    return [];
  }
  const sampledRoute = resamplePolyline(route, TARGET_IDENTITY.sampleCount);
  return shape.letters.map((letter) => {
    const projections = letter.points.map((point) => projectPointOnPolyline(point, shape.points).progress);
    const startProgress = projections.length === 0 ? 0 : Math.min(...projections);
    const endProgress = projections.length === 0 ? 0 : Math.max(...projections);
    const letterTarget = sliceTargetByProgress(target, startProgress, endProgress);
    const letterThreshold = Math.min(wordThreshold, coverageThresholdMeters(letterTarget));
    const samples = resamplePolyline(letterTarget, 24);
    const covered =
      samples.length === 0
        ? 0
        : samples.filter((point) => distanceToPolyline(point, route) <= letterThreshold).length / samples.length;
    const letterRoute = sampledRoute.filter((point) => {
      const hit = projectPointOnPolyline(point, target);
      return hit.distance <= letterThreshold * 2 && hit.progress >= startProgress - 0.03 && hit.progress <= endProgress + 0.03;
    });
    const order =
      letterTarget.length >= 2 && letterRoute.length >= 2
        ? scoreOrderedPath(letterRoute, resamplePolyline(letterTarget, Math.min(TARGET_IDENTITY.sampleCount, letterRoute.length)), letterTarget, {
            orderDistanceScale: Math.max(
              Math.min(boxOf(letterTarget).width, boxOf(letterTarget).height) * 0.25,
              polylineLength(letterTarget) * 0.04,
              1e-6,
            ),
            coverageThreshold: letterThreshold,
          }).order
        : 0;
    return {
      letter: letter.char,
      startProgress,
      endProgress,
      coverage: covered,
      order,
      meaningfullyVisited:
        covered >= TARGET_IDENTITY.minLetterCoverage && order >= TARGET_IDENTITY.minLetterOrder,
    };
  });
}

function longestConnectedSpan(
  projections: ReadonlyArray<{ progress: number; distance: number }>,
  threshold: number,
): { start: number; end: number; span: number } {
  if (projections.length === 0) {
    return { start: 0, end: 0, span: 0 };
  }

  let best = { start: 0, end: 0, span: 0 };
  let runStart: number | null = null;
  let cursor = 0;
  let off = 0;
  const nearThreshold = threshold * TARGET_IDENTITY.nearMissMultiplier;

  const closeRun = () => {
    if (runStart == null) {
      return;
    }
    const span = Math.max(0, cursor - runStart);
    if (span > best.span) {
      best = { start: runStart, end: cursor, span };
    }
    runStart = null;
    off = 0;
  };

  for (const sample of projections) {
    const onTarget = sample.distance <= threshold;
    const nearMiss = sample.distance <= nearThreshold;
    const continuingDetour = Boolean(runStart != null && nearMiss && !onTarget);

    if (!onTarget && !continuingDetour) {
      off += 1;
      if (off > TARGET_IDENTITY.maxOffTargetGapSamples) {
        closeRun();
      }
      continue;
    }

    if (runStart == null) {
      if (!onTarget) {
        continue;
      }
      runStart = sample.progress;
      cursor = sample.progress;
      off = 0;
      continue;
    }

    const delta = sample.progress - cursor;
    if (delta < -TARGET_IDENTITY.maxBacktrack || delta > TARGET_IDENTITY.maxForwardJump) {
      closeRun();
      if (onTarget) {
        runStart = sample.progress;
        cursor = sample.progress;
        off = 0;
      }
      continue;
    }

    if (onTarget) {
      off = 0;
    }
    cursor = Math.max(cursor, sample.progress);
  }
  closeRun();
  return best;
}

function spanOccupancy(
  projections: ReadonlyArray<{ progress: number; distance: number }>,
  threshold: number,
  start: number,
  end: number,
  _unused: number,
): number {
  void _unused;
  if (end <= start) {
    return 0;
  }
  const bins = TARGET_IDENTITY.progressBins;
  let occupied = 0;
  let total = 0;
  for (let index = 0; index < bins; index += 1) {
    const progress = (index + 0.5) / bins;
    if (progress < start || progress > end) {
      continue;
    }
    total += 1;
    if (projections.some((item) => item.distance <= threshold && Math.abs(item.progress - progress) <= 1 / bins)) {
      occupied += 1;
    }
  }
  return total === 0 ? 0 : occupied / total;
}

function largestUnvisitedGap(sampledTarget: readonly Vec2[], route: readonly Vec2[], threshold: number): number {
  if (sampledTarget.length === 0) {
    return 1;
  }
  let largest = 0;
  let current = 0;
  for (const point of sampledTarget) {
    if (distanceToPolyline(point, route) <= threshold) {
      largest = Math.max(largest, current);
      current = 0;
    } else {
      current += 1 / sampledTarget.length;
    }
  }
  return Math.max(largest, current);
}

function sliceTargetByProgress(target: readonly Vec2[], start: number, end: number): Vec2[] {
  const samples = resamplePolyline(target, 48);
  const sliced = samples.filter((_, index) => {
    const progress = samples.length === 1 ? 0 : index / (samples.length - 1);
    return progress >= start - 0.02 && progress <= end + 0.02;
  });
  return sliced.length >= 2 ? sliced : samples.slice(0, 2);
}

function boxOf(points: readonly Vec2[]): { width: number; height: number } {
  const box = boundingBox2(points);
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}

function isIncreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? 0) + 1e-6 < (values[index - 1] ?? 0)) {
      return false;
    }
  }
  return values.length > 0;
}
