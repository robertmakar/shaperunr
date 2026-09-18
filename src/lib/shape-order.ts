import {
  distance2,
  headingRadians,
  projectPointOnPolyline,
  shortestAngleDelta,
  type Vec2,
} from '@/lib/geometry';

export type OrderMatchDetails = {
  dtwFit: number;
  dtwMeanDistanceMeters: number;
  warpFit: number;
  monotonicFit: number;
  jumpFit: number;
  revisitFit: number;
  directionFit: number;
  progressFit: number;
  order: number;
};

/**
 * Ordered-path similarity: the route should trace the target polyline
 * forward in time, not merely occupy the same point cloud.
 *
 * Combines:
 * - band-constrained DTW (local street warping allowed, reorderings are expensive)
 * - target-progress monotonicity / jump / revisit checks
 * - heading agreement at nearest target segments
 */
export function scoreOrderedPath(
  sampledRoute: readonly Vec2[],
  sampledTarget: readonly Vec2[],
  targetPolyline: readonly Vec2[],
  options: { orderDistanceScale: number; coverageThreshold: number },
): OrderMatchDetails {
  if (sampledRoute.length < 2 || sampledTarget.length < 2 || targetPolyline.length < 2) {
    return emptyOrder(sampledRoute.length > 0 && sampledTarget.length > 0);
  }

  const dtw = constrainedDtw(sampledRoute, sampledTarget);
  const dtwFit = clamp01(1 - dtw.meanDistance / options.orderDistanceScale);
  const progress = progressConsistency(sampledRoute, targetPolyline);
  const progressFit = clamp01(
    0.5 * progress.monotonicFit + 0.3 * progress.jumpFit + 0.2 * progress.revisitFit,
  );
  const directionFit = headingConsistency(
    sampledRoute,
    targetPolyline,
    options.coverageThreshold,
  );
  const order = clamp01(0.5 * dtwFit + 0.3 * progressFit + 0.2 * directionFit);

  return {
    dtwFit,
    dtwMeanDistanceMeters: dtw.meanDistance,
    warpFit: dtw.warpFit,
    monotonicFit: progress.monotonicFit,
    jumpFit: progress.jumpFit,
    revisitFit: progress.revisitFit,
    directionFit,
    progressFit,
    order,
  };
}

function emptyOrder(hasPoints: boolean): OrderMatchDetails {
  const value = hasPoints ? 0 : 1;
  return {
    dtwFit: value,
    dtwMeanDistanceMeters: hasPoints ? Number.POSITIVE_INFINITY : 0,
    warpFit: value,
    monotonicFit: value,
    jumpFit: value,
    revisitFit: value,
    directionFit: value,
    progressFit: value,
    order: value,
  };
}

type DtwResult = {
  meanDistance: number;
  warpFit: number;
};

function constrainedDtw(route: readonly Vec2[], target: readonly Vec2[]): DtwResult {
  const n = route.length;
  const m = target.length;
  const inf = Number.POSITIVE_INFINITY;
  const band = Math.max(8, Math.round(0.22 * Math.max(n, m)));
  const cost: number[][] = Array.from({ length: n }, () => Array.from({ length: m }, () => inf));

  const allowed = (i: number, j: number) => {
    if ((i === 0 && j === 0) || (i === n - 1 && j === m - 1)) {
      return true;
    }
    const expectedJ = n === 1 ? 0 : (i / (n - 1)) * (m - 1);
    return Math.abs(j - expectedJ) <= band;
  };

  for (let i = 0; i < n; i += 1) {
    const routePoint = route[i];
    if (!routePoint) {
      continue;
    }
    for (let j = 0; j < m; j += 1) {
      if (!allowed(i, j)) {
        continue;
      }
      const targetPoint = target[j];
      if (!targetPoint) {
        continue;
      }
      const step = distance2(routePoint, targetPoint);
      if (i === 0 && j === 0) {
        cost[i]![j] = step;
        continue;
      }
      const diagonal = i > 0 && j > 0 ? cost[i - 1]![j - 1]! : inf;
      const fromRoute = i > 0 ? cost[i - 1]![j]! : inf;
      const fromTarget = j > 0 ? cost[i]![j - 1]! : inf;
      const previous = Math.min(diagonal, fromRoute, fromTarget);
      if (previous !== inf) {
        cost[i]![j] = step + previous;
      }
    }
  }

  const total = cost[n - 1]![m - 1]!;
  if (!Number.isFinite(total)) {
    return { meanDistance: inf, warpFit: 0 };
  }

  const path = recoverDtwPath(cost);
  const meanDistance = path.length === 0 ? total : total / path.length;
  let diagonalSteps = 0;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    if (!previous || !current) {
      continue;
    }
    if (current.i > previous.i && current.j > previous.j) {
      diagonalSteps += 1;
    }
  }
  const warpFit = path.length <= 1 ? 1 : diagonalSteps / (path.length - 1);

  return { meanDistance, warpFit };
}

