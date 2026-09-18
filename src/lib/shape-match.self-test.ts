import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { boundingBox2, resamplePolyline, type Vec2 } from '@/lib/geometry';
import {
  scorePolylines,
  scoreRouteAgainstShape,
  type ShapeMatchComponents,
  type ShapeMatchResult,
} from '@/lib/shape-match';
import {
  dimensionsForTargetLength,
  offsetCoordinate,
  projectShapeToGeographic,
} from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

export type SelfTestResult = {
  name: string;
  passed: boolean;
  detail: string;
};

const LEGACY_WEIGHTS = {
  proximity: 0.3,
  coverage: 0.26,
  length: 0.22,
  detour: 0.12,
  backtrack: 0.1,
} as const;

export function runShapeMatchSelfTests(): SelfTestResult[] {
  return [
    identicalOrderedPath(),
    slightlyDistortedOrderedPath(),
    reversedSamePoints(),
    strongBacktracking(),
    spatialCoverButReordered(),
    robzGeographicOrder(),
  ];
}

function identicalOrderedPath(): SelfTestResult {
  const target = zShape();
  const result = scorePolylines(target, target);
  return {
    name: 'order: identical path is very high',
    passed:
      result.score >= 0.97 &&
      result.breakdown.order >= 0.95 &&
      result.breakdown.proximity >= 0.97 &&
      result.breakdown.coverage >= 0.99,
    detail: formatBreakdown(result),
  };
}

function slightlyDistortedOrderedPath(): SelfTestResult {
  const target = zShape();
  const distorted = target.map((point, index) => ({
    x: point.x + (index % 2 === 0 ? 0.18 : -0.12),
    y: point.y + (index % 3 === 0 ? 0.14 : -0.1),
  }));
  const identical = scorePolylines(target, target);
  const result = scorePolylines(distorted, target);
  return {
    name: 'order: slight distortion stays high',
    passed:
      result.score < identical.score &&
      result.score >= 0.8 &&
      result.breakdown.order >= 0.75 &&
      result.coverage >= 0.85,
    detail: formatBreakdown(result),
  };
}

function reversedSamePoints(): SelfTestResult {
  const target = zShape();
  const reversed = [...target].reverse();
  const result = scorePolylines(reversed, target);
  const legacy = legacyScore(result.details.components);
  return {
    name: 'order: reversed points score much lower',
    passed:
      result.breakdown.proximity >= 0.9 &&
      result.coverage >= 0.99 &&
      result.breakdown.order <= 0.45 &&
      result.score <= 0.7 &&
      result.score < legacy - 0.12 &&
      result.breakdown.order < result.breakdown.proximity - 0.4,
    detail: `${formatBreakdown(result)} legacy=${legacy.toFixed(3)}`,
  };
}

function strongBacktracking(): SelfTestResult {
  const target = zShape();
  const sampled = resamplePolyline(target, 40);
  const backtracked = [...sampled, ...[...sampled].reverse(), ...sampled];
  const identical = scorePolylines(target, target);
  const result = scorePolylines(backtracked, target);
  return {
    name: 'order: strong backtracking is lower',
    passed:
      result.score < identical.score - 0.15 &&
      result.breakdown.order < identical.breakdown.order - 0.2 &&
      (result.details.backtrackRatio > 0.15 || result.breakdown.order <= 0.55),
    detail: `${formatBreakdown(result)} backtrackRatio=${result.details.backtrackRatio.toFixed(3)}`,
  };
}

function spatialCoverButReordered(): SelfTestResult {
  const target = zShape();
  const sampled = resamplePolyline(target, 60);
  const third = Math.floor(sampled.length / 3);
  const reordered = [
    ...sampled.slice(third * 2),
    ...sampled.slice(0, third),
    ...sampled.slice(third, third * 2),
  ];
  const raster = zigzagCover(target, 7);
  const identical = scorePolylines(target, target);
  const shuffled = scorePolylines(reordered, target);
  const covered = scorePolylines(raster, target);
  return {
    name: 'order: spatial cover / skipped sections rank lower',
    passed:
      shuffled.breakdown.proximity >= 0.85 &&
      shuffled.coverage >= 0.85 &&
      shuffled.breakdown.order < identical.breakdown.order - 0.25 &&
      shuffled.score < identical.score - 0.12 &&
      covered.breakdown.order < identical.breakdown.order - 0.2 &&
      covered.score < identical.score,
    detail: `shuffled ${formatBreakdown(shuffled)} | raster ${formatBreakdown(covered)}`,
  };
}

