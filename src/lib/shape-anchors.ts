import {
  distance2,
  headingRadians,
  polylineLength,
  resamplePolyline,
  shortestAngleDelta,
  type Vec2,
} from '@/lib/geometry';

export const SHAPE_ANCHOR_COUNT = {
  min: 12,
  max: 16,
} as const;

export type ShapeAnchorOptions = {
  minCount?: number;
  maxCount?: number;
  cornerDegrees?: number;
  collapseFraction?: number;
};

/**
 * Deterministic ordered anchors from a drawing polyline.
 * Keeps endpoints, sharp corners, and bowl extrema; simplifies long straights.
 * Does not take every Nth sample.
 */
export function selectShapeAnchors(
  points: readonly Vec2[],
  options: ShapeAnchorOptions = {},
): Vec2[] {
  const minCount = options.minCount ?? SHAPE_ANCHOR_COUNT.min;
  const maxCount = options.maxCount ?? SHAPE_ANCHOR_COUNT.max;
  const cornerRadians = ((options.cornerDegrees ?? 38) * Math.PI) / 180;
  const collapseFraction = options.collapseFraction ?? 0.012;

  if (points.length === 0) {
    return [];
  }
  if (points.length === 1) {
    return [{ ...(points[0] as Vec2) }];
  }

  const dense = resamplePolyline(points, Math.max(96, points.length));
  const keep = new Array(dense.length).fill(false);
  keep[0] = true;
  keep[dense.length - 1] = true;

  for (let index = 1; index < dense.length - 1; index += 1) {
    const previous = dense[index - 1];
    const current = dense[index];
    const next = dense[index + 1];
    if (!previous || !current || !next) {
      continue;
    }
    const turn = Math.abs(
      shortestAngleDelta(headingRadians(previous, current), headingRadians(current, next)),
    );
    if (turn >= cornerRadians) {
      keep[index] = true;
    }
    if (isAxisExtremum(dense, index)) {
      keep[index] = true;
    }
  }

  let anchors = dense.filter((_, index) => keep[index]);
  anchors = collapseClosePoints(anchors, polylineLength(dense) * collapseFraction);
  anchors = reduceByWeakestCorner(anchors, maxCount);
  anchors = fillLongestGaps(dense, anchors, minCount);
  return anchors.map((point) => ({ ...point }));
}

export function collapseClosePoints(points: readonly Vec2[], minDistance: number): Vec2[] {
  if (points.length === 0) {
    return [];
  }
  const collapsed: Vec2[] = [{ ...(points[0] as Vec2) }];
  const lastIndex = points.length - 1;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const previous = collapsed[collapsed.length - 1];
    if (!point || !previous) {
      continue;
    }
    const isEnd = index === lastIndex;
    if (!isEnd && distance2(previous, point) < minDistance) {
      continue;
    }
    if (isEnd && distance2(previous, point) < minDistance && collapsed.length > 1) {
      collapsed[collapsed.length - 1] = { ...point };
      continue;
    }
    collapsed.push({ ...point });
  }
  return collapsed;
}

function isAxisExtremum(points: readonly Vec2[], index: number): boolean {
  const window = 3;
  const current = points[index];
  if (!current) {
    return false;
  }
  let minX = current.x;
  let maxX = current.x;
  let minY = current.y;
  let maxY = current.y;
  for (let offset = -window; offset <= window; offset += 1) {
    const neighbor = points[index + offset];
    if (!neighbor) {
      return false;
    }
    minX = Math.min(minX, neighbor.x);
    maxX = Math.max(maxX, neighbor.x);
    minY = Math.min(minY, neighbor.y);
    maxY = Math.max(maxY, neighbor.y);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const significant = Math.max(spanX, spanY) > 1e-6;
  if (!significant) {
    return false;
  }
  return (
    (current.x === maxX && spanX >= spanY * 0.35) ||
    (current.x === minX && spanX >= spanY * 0.35) ||
    (current.y === maxY && spanY >= spanX * 0.35) ||
    (current.y === minY && spanY >= spanX * 0.35)
  );
}

function reduceByWeakestCorner(points: Vec2[], maxCount: number): Vec2[] {
  const reduced = points.map((point) => ({ ...point }));
  while (reduced.length > maxCount && reduced.length > 2) {
    let dropIndex = 1;
    let weakest = Number.POSITIVE_INFINITY;
    for (let index = 1; index < reduced.length - 1; index += 1) {
      const previous = reduced[index - 1];
      const current = reduced[index];
      const next = reduced[index + 1];
      if (!previous || !current || !next) {
        continue;
      }
      const turn = Math.abs(
        shortestAngleDelta(headingRadians(previous, current), headingRadians(current, next)),
      );
      if (turn < weakest) {
        weakest = turn;
        dropIndex = index;
      }
    }
    reduced.splice(dropIndex, 1);
  }
  return reduced;
}

function fillLongestGaps(source: readonly Vec2[], anchors: Vec2[], minCount: number): Vec2[] {
  const filled = anchors.map((point) => ({ ...point }));
  while (filled.length < minCount && source.length > filled.length) {
    let bestGap = 0;
    let insertAfter = -1;
    let insertPoint: Vec2 | null = null;
    for (let index = 0; index < filled.length - 1; index += 1) {
      const start = filled[index];
      const end = filled[index + 1];
      if (!start || !end) {
        continue;
      }
      const startIndex = nearestIndex(source, start);
      const endIndex = nearestIndex(source, end);
      if (endIndex - startIndex < 2) {
        continue;
      }
      const midIndex = Math.floor((startIndex + endIndex) / 2);
      const mid = source[midIndex];
      const gap = distance2(start, end);
      if (mid && gap > bestGap) {
        bestGap = gap;
        insertAfter = index;
        insertPoint = mid;
      }
    }
    if (insertAfter < 0 || !insertPoint) {
      break;
    }
    filled.splice(insertAfter + 1, 0, { ...insertPoint });
  }
  return filled;
}

function nearestIndex(points: readonly Vec2[], target: Vec2): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) {
      continue;
    }
    const distance = distance2(point, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}