function recoverDtwPath(cost: number[][]): Array<{ i: number; j: number }> {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  if (n === 0 || m === 0) {
    return [];
  }

  const path: Array<{ i: number; j: number }> = [];
  let i = n - 1;
  let j = m - 1;
  const inf = Number.POSITIVE_INFINITY;

  while (i > 0 || j > 0) {
    path.push({ i, j });
    const diagonal = i > 0 && j > 0 ? cost[i - 1]![j - 1]! : inf;
    const fromRoute = i > 0 ? cost[i - 1]![j]! : inf;
    const fromTarget = j > 0 ? cost[i]![j - 1]! : inf;
    const best = Math.min(diagonal, fromRoute, fromTarget);
    if (best === inf) {
      break;
    }
    if (best === diagonal) {
      i -= 1;
      j -= 1;
    } else if (best === fromRoute) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  path.push({ i: 0, j: 0 });
  path.reverse();
  return path;
}

function progressConsistency(
  sampledRoute: readonly Vec2[],
  targetPolyline: readonly Vec2[],
): { monotonicFit: number; jumpFit: number; revisitFit: number } {
  const progress = sampledRoute.map((point) => projectPointOnPolyline(point, targetPolyline).progress);
  if (progress.length < 2) {
    return { monotonicFit: 1, jumpFit: 1, revisitFit: 1 };
  }

  let positive = 0;
  let negative = 0;
  let skipAmount = 0;
  let revisitSteps = 0;
  let maxProgress = progress[0] ?? 0;
  const jumpAllow = 4 / Math.max(progress.length - 1, 1);

  for (let index = 1; index < progress.length; index += 1) {
    const current = progress[index] ?? 0;
    const previous = progress[index - 1] ?? 0;
    const delta = current - previous;
    if (delta >= 0) {
      positive += delta;
    } else {
      negative += -delta;
    }
    skipAmount += Math.max(0, delta - jumpAllow);
    maxProgress = Math.max(maxProgress, previous);
    if (current < maxProgress - 0.12) {
      revisitSteps += 1;
    }
  }

  const variation = positive + negative;
  const monotonicFit = variation === 0 ? 1 : positive / variation;
  const jumpFit = clamp01(1 - skipAmount / 0.35);
  const revisitFit = 1 - revisitSteps / (progress.length - 1);

  return { monotonicFit, jumpFit, revisitFit };
}

function headingConsistency(
  sampledRoute: readonly Vec2[],
  targetPolyline: readonly Vec2[],
  coverageThreshold: number,
): number {
  let weighted = 0;
  let weight = 0;
  const far = Math.max(coverageThreshold * 2, 1);

  for (let index = 1; index < sampledRoute.length; index += 1) {
    const from = sampledRoute[index - 1];
    const to = sampledRoute[index];
    if (!from || !to) {
      continue;
    }
    const segment = distance2(from, to);
    if (segment < 1e-9) {
      continue;
    }
    weight += segment;
    const hit = projectPointOnPolyline(to, targetPolyline);
    if (hit.distance > far) {
      continue;
    }
    const start = targetPolyline[hit.segmentIndex];
    const end = targetPolyline[hit.segmentIndex + 1] ?? start;
    if (!start || !end || distance2(start, end) < 1e-9) {
      continue;
    }
    const delta = Math.abs(shortestAngleDelta(headingRadians(from, to), headingRadians(start, end)));
    weighted += clamp01(1 - delta / (Math.PI / 2)) * segment;
  }

  return weight === 0 ? 0 : weighted / weight;
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
