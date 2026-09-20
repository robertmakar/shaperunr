/**
 * DEVELOPMENT ONLY. Build a street-walkable target polyline from letter strokes.
 *
 * Flattening strokes in drawing order can insert empty-space teleports
 * (H's jump from the left stem to the right stem, E's jump to the middle bar).
 * Graph search then tries to follow those jumps as if they were ink.
 *
 * This covers every stroke by staying on existing ink: attach the next
 * unused stroke at the closest on-ink join, retracing only as needed.
 *
 * Covering is used only when flatten inserts an empty-space teleport.
 * Letters whose strokes already meet (T, I, U) keep drawing order so
 * search does not inflate retrace or shrink the letter at a given distance.
 * Single-stroke letters are unchanged.
 */
import {
  boundingBox2,
  distance2,
  polylineLength,
  projectPointOnPolyline,
  type Vec2,
} from '@/lib/geometry';
import { flattenLetterStrokes, getLetterShape, type LetterShape } from '@/lib/letter-shapes';
import { buildWordShape, type WordShape } from '@/lib/word-shape';

export const WALKABLE_TARGET = {
  onInk: 0.03,
  disconnected: 0.12,
} as const;

export function buildWalkableWordShape(rawWord: string): WordShape {
  const word = rawWord
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 16);
  if (!word) {
    return buildWordShape(rawWord);
  }

  const letters: Array<{ char: string; points: Vec2[] }> = [];
  const points: Vec2[] = [];
  let cursorX = 0;
  for (const char of word) {
    const shape = getLetterShape(char);
    if (!shape) {
      continue;
    }
    const letterPoints = walkableLetterPoints(shape).map((point) => ({
      x: point.x + cursorX,
      y: point.y,
    }));
    appendPolyline(points, letterPoints);
    letters.push({ char, points: letterPoints });
    cursorX += 1 + 0.28;
  }

  const bounds = boundingBox2(points);
  if (!bounds || points.length === 0) {
    return buildWordShape(rawWord);
  }
  const scale = Math.max(bounds.width, bounds.height) || 1;
  const normalizePoint = (point: Vec2): Vec2 => ({
    x: (point.x - bounds.minX) / scale,
    y: (point.y - bounds.minY) / scale,
  });
  const normalizedPoints = points.map(normalizePoint);
  const normalizedLetters = letters.map((letter) => ({
    char: letter.char,
    points: letter.points.map(normalizePoint),
  }));
  const normalizedBounds = boundingBox2(normalizedPoints);
  return {
    word,
    points: normalizedPoints,
    letters: normalizedLetters,
    width: normalizedBounds?.width ?? 0,
    height: normalizedBounds?.height ?? 0,
    aspectRatio:
      (normalizedBounds?.height ?? 0) === 0
        ? 1
        : (normalizedBounds?.width ?? 0) / (normalizedBounds?.height ?? 1),
    length: polylineLength(normalizedPoints),
  };
}

export function walkableLetterPoints(shape: LetterShape): Vec2[] {
  const flattened = flattenLetterStrokes(shape);
  if (longestEmptyJump(flattened, shape.strokes) <= WALKABLE_TARGET.disconnected) {
    return flattened;
  }
  return coverStrokesOnInk(shape.strokes);
}

export function coverStrokesOnInk(strokes: readonly (readonly Vec2[])[]): Vec2[] {
  const remaining = strokes
    .map((stroke) => stroke.map((point) => ({ ...point })))
    .filter((stroke) => stroke.length >= 2);
  if (remaining.length === 0) {
    return [];
  }
  if (remaining.length === 1) {
    return remaining[0]!;
  }

  remaining.sort((a, b) => polylineLength(b) - polylineLength(a));
  const path = remaining.shift()!.map((point) => ({ ...point }));

  while (remaining.length > 0) {
    const choice = pickNextStroke(path, remaining);
    if (!choice) {
      break;
    }
    remaining.splice(choice.index, 1);
    const joinWalk = walkAlongPolyline(path, path[path.length - 1]!, choice.joinOnPath);
    appendPolyline(path, joinWalk);
    const covered = walkStrokeFromJoin(choice.stroke, choice.joinOnStroke);
    appendPolyline(path, covered);
  }

  return collapseClose(path, 1e-4);
}

export function longestEmptyJump(points: readonly Vec2[], ink: readonly (readonly Vec2[])[]): number {
  let longest = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (!a || !b) {
      continue;
    }
    const length = distance2(a, b);
    if (length <= 1e-6) {
      continue;
    }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const onInk = ink.some((stroke) => projectPointOnPolyline(mid, stroke).distance <= WALKABLE_TARGET.onInk);
    if (!onInk) {
      longest = Math.max(longest, length);
    }
  }
  return longest;
}

