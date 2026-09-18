/**
 * DEVELOPMENT / EXPERIMENTAL. Street-aware placement prefilter.
 *
 * Pure CPU: takes an in-memory pedestrian graph and scores many placements
 * of a word drawing against it. Does not call Valhalla.
 */
import {
  boundingBox2,
  polylineLength,
  resamplePolyline,
  type Vec2,
} from '@/lib/geometry';
import { scoreOrderedPath } from '@/lib/shape-order';
import { dimensionsForTargetLength } from '@/lib/shape-projection';
import { buildWordShape, type WordShape } from '@/lib/word-shape';

import {
  aggregateRegion,
  analyzeWaySamples,
  detectCoverageGaps,
  projectOntoTarget,
  regionsFromLetterLengths,
  STREET_FIT,
  summarizeStreetFit,
  usableSamples,
  type AnalyzedWay,
  type RegionFit,
} from '../diagnostics/street-fit';

export const STREET_FIT_SEARCH = {
  rotationStepDegrees: 22.5,
  rotationCount: 16,
  scales: [0.6, 0.8, 1.0, 1.2, 1.4],
  translationRadiusMeters: 800,
  translationRingsMeters: [0, 400, 800],
  headingsPerRing: 8,
  maxPlacements: 1360,
  rankCount: 15,
  routeTopCount: 5,
  passThreshold: 0.3,
  chainJumpMeters: 90,
} as const;

export const STREET_FIT_SCORE_WEIGHTS = {
  proximity: 0.14,
  heading: 0.2,
  forward: 0.16,
  coverage: 0.14,
  gap: 0.1,
  connected: 0.14,
  purity: 0.12,
} as const;

export type TranslationOffset = {
  eastMeters: number;
  northMeters: number;
};

export type StreetFitPlacement = {
  id: string;
  rotationDegrees: number;
  scale: number;
  eastMeters: number;
  northMeters: number;
  distanceFromStartMeters: number;
};

export type StreetGraphWay = {
  wayId: string;
  points: Vec2[];
};

export type LetterFitScore = {
  id: string;
  score: number;
  coverage: number;
  headingDegrees: number | null;
  maxGapMeters: number;
  forward: number;
  usableEdgeCount: number;
  feasible: boolean;
  order: number;
};

export type StreetFitPlacementResult = {
  placement: StreetFitPlacement;
  score: number;
  maxGapMeters: number;
  forwardProgress: number;
  usableEdgeCount: number;
  connectedPathFeasible: boolean;
  coverage: number;
  purity: number;
  meanPerpendicularDistance: number;
  headingDegrees: number | null;
  letters: LetterFitScore[];
  target: Vec2[];
  alignedWays: AnalyzedWay[];
};

export function buildStreetFitPlacements(
  options: Partial<{
    rotationCount: number;
    rotationStepDegrees: number;
    scales: readonly number[];
    translationRingsMeters: readonly number[];
    headingsPerRing: number;
    maxPlacements: number;
  }> = {},
): StreetFitPlacement[] {
  const rotationCount = options.rotationCount ?? STREET_FIT_SEARCH.rotationCount;
  const rotationStep = options.rotationStepDegrees ?? STREET_FIT_SEARCH.rotationStepDegrees;
  const scales = options.scales ?? STREET_FIT_SEARCH.scales;
  const rings = options.translationRingsMeters ?? STREET_FIT_SEARCH.translationRingsMeters;
  const headingsPerRing = options.headingsPerRing ?? STREET_FIT_SEARCH.headingsPerRing;
  const cap = options.maxPlacements ?? STREET_FIT_SEARCH.maxPlacements;

  const rotations = Array.from({ length: rotationCount }, (_, index) => round1(index * rotationStep));
  const translations = buildTranslationOffsets(rings, headingsPerRing);
  const placements: StreetFitPlacement[] = [];

  for (const rotationDegrees of rotations) {
    for (const scale of scales) {
      for (const offset of translations) {
        placements.push({
          id: placementId(rotationDegrees, scale, offset.eastMeters, offset.northMeters),
          rotationDegrees,
          scale,
          eastMeters: round1(offset.eastMeters),
          northMeters: round1(offset.northMeters),
          distanceFromStartMeters: round1(Math.hypot(offset.eastMeters, offset.northMeters)),
        });
      }
    }
  }

  return placements.slice(0, cap);
}

export function buildTranslationOffsets(
  rings: readonly number[] = STREET_FIT_SEARCH.translationRingsMeters,
  headingsPerRing: number = STREET_FIT_SEARCH.headingsPerRing,
): TranslationOffset[] {
  const offsets: TranslationOffset[] = [];
  for (const radius of rings) {
    if (radius === 0) {
      offsets.push({ eastMeters: 0, northMeters: 0 });
      continue;
    }
    for (let index = 0; index < headingsPerRing; index += 1) {
      const radians = ((index * 360) / headingsPerRing) * (Math.PI / 180);
      offsets.push({
        eastMeters: radius * Math.sin(radians),
        northMeters: radius * Math.cos(radians),
      });
    }
  }
  return offsets;
}

