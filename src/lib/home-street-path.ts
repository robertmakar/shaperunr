/**
 * Decorative street-path geometry for the Home canvas.
 * Uses the same word-shape language as generation, then chamfers it
 * into irregular street-like segments. Does not affect routing.
 */
import { boundingBox2, type Vec2 } from '@/lib/geometry';
import { buildWordShape } from '@/lib/word-shape';

export type HomeSize = {
  width: number;
  height: number;
};

export type HomeStreetLine = {
  points: readonly Vec2[];
  width: number;
  opacity: number;
};

export type HomeSegment = {
  key: string;
  left: number;
  top: number;
  length: number;
  angle: number;
  width: number;
  opacity: number;
  startProgress: number;
  endProgress: number;
};

export const HOME_ROUTE_WIDTH = 3.1;

export const HOME_BASE_STREETS: readonly HomeStreetLine[] = [
  {
    points: [
      { x: 0, y: 0.08 },
      { x: 0.19, y: 0.06 },
      { x: 0.41, y: 0.1 },
      { x: 0.68, y: 0.07 },
      { x: 1, y: 0.11 },
    ],
    width: 1,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0, y: 0.24 },
      { x: 0.16, y: 0.27 },
      { x: 0.37, y: 0.23 },
      { x: 0.58, y: 0.28 },
      { x: 0.81, y: 0.24 },
      { x: 1, y: 0.26 },
    ],
    width: 1.15,
    opacity: 0.18,
  },
  {
    points: [
      { x: 0.04, y: 0.43 },
      { x: 0.22, y: 0.4 },
      { x: 0.46, y: 0.45 },
      { x: 0.71, y: 0.41 },
      { x: 0.96, y: 0.46 },
    ],
    width: 1,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0, y: 0.61 },
      { x: 0.18, y: 0.64 },
      { x: 0.39, y: 0.59 },
      { x: 0.62, y: 0.65 },
      { x: 0.84, y: 0.6 },
      { x: 1, y: 0.63 },
    ],
    width: 1.2,
    opacity: 0.17,
  },
  {
    points: [
      { x: 0.02, y: 0.79 },
      { x: 0.27, y: 0.76 },
      { x: 0.51, y: 0.81 },
      { x: 0.74, y: 0.77 },
      { x: 1, y: 0.82 },
    ],
    width: 1,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0.08, y: 0.94 },
      { x: 0.31, y: 0.91 },
      { x: 0.55, y: 0.95 },
      { x: 0.86, y: 0.92 },
    ],
    width: 1,
    opacity: 0.15,
  },
  {
    points: [
      { x: 0.07, y: 0 },
      { x: 0.05, y: 0.21 },
      { x: 0.09, y: 0.44 },
      { x: 0.04, y: 0.68 },
      { x: 0.08, y: 1 },
    ],
    width: 1,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0.23, y: 0.02 },
      { x: 0.26, y: 0.26 },
      { x: 0.21, y: 0.49 },
      { x: 0.27, y: 0.73 },
      { x: 0.24, y: 0.98 },
    ],
    width: 1.1,
    opacity: 0.17,
  },
  {
    points: [
      { x: 0.41, y: 0 },
      { x: 0.38, y: 0.19 },
      { x: 0.44, y: 0.42 },
      { x: 0.39, y: 0.66 },
      { x: 0.43, y: 1 },
    ],
    width: 1,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0.58, y: 0.03 },
      { x: 0.62, y: 0.28 },
      { x: 0.56, y: 0.51 },
      { x: 0.61, y: 0.75 },
      { x: 0.57, y: 0.97 },
    ],
    width: 1.15,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0.76, y: 0 },
      { x: 0.73, y: 0.23 },
      { x: 0.79, y: 0.47 },
      { x: 0.74, y: 0.71 },
      { x: 0.78, y: 1 },
    ],
    width: 1,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0.92, y: 0.04 },
      { x: 0.95, y: 0.31 },
      { x: 0.9, y: 0.56 },
      { x: 0.94, y: 0.83 },
    ],
    width: 1,
    opacity: 0.15,
  },
  {
    points: [
      { x: 0.12, y: 0.27 },
      { x: 0.31, y: 0.34 },
      { x: 0.48, y: 0.29 },
    ],
    width: 1,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0.52, y: 0.61 },
      { x: 0.67, y: 0.54 },
      { x: 0.86, y: 0.58 },
    ],
    width: 1,
    opacity: 0.16,
  },
  {
    points: [
      { x: 0.18, y: 0.76 },
      { x: 0.29, y: 0.68 },
      { x: 0.36, y: 0.52 },
    ],
    width: 0.95,
    opacity: 0.15,
  },
  {
    points: [
      { x: 0.69, y: 0.24 },
      { x: 0.81, y: 0.33 },
      { x: 0.88, y: 0.48 },
    ],
    width: 0.95,
    opacity: 0.15,
  },
];