function pickNextStroke(
  path: readonly Vec2[],
  remaining: readonly Vec2[][],
): {
  index: number;
  stroke: Vec2[];
  joinOnPath: Vec2;
  joinOnStroke: Vec2;
} | null {
  let best: {
    index: number;
    stroke: Vec2[];
    joinOnPath: Vec2;
    joinOnStroke: Vec2;
    distance: number;
    penDistance: number;
  } | null = null;
  const pen = path[path.length - 1];
  if (!pen) {
    return null;
  }

  for (const [index, stroke] of remaining.entries()) {
    const join = closestJoin(path, stroke);
    if (!join) {
      continue;
    }
    const candidate = {
      index,
      stroke,
      joinOnPath: join.onPath,
      joinOnStroke: join.onStroke,
      distance: join.distance,
      penDistance: distance2(pen, join.onPath),
    };
    if (
      !best ||
      candidate.distance < best.distance - 1e-6 ||
      (Math.abs(candidate.distance - best.distance) <= 1e-6 && candidate.penDistance < best.penDistance)
    ) {
      best = candidate;
    }
  }
  return best;
}

function closestJoin(
  path: readonly Vec2[],
  stroke: readonly Vec2[],
): { onPath: Vec2; onStroke: Vec2; distance: number } | null {
  const samples = [...samplePolyline(path, 24), ...path];
  let best: { onPath: Vec2; onStroke: Vec2; distance: number } | null = null;
  for (const point of samples) {
    const hit = projectPointOnPolyline(point, stroke);
    const candidate = {
      onPath: point,
      onStroke: hit.point,
      distance: hit.distance,
    };
    if (!best || candidate.distance < best.distance) {
      best = candidate;
    }
    if (candidate.distance <= 1e-6) {
      return candidate;
    }
  }
  for (const point of stroke) {
    const hit = projectPointOnPolyline(point, path);
    const candidate = {
      onPath: hit.point,
      onStroke: point,
      distance: hit.distance,
    };
    if (!best || candidate.distance < best.distance) {
      best = candidate;
    }
  }
  return best;
}

function walkStrokeFromJoin(stroke: readonly Vec2[], join: Vec2): Vec2[] {
  const hit = projectPointOnPolyline(join, stroke);
  const toStart = slicePolyline(stroke, hit.progress, 0);
  const toEnd = slicePolyline(stroke, hit.progress, 1);
  const startLen = polylineLength(toStart);
  const endLen = polylineLength(toEnd);
  if (startLen < 1e-4) {
    return toEnd;
  }
  if (endLen < 1e-4) {
    return toStart;
  }
  if (startLen <= endLen) {
    return [...toStart, ...reversePolyline(toStart).slice(1), ...toEnd.slice(1)];
  }
  return [...toEnd, ...reversePolyline(toEnd).slice(1), ...toStart.slice(1)];
}

function walkAlongPolyline(polyline: readonly Vec2[], from: Vec2, to: Vec2): Vec2[] {
  const start = projectPointOnPolyline(from, polyline);
  const end = projectPointOnPolyline(to, polyline);
  return slicePolyline(polyline, start.progress, end.progress);
}

function slicePolyline(polyline: readonly Vec2[], fromProgress: number, toProgress: number): Vec2[] {
  if (polyline.length < 2) {
    return polyline.map((point) => ({ ...point }));
  }
  const samples = samplePolyline(polyline, 32);
  const start = Math.max(0, Math.min(1, fromProgress));
  const end = Math.max(0, Math.min(1, toProgress));
  const startIndex = Math.round(start * (samples.length - 1));
  const endIndex = Math.round(end * (samples.length - 1));
  if (startIndex === endIndex) {
    return [{ ...samples[startIndex]! }];
  }
  const step = startIndex < endIndex ? 1 : -1;
  const sliced: Vec2[] = [];
  for (let index = startIndex; step > 0 ? index <= endIndex : index >= endIndex; index += step) {
    sliced.push({ ...samples[index]! });
  }
  return sliced;
}

function samplePolyline(polyline: readonly Vec2[], count: number): Vec2[] {
  const total = polylineLength(polyline);
  if (total <= 0) {
    return polyline.map((point) => ({ ...point }));
  }
  const samples: Vec2[] = [];
  for (let index = 0; index < count; index += 1) {
    const progress = count === 1 ? 0 : index / (count - 1);
    samples.push(pointAtProgress(polyline, progress));
  }
  return samples;
}

function pointAtProgress(polyline: readonly Vec2[], progress: number): Vec2 {
  const total = polylineLength(polyline);
  let remaining = Math.max(0, Math.min(1, progress)) * total;
  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1];
    const b = polyline[index];
    if (!a || !b) {
      continue;
    }
    const length = distance2(a, b);
    if (remaining <= length || index === polyline.length - 1) {
      const t = length === 0 ? 0 : remaining / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= length;
  }
  return { ...(polyline[polyline.length - 1] as Vec2) };
}

function reversePolyline(points: readonly Vec2[]): Vec2[] {
  return [...points].reverse().map((point) => ({ ...point }));
}

function appendPolyline(target: Vec2[], next: readonly Vec2[]) {
  for (const point of next) {
    const last = target[target.length - 1];
    if (!last || distance2(last, point) > 1e-6) {
      target.push({ ...point });
    }
  }
}

function collapseClose(points: readonly Vec2[], minDistance: number): Vec2[] {
  const collapsed: Vec2[] = [];
  for (const point of points) {
    const last = collapsed[collapsed.length - 1];
    if (!last || distance2(last, point) >= minDistance) {
      collapsed.push({ ...point });
    }
  }
  return collapsed;
}