function robzGeographicOrder(): SelfTestResult {
  const cairo = DEVELOPMENT_FALLBACK_LOCATION;
  const word = buildWordShape('ROBZ');
  const size = dimensionsForTargetLength(word, 4000);
  const target = projectShapeToGeographic(word.points, {
    center: cairo,
    widthMeters: size.widthMeters,
    heightMeters: size.heightMeters,
  }).coordinates;
  const reversed = [...target].reverse();
  const sampled = target.map((point, index) =>
    offsetCoordinate(point, index % 2 === 0 ? 16 : -11, index % 3 === 0 ? 12 : -9),
  );
  const third = Math.floor(target.length / 3);
  const shuffled = [...target.slice(third * 2), ...target.slice(0, third * 2)];

  const identical = scoreRouteAgainstShape(target, target);
  const distorted = scoreRouteAgainstShape(sampled, target);
  const reverse = scoreRouteAgainstShape(reversed, target);
  const reorder = scoreRouteAgainstShape(shuffled, target);
  const reverseLegacy = legacyScore(reverse.details.components);

  return {
    name: 'order: geographic ROBZ reverse/shuffle vs identical',
    passed:
      identical.score >= 0.97 &&
      distorted.score >= 0.75 &&
      reverse.coverage >= 0.99 &&
      reverse.breakdown.order < 0.45 &&
      reverse.score < reverseLegacy - 0.12 &&
      reorder.breakdown.order < identical.breakdown.order - 0.25 &&
      reverse.score < identical.score - 0.2,
    detail:
      `id ${formatBreakdown(identical)} | dist ${formatBreakdown(distorted)} | ` +
      `rev ${formatBreakdown(reverse)} legacy=${reverseLegacy.toFixed(3)} | ` +
      `shuf ${formatBreakdown(reorder)}`,
  };
}

function zShape(): Vec2[] {
  return [
    { x: 0, y: 10 },
    { x: 10, y: 10 },
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ];
}

function zigzagCover(points: readonly Vec2[], rows: number): Vec2[] {
  const box = boundingBox2(points);
  if (!box) {
    return [];
  }
  const result: Vec2[] = [];
  for (let row = 0; row <= rows; row += 1) {
    const y = box.minY + (box.height * row) / rows;
    if (row % 2 === 0) {
      result.push({ x: box.minX, y }, { x: box.maxX, y });
    } else {
      result.push({ x: box.maxX, y }, { x: box.minX, y });
    }
  }
  return result;
}

function legacyScore(components: ShapeMatchComponents): number {
  const total =
    LEGACY_WEIGHTS.proximity +
    LEGACY_WEIGHTS.coverage +
    LEGACY_WEIGHTS.length +
    LEGACY_WEIGHTS.detour +
    LEGACY_WEIGHTS.backtrack;
  return (
    (components.proximity * LEGACY_WEIGHTS.proximity +
      components.coverage * LEGACY_WEIGHTS.coverage +
      components.lengthFit * LEGACY_WEIGHTS.length +
      components.detourFit * LEGACY_WEIGHTS.detour +
      components.continuity * LEGACY_WEIGHTS.backtrack) /
    total
  );
}

function formatBreakdown(result: ShapeMatchResult): string {
  const b = result.breakdown;
  return (
    `final=${b.finalScore.toFixed(3)} prox=${b.proximity.toFixed(3)} cov=${b.coverage.toFixed(3)} ` +
    `order=${b.order.toFixed(3)} len=${b.lengthFit.toFixed(3)} det=${b.detour.toFixed(3)} ` +
    `back=${b.backtrack.toFixed(3)}`
  );
}