export function translatePolyline(points: readonly Vec2[], eastMeters: number, northMeters: number): Vec2[] {
  return points.map((point) => ({ x: point.x + eastMeters, y: point.y + northMeters }));
}

export function projectWordPlacement(
  word: WordShape,
  targetDistanceMeters: number,
  placement: Pick<StreetFitPlacement, 'rotationDegrees' | 'scale' | 'eastMeters' | 'northMeters'>,
): { target: Vec2[]; letters: Array<{ id: string; points: Vec2[]; length: number }> } {
  const base = dimensionsForTargetLength(word, targetDistanceMeters);
  const widthMeters = base.widthMeters * placement.scale;
  const heightMeters = base.heightMeters * placement.scale;
  const bounds = boundingBox2(word.points);
  const projected = localProjectPoints(word.points, bounds, widthMeters, heightMeters, placement.rotationDegrees);
  const origin = projected[0] ?? { x: 0, y: 0 };
  const target = translatePolyline(
    projected.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y })),
    placement.eastMeters,
    placement.northMeters,
  );
  const letters = word.letters.map((letter) => {
    const letterProjected = localProjectPoints(
      letter.points,
      bounds,
      widthMeters,
      heightMeters,
      placement.rotationDegrees,
    ).map((point) => ({
      x: point.x - origin.x + placement.eastMeters,
      y: point.y - origin.y + placement.northMeters,
    }));
    return {
      id: letter.char,
      points: letterProjected,
      length: polylineLength(letterProjected),
    };
  });
  return { target, letters };
}

export function scoreStreetFitPlacement(
  target: readonly Vec2[],
  letters: Array<{ id: string; length: number }>,
  graph: readonly StreetGraphWay[],
): Omit<StreetFitPlacementResult, 'placement' | 'target'> {
  const targetLength = polylineLength(target);
  if (target.length < 2 || targetLength <= 0) {
    return emptyResult();
  }

  const targetBox = boundingBox2(target);
  const pad = STREET_FIT.nearbyRadiusMeters;
  const nearbyWays = graph
    .filter((way) => boxesOverlap(targetBox, boundingBox2(way.points), pad))
    .map((way) => ({
      wayId: way.wayId,
      points: way.points.filter(
        (point) => projectOntoTarget(point, target).perpendicularDistance <= STREET_FIT.nearbyRadiusMeters,
      ),
    }))
    .filter((way) => way.points.length > 0);

  const analyzed = nearbyWays
    .map((way) => analyzeWaySamples(way.wayId, way.points, target))
    .filter((way) => way.samples.length > 0);

  const aligned = analyzed
    .map((way) => ({
      ...way,
      samples: usableSamples(way.samples),
    }))
    .filter((way) => way.samples.length >= 2);

  const regions = regionsFromLetterLengths(letters);
  const regionFits = regions.map((region) => aggregateRegion(region, aligned, targetLength));
  const summary = summarizeStreetFit(regionFits, aligned, targetLength);
  const nearbyLength = analyzed.reduce((sum, way) => sum + way.lengthMeters, 0);
  const alignedLength = aligned.reduce((sum, way) => sum + polylineLength(way.samples.map((sample) => sample.point)), 0);
  const purity = nearbyLength <= 1e-6 ? 0 : clamp01(alignedLength / nearbyLength);
  const spanGaps = detectCoverageGaps(spanProgresses(aligned), targetLength);
  const coverage = spanGaps.coverage;
  const maxGapMeters = spanGaps.maxGapMeters;

  const chain = greedyProgressChain(aligned);
  const chainOrder =
    chain.points.length >= 2
      ? scoreOrderedPath(
          resamplePolyline(chain.points, 48),
          resamplePolyline(target, 48),
          target,
          {
            orderDistanceScale: Math.max(targetLength * 0.04, 40),
            coverageThreshold: STREET_FIT.usableRadiusMeters,
          },
        ).order
      : 0;

  const letterScores = regionFits.map((region, index) => {
    const letterWays = aligned.filter((way) =>
      way.samples.some((sample) => sample.progress >= region.startProgress && sample.progress <= region.endProgress),
    );
    const letterChain = greedyProgressChain(letterWays, region.startProgress, region.endProgress);
    const letterTarget = sliceByProgress(target, region.startProgress, region.endProgress);
    const order =
      letterChain.points.length >= 2 && letterTarget.length >= 2
        ? scoreOrderedPath(
            resamplePolyline(letterChain.points, 24),
            resamplePolyline(letterTarget, 24),
            letterTarget,
            {
              orderDistanceScale: Math.max(region.targetLengthMeters * 0.08, 30),
              coverageThreshold: STREET_FIT.usableRadiusMeters,
            },
          ).order
        : 0;
    const heading = region.meanHeadingAgreement;
    const letterScore = clamp01(
      0.34 * region.coverage +
        0.22 * (heading ?? 0) +
        0.18 * region.forwardCoverage +
        0.14 * order +
        0.12 * (region.plausibleContinuousPath ? 1 : 0),
    );
    return {
      id: region.id || letters[index]?.id || String(index),
      score: letterScore,
      coverage: region.coverage,
      headingDegrees: heading == null ? null : (1 - heading) * 90,
      maxGapMeters: region.maxGapMeters,
      forward: region.forwardCoverage,
      usableEdgeCount: region.usableWayCount,
      feasible: region.plausibleContinuousPath || letterChain.feasible,
      order,
    };
  });

  const proximity = Number.isFinite(summary.meanBestDistance)
    ? clamp01(1 - summary.meanBestDistance / STREET_FIT.usableRadiusMeters)
    : 0;
  const heading = mean(aligned.map((way) => way.meanHeadingAgreement).filter((value): value is number => value != null));
  const forward = mean(aligned.map((way) => way.forwardRatio).filter((value): value is number => value != null));
  const gapFit = clamp01(1 - maxGapMeters / Math.max(targetLength * 0.35, 1));
  const connected =
    letterScores.length === 0
      ? 0
      : mean(letterScores.map((letter) => (letter.feasible ? 0.5 + 0.5 * letter.order : 0.15 * letter.order)));

  const score = clamp01(
    STREET_FIT_SCORE_WEIGHTS.proximity * proximity +
      STREET_FIT_SCORE_WEIGHTS.heading * (heading || 0) +
      STREET_FIT_SCORE_WEIGHTS.forward * (forward || 0) +
    STREET_FIT_SCORE_WEIGHTS.coverage * coverage +
      STREET_FIT_SCORE_WEIGHTS.gap * gapFit +
      STREET_FIT_SCORE_WEIGHTS.connected * connected +
      STREET_FIT_SCORE_WEIGHTS.purity * purity,
  );

  return {
    score,
    maxGapMeters,
    forwardProgress: forward || 0,
    usableEdgeCount: summary.usableWayCount,
    connectedPathFeasible: connected >= 0.45 && chainOrder >= 0.35 && coverage >= 0.35,
    coverage,
    purity,
    meanPerpendicularDistance: summary.meanBestDistance,
    headingDegrees: heading ? (1 - heading) * 90 : null,
    letters: letterScores,
    alignedWays: aligned,
  };
}