export function homeWordFromInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 12);
}

export function layoutHomeRoutePoints(word: string, size: HomeSize): Vec2[] {
  const normalized = homeWordFromInput(word);
  if (!normalized || size.width <= 0 || size.height <= 0) {
    return [];
  }

  const multiLetter = normalized.length > 1;
  const shape = buildWordShape(normalized, {
    letterSpacing: 0.22,
    maxLetters: 12,
    aspectRatio: multiLetter
      ? Math.min(3.2, Math.max(1.7, normalized.length * 0.74))
      : undefined,
  });
  if (shape.points.length < 2) {
    return [];
  }

  const insetX = size.width * (multiLetter ? 0.12 : 0.26);
  const insetY = size.height * (multiLetter ? 0.18 : 0.2);
  const scale = Math.min(
    (size.width - insetX * 2) / (shape.width || 1),
    (size.height - insetY * 2) / (shape.height || 1),
  );
  const drawingWidth = shape.width * scale;
  const drawingHeight = shape.height * scale;
  const originX = (size.width - drawingWidth) / 2;
  const originY = (size.height - drawingHeight) / 2;
  const first = shape.points[0];
  const last = shape.points[shape.points.length - 1];
  const closed =
    Boolean(first && last) &&
    Math.hypot(first.x - last.x, first.y - last.y) <= 0.02;

  const projected = shape.points.map((point, index) => {
    const phase = index * 1.61;
    return {
      x: originX + point.x * scale + Math.sin(phase) * 2.4,
      y: originY + (shape.height - point.y) * scale + Math.cos(phase * 0.79) * 1.8,
    };
  });
  if (closed && projected[0] && projected.length > 1) {
    projected[projected.length - 1] = { ...projected[0] };
  }
  return softenStreetPath(chamferCorners(projected, multiLetter ? 7 : 12), multiLetter);
}

export function layoutHomeScene(
  word: string,
  size: HomeSize,
): {
  streets: HomeSegment[];
  route: HomeSegment[];
} {
  if (size.width <= 0 || size.height <= 0) {
    return { streets: [], route: [] };
  }

  const routePoints = layoutHomeRoutePoints(word, size);
  const route = withProgress(
    pointsToHomeSegments(routePoints, 'route', HOME_ROUTE_WIDTH, 1.4),
    HOME_ROUTE_WIDTH,
    1,
  );
  const baseStreets = HOME_BASE_STREETS.flatMap((line, lineIndex) =>
    withProgress(
      pointsToHomeSegments(
        line.points.map((point) => ({
          x: point.x * size.width,
          y: point.y * size.height,
        })),
        `street-${lineIndex}`,
        line.width,
      ),
      line.width,
      line.opacity,
    ),
  );
  const underlay = route.map((segment, index) => ({
    ...segment,
    key: `underlay-${index}`,
    top: segment.top + (HOME_ROUTE_WIDTH - 1.5) / 2,
    width: 1.5,
    opacity: 0.16,
    startProgress: 0,
    endProgress: 1,
  }));
  const feeders = layoutFeederStreets(routePoints);

  return {
    streets: [...baseStreets, ...feeders, ...underlay],
    route,
  };
}

