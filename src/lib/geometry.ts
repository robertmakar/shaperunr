export type Vec2 = {
  x: number;
  y: number;
};

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function distance2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polylineLength(points: readonly Vec2[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) {
      length += distance2(previous, current);
    }
  }
  return length;
}

export function resamplePolyline(points: readonly Vec2[], sampleCount: number): Vec2[] {
  if (points.length === 0 || sampleCount <= 0) {
    return [];
  }
  if (points.length === 1 || sampleCount === 1) {
    return [{ ...(points[0] as Vec2) }];
  }

  const totalLength = polylineLength(points);
  const first = points[0] as Vec2;
  const last = points[points.length - 1] as Vec2;
  if (totalLength === 0) {
    return Array.from({ length: sampleCount }, () => ({ ...first }));
  }

  const samples: Vec2[] = [];
  const step = totalLength / (sampleCount - 1);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    samples.push(pointAtLength(points, Math.min(step * sampleIndex, totalLength)));
  }

  samples[0] = { ...first };
  samples[sampleCount - 1] = { ...last };
  return samples;
}

function pointAtLength(points: readonly Vec2[], distance: number): Vec2 {
  let remaining = distance;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) {
      continue;
    }
    const segment = distance2(start, end);
    if (remaining <= segment || index === points.length - 2) {
      const t = segment === 0 ? 0 : Math.min(remaining / segment, 1);
      return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      };
    }
    remaining -= segment;
  }

  return { ...(points[points.length - 1] as Vec2) };
}

export function boundingBox2(points: readonly Vec2[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
} | null {
  const first = points[0];
  if (!first) {
    return null;
  }

  let minX = first.x;
  let maxX = first.x;
  let minY = first.y;
  let maxY = first.y;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function pointsInUnitSquare(points: readonly Vec2[], epsilon = 1e-6): boolean {
  return points.every(
    (point) =>
      point.x >= -epsilon &&
      point.x <= 1 + epsilon &&
      point.y >= -epsilon &&
      point.y <= 1 + epsilon,
  );
}

export function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return distance2(point, a);
  }

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return distance2(point, { x: a.x + dx * t, y: a.y + dy * t });
}

export type PolylineProjection = {
  distance: number;
  progress: number;
  point: Vec2;
  segmentIndex: number;
};

export function projectPointOnSegment(
  point: Vec2,
  a: Vec2,
  b: Vec2,
): { distance: number; t: number; point: Vec2 } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return { distance: distance2(point, a), t: 0, point: { ...a } };
  }

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  const projected = { x: a.x + dx * t, y: a.y + dy * t };
  return { distance: distance2(point, projected), t, point: projected };
}

export function projectPointOnPolyline(point: Vec2, polyline: readonly Vec2[]): PolylineProjection {
  const first = polyline[0];
  if (!first) {
    return {
      distance: Number.POSITIVE_INFINITY,
      progress: 0,
      point: { x: 0, y: 0 },
      segmentIndex: 0,
    };
  }
  if (polyline.length === 1) {
    return { distance: distance2(point, first), progress: 0, point: { ...first }, segmentIndex: 0 };
  }

  const total = polylineLength(polyline);
  let best: PolylineProjection = {
    distance: Number.POSITIVE_INFINITY,
    progress: 0,
    point: { ...first },
    segmentIndex: 0,
  };
  let traveled = 0;

  for (let index = 0; index < polyline.length - 1; index += 1) {
    const start = polyline[index];
    const end = polyline[index + 1];
    if (!start || !end) {
      continue;
    }
    const segmentLength = distance2(start, end);
    const hit = projectPointOnSegment(point, start, end);
    if (hit.distance < best.distance) {
      best = {
        distance: hit.distance,
        progress: total === 0 ? 0 : (traveled + hit.t * segmentLength) / total,
        point: hit.point,
        segmentIndex: index,
      };
    }
    traveled += segmentLength;
  }

  return best;
}

export function distanceToPolyline(point: Vec2, polyline: readonly Vec2[]): number {
  const first = polyline[0];
  if (!first) {
    return Number.POSITIVE_INFINITY;
  }
  if (polyline.length === 1) {
    return distance2(point, first);
  }

  let min = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.length; index += 1) {
    const start = polyline[index - 1];
    const end = polyline[index];
    if (start && end) {
      min = Math.min(min, distanceToSegment(point, start, end));
    }
  }
  return min;
}

export function headingRadians(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

export function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  while (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}
