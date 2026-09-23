import { boundingBox2, distance2 } from '@/lib/geometry';
import {
  flattenLetterStrokes,
  getLetterShape,
  getLetterShapeVariant,
  getSupportedLetters,
} from '@/lib/letter-shapes';
import { buildWordShape } from '@/lib/word-shape';

export type SelfTestResult = {
  name: string;
  passed: boolean;
  detail: string;
};

/** The letters this task gives an angular polygonal approximation. */
const ANGULAR_LETTERS = ['C', 'G', 'J', 'O', 'Q', 'S', 'U'];
/** Letters explicitly required to stay untouched by this task. */
const UNCHANGED_LETTERS = ['A', 'B', 'D', 'E', 'F', 'H', 'I', 'K', 'L', 'M', 'N', 'P', 'R', 'T', 'V', 'W', 'X', 'Z'];

export function runLetterShapeVariantSelfTests(): SelfTestResult[] {
  return [
    ...everyLetterHasSmooth(),
    ...everyAngularLetterHasDistinctAngular(),
    ...unchangedLettersFallBackToSmooth(),
    angularOIsClosed(),
    angularOHasNonZeroBounds(),
    angularUHasOpenTop(),
    angularQRetainsTail(),
    angularGRetainsOpeningAndBar(),
    angularCRemainsOpen(),
    angularJRemainsRecognizable(),
    hybridFallsBackToSmooth(),
    ...wordConstructionWorksWithEachVariant(),
    defaultBuildWordShapeUnchanged(),
  ];
}

function everyLetterHasSmooth(): SelfTestResult[] {
  return getSupportedLetters().map((letter) => {
    const shape = getLetterShape(letter);
    return {
      name: `smooth: ${letter} has a smooth representation`,
      passed: shape != null && shape.strokes.length > 0,
      detail: shape ? `${shape.strokes.length} stroke(s)` : 'missing',
    };
  });
}

function everyAngularLetterHasDistinctAngular(): SelfTestResult[] {
  return ANGULAR_LETTERS.map((letter) => {
    const smooth = getLetterShape(letter);
    const angular = getLetterShapeVariant(letter, 'angular');
    const smoothFlat = smooth ? flattenLetterStrokes(smooth) : [];
    const angularFlat = angular ? flattenLetterStrokes(angular) : [];
    const distinct = JSON.stringify(smoothFlat) !== JSON.stringify(angularFlat);
    return {
      name: `angular: ${letter} has a distinct angular representation`,
      passed: angular != null && angular.strokes.length > 0 && distinct,
      detail: `smooth ${smoothFlat.length} pts vs angular ${angularFlat.length} pts`,
    };
  });
}

function unchangedLettersFallBackToSmooth(): SelfTestResult[] {
  return UNCHANGED_LETTERS.map((letter) => {
    const smooth = getLetterShape(letter);
    const angular = getLetterShapeVariant(letter, 'angular');
    const same = JSON.stringify(smooth) === JSON.stringify(angular);
    return {
      name: `angular fallback: ${letter} (already straight-segment) is unchanged by the angular variant`,
      passed: same,
      detail: same ? 'identical to smooth' : 'differs from smooth',
    };
  });
}

function angularOIsClosed(): SelfTestResult {
  const shape = getLetterShapeVariant('O', 'angular');
  const points = shape ? flattenLetterStrokes(shape) : [];
  const first = points[0];
  const last = points[points.length - 1];
  const closed = Boolean(first && last && distance2(first, last) < 1e-6);
  return {
    name: 'angular O is a closed loop',
    passed: closed,
    detail: `first=${JSON.stringify(first)} last=${JSON.stringify(last)}`,
  };
}

function angularOHasNonZeroBounds(): SelfTestResult {
  const shape = getLetterShapeVariant('O', 'angular');
  const points = shape ? flattenLetterStrokes(shape) : [];
  const bounds = boundingBox2(points);
  const passed = Boolean(bounds && bounds.width > 0.5 && bounds.height > 0.5);
  return {
    name: 'angular O remains recognizable (non-zero area/bounds)',
    passed,
    detail: bounds ? `width=${bounds.width.toFixed(2)} height=${bounds.height.toFixed(2)}` : 'no bounds',
  };
}