export function rankStreetFitPlacements(input: {
  word: string | WordShape;
  targetDistanceMeters: number;
  graph: readonly StreetGraphWay[];
  placements?: StreetFitPlacement[];
}): StreetFitPlacementResult[] {
  const word = typeof input.word === 'string' ? buildWordShape(input.word) : input.word;
  const placements = input.placements ?? buildStreetFitPlacements();
  const ranked: StreetFitPlacementResult[] = [];

  for (const placement of placements) {
    const projected = projectWordPlacement(word, input.targetDistanceMeters, placement);
    const scored = scoreStreetFitPlacement(
      projected.target,
      projected.letters.map((letter) => ({ id: letter.id, length: letter.length })),
      input.graph,
    );
    ranked.push({
      placement,
      ...scored,
      target: projected.target,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.placement.id.localeCompare(b.placement.id);
  });
  return ranked;
}

export function placementsWithinBounds(
  placements: readonly StreetFitPlacement[],
  radiusMeters = STREET_FIT_SEARCH.translationRadiusMeters,
): boolean {
  return placements.every((placement) => placement.distanceFromStartMeters <= radiusMeters + 1e-6);
}

function localProjectPoints(
  points: readonly Vec2[],
  bounds: ReturnType<typeof boundingBox2>,
  widthMeters: number,
  heightMeters: number,
  rotationDegrees: number,
): Vec2[] {
  if (!bounds) {
    return points.map((point) => ({ ...point }));
  }
  const cx = bounds.minX + bounds.width / 2;
  const cy = bounds.minY + bounds.height / 2;
  const radians = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map((point) => {
    const east = bounds.width === 0 ? 0 : ((point.x - cx) / bounds.width) * widthMeters;
    const north = bounds.height === 0 ? 0 : ((point.y - cy) / bounds.height) * heightMeters;
    return {
      x: east * cos - north * sin,
      y: east * sin + north * cos,
    };
  });
}

function greedyProgressChain(
  ways: readonly AnalyzedWay[],
  startProgress = 0,
  endProgress = 1,
): { points: Vec2[]; feasible: boolean; maxGap: number } {
  const spans = ways
    .map((way) => {
      const samples = [...usableSamples(way.samples)]
        .filter((sample) => sample.progress >= startProgress - 0.02 && sample.progress <= endProgress + 0.02)
        .sort((a, b) => a.progress - b.progress);
      if (samples.length < 2) {
        return null;
      }
      return {
        wayId: way.wayId,
        samples,
        minProgress: samples[0]!.progress,
        maxProgress: samples[samples.length - 1]!.progress,
      };
    })
    .filter((span): span is NonNullable<typeof span> => span != null)
    .sort((a, b) => a.minProgress - b.minProgress);

  if (spans.length === 0) {
    return { points: [], feasible: false, maxGap: endProgress - startProgress };
  }

  const used = new Set<string>();
  const picked: typeof spans = [];
  let cursor = startProgress;
  let lastPoint: Vec2 | null = null;
  let guard = 0;
  while (guard < spans.length) {
    guard += 1;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [index, span] of spans.entries()) {
      if (used.has(span.wayId)) {
        continue;
      }
      if (span.maxProgress <= cursor + 0.01) {
        continue;
      }
      if (span.minProgress > cursor + (lastPoint ? 0.22 : 0.35)) {
        continue;
      }
      const first = span.samples[0];
      if (!first) {
        continue;
      }
      const jump = lastPoint ? Math.hypot(first.point.x - lastPoint.x, first.point.y - lastPoint.y) : 0;
      if (jump > STREET_FIT_SEARCH.chainJumpMeters) {
        continue;
      }
      const progressGap = Math.max(0, span.minProgress - cursor);
      const score = progressGap * 400 + jump;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) {
      break;
    }
    const next = spans[bestIndex]!;
    used.add(next.wayId);
    picked.push(next);
    cursor = next.maxProgress;
    lastPoint = next.samples[next.samples.length - 1]?.point ?? lastPoint;
    if (cursor >= endProgress - 0.03) {
      break;
    }
  }

  const points = picked.flatMap((span) => span.samples.map((sample) => sample.point));
  const spanValues: number[] = [];
  for (const span of picked) {
    const start = (span.minProgress - startProgress) / Math.max(endProgress - startProgress, 1e-6);
    const end = (span.maxProgress - startProgress) / Math.max(endProgress - startProgress, 1e-6);
    const steps = Math.max(2, Math.round((end - start) * 16));
    for (let index = 0; index <= steps; index += 1) {
      spanValues.push(start + ((end - start) * index) / steps);
    }
  }
  const gaps = detectCoverageGaps(spanValues, 1, 16);
  return {
    points,
    feasible: picked.length >= 1 && gaps.coverage >= 0.4 && gaps.maxGapMeters <= 0.35,
    maxGap: gaps.maxGapMeters,
  };
}

