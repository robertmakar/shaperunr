import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { boundingBox2, pointsInUnitSquare, type Vec2 } from '@/lib/geometry';
import { flattenLetterStrokes, getLetterShape } from '@/lib/letter-shapes';
import { runLetterShapeVariantSelfTests } from '@/lib/letter-shapes-variants.self-test';
import { scoreRouteAgainstShape } from '@/lib/shape-match';
import { runShapeMatchSelfTests } from '@/lib/shape-match.self-test';
import {
  dimensionsForTargetLength,
  distanceMeters,
  offsetCoordinate,
  projectShapeToGeographic,
} from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

export type SelfTestResult = {
  name: string;
  passed: boolean;
  detail: string;
};

export function runShapePocSelfTests(): SelfTestResult[] {
  return [
    ...letterTests(['A', 'O', 'R', 'B', 'Z']),
    wordTest(),
    projectionTest(),
    ...matchingTests(),
    ...runShapeMatchSelfTests(),
    ...runLetterShapeVariantSelfTests(),
  ];
}

export function asciiPreview(points: readonly Vec2[], width = 36, height = 10): string {
  const bounds = boundingBox2(points);
  if (!bounds || points.length === 0) {
    return '';
  }

  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
  const plot = (x: number, y: number) => {
    const col = Math.round(((x - bounds.minX) / (bounds.width || 1)) * (width - 1));
    const row = Math.round((1 - (y - bounds.minY) / (bounds.height || 1)) * (height - 1));
    const cell = grid[row];
    if (cell && col >= 0 && col < width) {
      cell[col] = '#';
    }
  };

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) {
      continue;
    }
    const steps = Math.max(2, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) * Math.max(width, height)));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      plot(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t);
    }
  }

  return grid.map((row) => row.join('')).join('\n');
}

function letterTests(letters: string[]): SelfTestResult[] {
  return letters.map((char) => {
    const shape = getLetterShape(char);
    if (!shape) {
      return { name: `letter ${char}`, passed: false, detail: 'missing shape' };
    }
    const points = flattenLetterStrokes(shape);
    const inSquare = pointsInUnitSquare(points);
    const bounds = boundingBox2(points);
    const closed = isClosed(points);
    const extra =
      char === 'O'
        ? ` closed=${closed}`
        : char === 'Z'
          ? ` top-to-bottom=${(points[0]?.y ?? 0) > 0.8 && (points[points.length - 1]?.y ?? 1) < 0.2}`
          : '';

    return {
      name: `letter ${char}`,
      passed: inSquare && points.length >= 3 && (bounds?.height ?? 0) > 0.5,
      detail: `${points.length} pts, ${shape.strokes.length} stroke(s), in-unit=${inSquare}${extra}`,
    };
  });
}

function wordTest(): SelfTestResult {
  const shape = buildWordShape('ROBZ');
  const inSquare = pointsInUnitSquare(shape.points);
  const fourLetters = shape.letters.length === 4;
  const widerThanTall = shape.width > shape.height;
  return {
    name: 'word ROBZ',
    passed: inSquare && fourLetters && widerThanTall && shape.points.length > 20,
    detail: `${shape.letters.map((letter) => letter.char).join('')} ${shape.points.length} pts w=${shape.width.toFixed(2)} h=${shape.height.toFixed(2)} aspect=${shape.aspectRatio.toFixed(2)}`,
  };
}

function projectionTest(): SelfTestResult {
  const cairo = DEVELOPMENT_FALLBACK_LOCATION;
  const east = offsetCoordinate(cairo, 1000, 0);
  const north = offsetCoordinate(cairo, 0, 1000);
  const eastError = Math.abs(distanceMeters(cairo, east) - 1000);
  const northError = Math.abs(distanceMeters(cairo, north) - 1000);
  const lngGrewLessThanLat = Math.abs(east.longitude - cairo.longitude) > Math.abs(north.latitude - cairo.latitude);

  const word = buildWordShape('ROBZ');
  const size = dimensionsForTargetLength(word, 4000);
  const projected = projectShapeToGeographic(word.points, {
    center: cairo,
    widthMeters: size.widthMeters,
    heightMeters: size.heightMeters,
  });
  const lengthError = Math.abs(projected.lengthMeters - 4000);

  return {
    name: 'projection Cairo 1 km / ROBZ 4 km',
    passed: eastError < 15 && northError < 15 && lngGrewLessThanLat && lengthError < 80,
    detail: `eastΔ=${eastError.toFixed(1)}m northΔ=${northError.toFixed(1)}m pathΔ=${lengthError.toFixed(1)}m width=${size.widthMeters.toFixed(0)}m height=${size.heightMeters.toFixed(0)}m`,
  };
}

function matchingTests(): SelfTestResult[] {
  const cairo = DEVELOPMENT_FALLBACK_LOCATION;
  const word = buildWordShape('ROBZ');
  const size = dimensionsForTargetLength(word, 4000);
  const target = projectShapeToGeographic(word.points, {
    center: cairo,
    widthMeters: size.widthMeters,
    heightMeters: size.heightMeters,
  }).coordinates;

  const identical = scoreRouteAgainstShape(target, target);
  const distorted = scoreRouteAgainstShape(
    target.map((point, index) =>
      offsetCoordinate(point, index % 2 === 0 ? 18 : -12, index % 3 === 0 ? 14 : -10),
    ),
    target,
  );
  const different = scoreRouteAgainstShape(
    [
      offsetCoordinate(cairo, 2500, 800),
      offsetCoordinate(cairo, 2800, 800),
      offsetCoordinate(cairo, 2800, 1100),
    ],
    target,
  );

  return [
    {
      name: 'match identical',
      passed: identical.score >= 0.97 && identical.coverage >= 0.99 && identical.distanceError < 2,
      detail: `score=${identical.score.toFixed(3)} coverage=${identical.coverage.toFixed(3)} distErr=${identical.distanceError.toFixed(1)}m`,
    },
    {
      name: 'match slight distortion',
      passed:
        distorted.score < identical.score &&
        distorted.score >= 0.7 &&
        distorted.coverage >= 0.85,
      detail: `score=${distorted.score.toFixed(3)} coverage=${distorted.coverage.toFixed(3)} distErr=${distorted.distanceError.toFixed(1)}m`,
    },
    {
      name: 'match very different',
      passed: different.score < distorted.score && different.score < 0.55,
      detail: `score=${different.score.toFixed(3)} coverage=${different.coverage.toFixed(3)} distErr=${different.distanceError.toFixed(1)}m`,
    },
  ];
}

function isClosed(points: Vec2[]): boolean {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return false;
  }
  return Math.hypot(first.x - last.x, first.y - last.y) < 0.05;
}
