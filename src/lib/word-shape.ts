import { boundingBox2, polylineLength, type Vec2 } from '@/lib/geometry';
import { flattenLetterStrokes, getLetterShapeVariant, type LetterShapeVariant } from '@/lib/letter-shapes';

export type WordShapeOptions = {
  /** Gap between adjacent 1×1 letter squares. */
  letterSpacing?: number;
  /**
   * If set, stretch the composed drawing so width/height matches this ratio
   * before unit-square normalization. Leave unset to keep letter proportions.
   */
  aspectRatio?: number;
  normalize?: boolean;
  maxLetters?: number;
  /** Which letter geometry to build the word from. Defaults to 'smooth' — the original geometry — so existing callers are unaffected. */
  letterVariant?: LetterShapeVariant;
};

export type WordLetterLayout = {
  char: string;
  points: Vec2[];
};

export type WordShape = {
  word: string;
  points: Vec2[];
  letters: WordLetterLayout[];
  width: number;
  height: number;
  aspectRatio: number;
  length: number;
};

const DEFAULT_SPACING = 0.28;
const DEFAULT_MAX_LETTERS = 16;

export function buildWordShape(rawWord: string, options: WordShapeOptions = {}): WordShape {
  const letterSpacing = options.letterSpacing ?? DEFAULT_SPACING;
  const normalize = options.normalize ?? true;
  const maxLetters = options.maxLetters ?? DEFAULT_MAX_LETTERS;
  const letterVariant = options.letterVariant ?? 'smooth';
  const word = rawWord
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, maxLetters);

  const letters: WordLetterLayout[] = [];
  const points: Vec2[] = [];
  let cursorX = 0;

  for (const char of word) {
    const shape = getLetterShapeVariant(char, letterVariant);
    if (!shape) {
      continue;
    }

    const letterPoints = flattenLetterStrokes(shape).map((point) => ({
      x: point.x + cursorX,
      y: point.y,
    }));

    appendPolyline(points, letterPoints);
    letters.push({ char, points: letterPoints });
    cursorX += 1 + letterSpacing;
  }

  const stretched = applyAspectRatio(points, options.aspectRatio);
  const stretchedLetters = letters.map((letter) => ({
    char: letter.char,
    points: applyAspectRatio(letter.points, options.aspectRatio, boundingBox2(points)),
  }));

  const bounds = boundingBox2(stretched);
  if (!bounds || stretched.length === 0) {
    return {
      word,
      points: [],
      letters: [],
      width: 0,
      height: 0,
      aspectRatio: 1,
      length: 0,
    };
  }

  if (!normalize) {
    return {
      word,
      points: stretched,
      letters: stretchedLetters,
      width: bounds.width,
      height: bounds.height,
      aspectRatio: bounds.height === 0 ? 1 : bounds.width / bounds.height,
      length: polylineLength(stretched),
    };
  }

  const scale = Math.max(bounds.width, bounds.height) || 1;
  const normalizePoint = (point: Vec2): Vec2 => ({
    x: (point.x - bounds.minX) / scale,
    y: (point.y - bounds.minY) / scale,
  });

  const normalizedPoints = stretched.map(normalizePoint);
  const normalizedLetters = stretchedLetters.map((letter) => ({
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

function appendPolyline(target: Vec2[], next: Vec2[]) {
  if (next.length === 0) {
    return;
  }

  if (target.length > 0) {
    const previous = target[target.length - 1];
    const first = next[0];
    if (previous && first && (previous.x !== first.x || previous.y !== first.y)) {
      target.push({ ...first });
    }
  }

  for (const point of next) {
    const last = target[target.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) {
      target.push({ ...point });
    }
  }
}

function applyAspectRatio(
  points: Vec2[],
  aspectRatio: number | undefined,
  sourceBounds = boundingBox2(points),
): Vec2[] {
  if (aspectRatio == null || !sourceBounds || sourceBounds.height === 0) {
    return points.map((point) => ({ ...point }));
  }

  const current = sourceBounds.width / sourceBounds.height;
  if (current === 0) {
    return points.map((point) => ({ ...point }));
  }

  const scaleX = aspectRatio / current;
  const cx = sourceBounds.minX + sourceBounds.width / 2;

  return points.map((point) => ({
    x: cx + (point.x - cx) * scaleX,
    y: point.y,
  }));
}