function boxesOverlap(
  a: ReturnType<typeof boundingBox2>,
  b: ReturnType<typeof boundingBox2>,
  pad: number,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.minX - pad <= b.maxX && a.maxX + pad >= b.minX && a.minY - pad <= b.maxY && a.maxY + pad >= b.minY;
}

function spanProgresses(ways: readonly AnalyzedWay[]): number[] {
  const values: number[] = [];
  for (const way of ways) {
    const progresses = usableSamples(way.samples)
      .map((sample) => sample.progress)
      .sort((a, b) => a - b);
    if (progresses.length === 0) {
      continue;
    }
    values.push(...progresses);
    const start = progresses[0] ?? 0;
    const end = progresses[progresses.length - 1] ?? start;
    const steps = Math.max(2, Math.round((end - start) * STREET_FIT.binCount));
    for (let index = 0; index <= steps; index += 1) {
      values.push(start + ((end - start) * index) / steps);
    }
  }
  return values;
}

function sliceByProgress(target: readonly Vec2[], startProgress: number, endProgress: number): Vec2[] {
  const sampled = resamplePolyline(target, 80);
  const start = Math.max(0, Math.floor(startProgress * (sampled.length - 1)));
  const end = Math.min(sampled.length, Math.floor(endProgress * (sampled.length - 1)) + 1);
  const slice = sampled.slice(start, Math.max(end, start + 2));
  return slice.length >= 2 ? slice : [...sampled];
}

function emptyResult(): Omit<StreetFitPlacementResult, 'placement' | 'target'> {
  return {
    score: 0,
    maxGapMeters: Number.POSITIVE_INFINITY,
    forwardProgress: 0,
    usableEdgeCount: 0,
    connectedPathFeasible: false,
    coverage: 0,
    purity: 0,
    meanPerpendicularDistance: Number.POSITIVE_INFINITY,
    headingDegrees: null,
    letters: [],
    alignedWays: [],
  };
}

function placementId(rotation: number, scale: number, east: number, north: number): string {
  return `sf-r${round1(rotation)}-s${scale.toFixed(1)}-e${round1(east)}-n${round1(north)}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
