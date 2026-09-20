import { vec2, type Vec2 } from '@/lib/geometry';

export type LetterStroke = Vec2[];

export type LetterShape = {
  char: string;
  strokes: LetterStroke[];
};

function line(...pairs: Array<[number, number]>): LetterStroke {
  return pairs.map(([x, y]) => vec2(x, y));
}

function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startDeg: number,
  endDeg: number,
  steps = 14,
): LetterStroke {
  const points: LetterStroke = [];
  const span = endDeg - startDeg;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const deg = startDeg + span * t;
    const rad = (deg * Math.PI) / 180;
    points.push(vec2(cx + Math.cos(rad) * rx, cy + Math.sin(rad) * ry));
  }
  return points;
}

const LETTER_SHAPES: Record<string, LetterStroke[]> = {
  A: [line([0.08, 0], [0.5, 1], [0.92, 0]), line([0.3, 0.38], [0.7, 0.38])],
  B: [
    line(
      [0.14, 0],
      [0.14, 1],
      [0.62, 1],
      [0.82, 0.88],
      [0.82, 0.66],
      [0.6, 0.52],
      [0.14, 0.52],
      [0.64, 0.52],
      [0.88, 0.36],
      [0.88, 0.14],
      [0.64, 0],
      [0.14, 0],
    ),
  ],
  C: [ellipse(0.55, 0.5, 0.42, 0.46, 55, 305, 16)],
  D: [
    line(
      [0.14, 0],
      [0.14, 1],
      [0.58, 1],
      [0.86, 0.78],
      [0.9, 0.5],
      [0.86, 0.22],
      [0.58, 0],
      [0.14, 0],
    ),
  ],
  E: [line([0.86, 1], [0.16, 1], [0.16, 0], [0.86, 0]), line([0.16, 0.5], [0.72, 0.5])],
  F: [line([0.16, 0], [0.16, 1], [0.86, 1]), line([0.16, 0.5], [0.7, 0.5])],
  G: [
    ellipse(0.52, 0.5, 0.4, 0.46, 40, 320, 16).concat(line([0.78, 0.42], [0.52, 0.42])),
  ],
  H: [line([0.16, 0], [0.16, 1]), line([0.84, 0], [0.84, 1]), line([0.16, 0.5], [0.84, 0.5])],
  I: [line([0.5, 1], [0.5, 0])],
  J: [line([0.2, 1], [0.84, 1], [0.84, 0.28]), ellipse(0.52, 0.28, 0.32, 0.26, 0, 180, 10)],
  K: [line([0.16, 0], [0.16, 1]), line([0.84, 1], [0.16, 0.5], [0.84, 0])],
  L: [line([0.18, 1], [0.18, 0], [0.86, 0])],
  M: [line([0.08, 0], [0.08, 1], [0.5, 0.38], [0.92, 1], [0.92, 0])],
  N: [line([0.14, 0], [0.14, 1], [0.86, 0], [0.86, 1])],
  O: [ellipse(0.5, 0.5, 0.4, 0.46, 90, 450, 18)],
  P: [
    line(
      [0.16, 0],
      [0.16, 1],
      [0.7, 1],
      [0.86, 0.86],
      [0.86, 0.62],
      [0.7, 0.48],
      [0.16, 0.48],
    ),
  ],
  Q: [ellipse(0.5, 0.52, 0.4, 0.44, 90, 450, 18), line([0.62, 0.28], [0.88, 0.04])],
  R: [
    line(
      [0.14, 0],
      [0.14, 1],
      [0.7, 1],
      [0.86, 0.86],
      [0.86, 0.64],
      [0.68, 0.5],
      [0.14, 0.5],
      [0.48, 0.5],
      [0.88, 0],
    ),
  ],
  S: [
    line(
      [0.82, 0.84],
      [0.7, 0.96],
      [0.42, 1],
      [0.22, 0.9],
      [0.22, 0.7],
      [0.4, 0.58],
      [0.68, 0.48],
      [0.82, 0.34],
      [0.8, 0.14],
      [0.58, 0],
      [0.3, 0.02],
      [0.16, 0.16],
    ),
  ],
  T: [line([0.08, 1], [0.92, 1]), line([0.5, 1], [0.5, 0])],
  U: [line([0.16, 1], [0.16, 0.32]), ellipse(0.5, 0.32, 0.34, 0.3, 180, 360, 10), line([0.84, 0.32], [0.84, 1])],
  V: [line([0.08, 1], [0.5, 0], [0.92, 1])],
  W: [line([0.04, 1], [0.26, 0], [0.5, 0.55], [0.74, 0], [0.96, 1])],
  X: [line([0.12, 1], [0.88, 0]), line([0.88, 1], [0.12, 0])],
  Y: [line([0.1, 1], [0.5, 0.48], [0.9, 1]), line([0.5, 0.48], [0.5, 0])],
  Z: [line([0.1, 1], [0.9, 1], [0.1, 0], [0.9, 0])],
};

export function getSupportedLetters(): string[] {
  return Object.keys(LETTER_SHAPES).sort();
}

export function getLetterShape(char: string): LetterShape | null {
  const normalized = char.toUpperCase();
  const strokes = LETTER_SHAPES[normalized];
  if (!strokes) {
    return null;
  }

  return {
    char: normalized,
    strokes: strokes.map((stroke) => stroke.map((point) => ({ ...point }))),
  };
}

export function flattenLetterStrokes(shape: LetterShape): Vec2[] {
  const path: Vec2[] = [];

  for (const stroke of shape.strokes) {
    if (stroke.length === 0) {
      continue;
    }
    if (path.length > 0) {
      const previous = path[path.length - 1];
      const next = stroke[0];
      if (previous && next && (previous.x !== next.x || previous.y !== next.y)) {
        path.push({ ...next });
      }
    }
    for (const point of stroke) {
      const last = path[path.length - 1];
      if (!last || last.x !== point.x || last.y !== point.y) {
        path.push({ ...point });
      }
    }
  }

  return path;
}