export function pointsToHomeSegments(
  points: readonly Vec2[],
  keyPrefix: string,
  strokeWidth: number,
  overlap = 0,
): Array<Omit<HomeSegment, 'width' | 'opacity' | 'startProgress' | 'endProgress'>> {
  const segments: Array<Omit<HomeSegment, 'width' | 'opacity' | 'startProgress' | 'endProgress'>> =
    [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) {
      continue;
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const rawLength = Math.hypot(dx, dy);
    if (rawLength < 0.6) {
      continue;
    }
    const length = rawLength + overlap;
    segments.push({
      key: `${keyPrefix}-${index}`,
      left: (start.x + end.x) / 2 - length / 2,
      top: (start.y + end.y) / 2 - strokeWidth / 2,
      length,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return segments;
}

function withProgress(
  segments: Array<Omit<HomeSegment, 'width' | 'opacity' | 'startProgress' | 'endProgress'>>,
  width: number,
  opacity: number,
): HomeSegment[] {
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let traveled = 0;
  return segments.map((segment) => {
    const startProgress = total > 0 ? traveled / total : 0;
    traveled += segment.length;
    return {
      ...segment,
      width,
      opacity,
      startProgress,
      endProgress: total > 0 ? traveled / total : 1,
    };
  });
}

function layoutFeederStreets(points: readonly Vec2[]): HomeSegment[] {
  if (points.length < 4) {
    return [];
  }
  const stride = Math.max(2, Math.floor(points.length / 6));
  const feeders: HomeSegment[] = [];
  for (let index = stride; index < points.length - 1; index += stride) {
    const origin = points[index];
    if (!origin) {
      continue;
    }
    const heading = ((((index * 53) % 140) - 70) * Math.PI) / 180;
    const first = 18 + (index % 3) * 5;
    const second = 16 + (index % 4) * 4;
    const bend = heading + (index % 2 === 0 ? 0.42 : -0.42);
    const mid = {
      x: origin.x + Math.cos(heading) * first,
      y: origin.y + Math.sin(heading) * first,
    };
    const end = {
      x: mid.x + Math.cos(bend) * second,
      y: mid.y + Math.sin(bend) * second,
    };
    const width = index % 2 === 0 ? 1.15 : 1;
    feeders.push(
      ...withProgress(
        pointsToHomeSegments([origin, mid, end], `feeder-${index}`, width),
        width,
        0.16,
      ),
    );
  }
  return feeders;
}

function chamferCorners(points: readonly Vec2[], amount: number): Vec2[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 3) {
    return points.map((point) => ({ ...point }));
  }

  const chamfered: Vec2[] = [{ ...first }];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const next = points[index + 1];
    if (!previous || !point || !next) {
      continue;
    }
    const incomingLength = Math.hypot(point.x - previous.x, point.y - previous.y);
    const outgoingLength = Math.hypot(next.x - point.x, next.y - point.y);
    if (incomingLength < 1 || outgoingLength < 1) {
      chamfered.push({ ...point });
      continue;
    }
    const incoming = {
      x: (point.x - previous.x) / incomingLength,
      y: (point.y - previous.y) / incomingLength,
    };
    const outgoing = {
      x: (next.x - point.x) / outgoingLength,
      y: (next.y - point.y) / outgoingLength,
    };
    if (incoming.x * outgoing.x + incoming.y * outgoing.y > 0.9) {
      chamfered.push({ ...point });
      continue;
    }
    const trim = Math.min(amount, incomingLength * 0.2, outgoingLength * 0.2);
    chamfered.push(
      {
        x: point.x - incoming.x * trim,
        y: point.y - incoming.y * trim,
      },
      {
        x: point.x + outgoing.x * trim,
        y: point.y + outgoing.y * trim,
      },
    );
  }
  chamfered.push({ ...last });
  return chamfered;
}

function softenStreetPath(points: readonly Vec2[], multiLetter: boolean): Vec2[] {
  const softened: Vec2[] = [];
  const bends = [-0.58, 0.32, -0.2, 0.48, -0.28] as const;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) {
      continue;
    }
    if (softened.length === 0) {
      softened.push({ ...start });
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(length / 34));
    const normalX = length > 0 ? -dy / length : 0;
    const normalY = length > 0 ? dx / length : 0;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const bend =
        step < steps
          ? (bends[(index + step) % bends.length] ?? 0) * (multiLetter ? 3.4 : 5.2)
          : 0;
      softened.push({
        x: start.x + dx * t + normalX * bend,
        y: start.y + dy * t + normalY * bend,
      });
    }
  }
  return softened;
}

export function routeBounds(points: readonly Vec2[]) {
  return boundingBox2(points);
}