function angularUHasOpenTop(): SelfTestResult {
  const shape = getLetterShapeVariant('U', 'angular');
  const points = shape ? flattenLetterStrokes(shape) : [];
  const first = points[0];
  const last = points[points.length - 1];
  const bothNearTop = Boolean(first && last && first.y > 0.9 && last.y > 0.9);
  const notConnected = Boolean(first && last && distance2(first, last) > 0.3);
  return {
    name: 'angular U has the expected open top',
    passed: bothNearTop && notConnected,
    detail: `first=${JSON.stringify(first)} last=${JSON.stringify(last)}`,
  };
}

function angularQRetainsTail(): SelfTestResult {
  const shape = getLetterShapeVariant('Q', 'angular');
  const tailStroke = shape?.strokes[shape.strokes.length - 1];
  const tailEnd = tailStroke?.[tailStroke.length - 1];
  // The tail is unchanged from the smooth Q: a short diagonal ending around (0.88, 0.04), well outside the O loop's own bounds.
  const passed = Boolean(shape && shape.strokes.length >= 2 && tailEnd && tailEnd.x > 0.8 && tailEnd.y < 0.15);
  return {
    name: 'angular Q retains its diagonal tail',
    passed,
    detail: `strokes=${shape?.strokes.length ?? 0} tailEnd=${JSON.stringify(tailEnd)}`,
  };
}

function angularGRetainsOpeningAndBar(): SelfTestResult {
  const shape = getLetterShapeVariant('G', 'angular');
  const points = shape ? flattenLetterStrokes(shape) : [];
  const first = points[0];
  const last = points[points.length - 1];
  // Open (not a closed O) and has a second, short inward stroke (the bar).
  const open = Boolean(first && last && distance2(first, last) > 0.05);
  const hasBar = (shape?.strokes.length ?? 0) >= 2;
  return {
    name: 'angular G retains its opening and inward bar',
    passed: open && hasBar,
    detail: `strokes=${shape?.strokes.length ?? 0} open=${open}`,
  };
}

function angularCRemainsOpen(): SelfTestResult {
  const shape = getLetterShapeVariant('C', 'angular');
  const points = shape ? flattenLetterStrokes(shape) : [];
  const first = points[0];
  const last = points[points.length - 1];
  const open = Boolean(first && last && distance2(first, last) > 0.05);
  return {
    name: 'angular C remains open',
    passed: open,
    detail: `first=${JSON.stringify(first)} last=${JSON.stringify(last)}`,
  };
}

function angularJRemainsRecognizable(): SelfTestResult {
  const shape = getLetterShapeVariant('J', 'angular');
  const points = shape ? flattenLetterStrokes(shape) : [];
  const first = points[0];
  // Top-left of the bar, matching the unmodified stem/bar of the smooth J.
  const stemIntact = Boolean(first && Math.abs(first.x - 0.2) < 1e-6 && Math.abs(first.y - 1) < 1e-6);
  const hasHook = points.length >= 6;
  return {
    name: 'angular J remains recognizable (unchanged stem/bar plus a hook)',
    passed: stemIntact && hasHook,
    detail: `first=${JSON.stringify(first)} points=${points.length}`,
  };
}

function hybridFallsBackToSmooth(): SelfTestResult {
  const smooth = getLetterShape('O');
  const hybrid = getLetterShapeVariant('O', 'hybrid');
  const same = JSON.stringify(smooth) === JSON.stringify(hybrid);
  return {
    name: "'hybrid' is not implemented this iteration and conservatively falls back to smooth",
    passed: same,
    detail: same ? 'identical to smooth' : 'differs from smooth',
  };
}

function wordConstructionWorksWithEachVariant(): SelfTestResult[] {
  const variants: Array<'smooth' | 'angular' | 'hybrid'> = ['smooth', 'angular', 'hybrid'];
  return variants.map((variant) => {
    const shape = buildWordShape('ROBZ', { letterVariant: variant });
    const passed = shape.letters.length === 4 && shape.points.length > 8 && shape.width > 0 && shape.height > 0;
    return {
      name: `buildWordShape works with letterVariant='${variant}'`,
      passed,
      detail: `letters=${shape.letters.length} points=${shape.points.length} w=${shape.width.toFixed(2)} h=${shape.height.toFixed(2)}`,
    };
  });
}

function defaultBuildWordShapeUnchanged(): SelfTestResult {
  const withoutOptions = buildWordShape('ROBZ');
  const explicitSmooth = buildWordShape('ROBZ', { letterVariant: 'smooth' });
  const same = JSON.stringify(withoutOptions) === JSON.stringify(explicitSmooth);
  return {
    name: 'default buildWordShape() behavior is unchanged (identical to explicit letterVariant: smooth)',
    passed: same,
    detail: same ? 'identical' : 'diverged from smooth default',
  };
}
