/**
 * DEVELOPMENT / EXPERIMENTAL. Collects a local pedestrian graph once,
 * ranks street-fit placements on CPU, then routes only the top placements
 * with the existing constructor and scorer.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';
import { type Vec2 } from '@/lib/geometry';
import {
  coordinatesToLocalMeters,
  offsetCoordinate,
  polylineLengthMeters,
} from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

import { config } from '../config';
import { locatePedestrianEdgeSets } from '../routing/valhalla';
import { scoreRouteAgainstShape, shapeScoreBreakdown } from '../scoring/shape-match';
import type { GeneratedRoute, GenerateRoutesResponse, RouteFailure } from '../types';
import { constructOrderedStreetRoute, toConstructionFailure } from './ordered-street-route';
import {
  buildStreetFitPlacements,
  projectWordPlacement,
  rankStreetFitPlacements,
  STREET_FIT_SEARCH,
  type StreetFitPlacementResult,
  type StreetGraphWay,
} from './street-fit-search';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

export const STREET_FIT_COLLECT = {
  radiusMeters: 1400,
  stepMeters: 200,
  locateRadiusMeters: 120,
} as const;

export type StreetFitSearchReport = {
  developmentOnly: true;
  word: string;
  start: Coordinate;
  targetDistanceMeters: number;
  graphWayCount: number;
  graphCollectValhallaCalls: number;
  evaluated: number;
  passed: number;
  ranked: StreetFitPlacementResult[];
  routed: Array<{
    placementId: string;
    rotationDegrees: number;
    scale: number;
    eastMeters: number;
    northMeters: number;
    streetFitScore: number;
    routeDistanceMeters: number | null;
    shapeScore: number | null;
    order: number | null;
    coverage: number | null;
    failure?: string;
  }>;
  routes: GeneratedRoute[];
  failures: RouteFailure[];
  textReport: string;
  svg: string;
  elapsedMs: number;
};

export async function collectPedestrianGraph(
  start: Coordinate,
  options: { radiusMeters?: number; stepMeters?: number; locateRadiusMeters?: number } = {},
): Promise<{ ways: StreetGraphWay[]; valhallaCalls: number }> {
  const radius = options.radiusMeters ?? STREET_FIT_COLLECT.radiusMeters;
  const step = options.stepMeters ?? STREET_FIT_COLLECT.stepMeters;
  const locateRadius = options.locateRadiusMeters ?? STREET_FIT_COLLECT.locateRadiusMeters;
  const samples: Coordinate[] = [];
  for (let east = -radius; east <= radius; east += step) {
    for (let north = -radius; north <= radius; north += step) {
      if (Math.hypot(east, north) > radius + 1) {
        continue;
      }
      samples.push(offsetCoordinate(start, east, north));
    }
  }

  const edgeSets = await locateInChunks(samples, locateRadius);
  const byWay = new Map<string, Vec2[]>();
  for (const set of edgeSets) {
    for (const edge of set.edges) {
      const wayId =
        edge.wayId == null
          ? `anon:${edge.snapped.latitude.toFixed(5)},${edge.snapped.longitude.toFixed(5)}`
          : String(edge.wayId);
      const coordinates = edge.shape && edge.shape.length >= 2 ? edge.shape : [edge.snapped];
      const locals = coordinatesToLocalMeters(start, coordinates);
      const list = byWay.get(wayId) ?? [];
      list.push(...locals);
      byWay.set(wayId, list);
    }
  }

  const ways: StreetGraphWay[] = [...byWay.entries()].map(([wayId, points]) => ({
    wayId,
    points: dedupeClose(points, 10),
  }));
  return { ways, valhallaCalls: Math.ceil(samples.length / 16) };
}

export async function runStreetFitSearchExperiment(input: {
  word: string;
  start: Coordinate;
  targetDistanceMeters: number;
  routeTop?: number;
}): Promise<StreetFitSearchReport> {
  const started = Date.now();
  const word = input.word.toUpperCase().replace(/[^A-Z]/g, '');
  const collected = await collectPedestrianGraph(input.start);
  const placements = buildStreetFitPlacements();
  const rankedAll = rankStreetFitPlacements({
    word,
    targetDistanceMeters: input.targetDistanceMeters,
    graph: collected.ways,
    placements,
  });
  const passed = rankedAll.filter((item) => item.score >= STREET_FIT_SEARCH.passThreshold);
  const ranked = rankedAll.slice(0, STREET_FIT_SEARCH.rankCount);
  const routeTop = rankedAll.slice(0, input.routeTop ?? STREET_FIT_SEARCH.routeTopCount);

  const routed: StreetFitSearchReport['routed'] = [];
  const routes: GeneratedRoute[] = [];
  const failures: RouteFailure[] = [];

  for (const item of routeTop) {
    const projected = projectWordPlacement(buildWordShape(word), input.targetDistanceMeters, item.placement);
    const geographic = projected.target.map((point) => offsetCoordinate(input.start, point.x, point.y));
    try {
      const construction = await constructOrderedStreetRoute({
        start: input.start,
        targetCoordinates: geographic,
      });
      const score = scoreRouteAgainstShape(construction.path.coordinates, geographic);
      const minDistance = input.targetDistanceMeters * (1 - config.distanceToleranceRatio);
      const maxDistance = input.targetDistanceMeters * (1 + config.distanceToleranceRatio);
      const inRange =
        construction.path.distanceMeters >= minDistance && construction.path.distanceMeters <= maxDistance;
      routed.push({
        placementId: item.placement.id,
        rotationDegrees: item.placement.rotationDegrees,
        scale: item.placement.scale,
        eastMeters: item.placement.eastMeters,
        northMeters: item.placement.northMeters,
        streetFitScore: item.score,
        routeDistanceMeters: construction.path.distanceMeters,
        shapeScore: score.score,
        order: score.breakdown.order,
        coverage: score.coverage,
        failure: inRange ? undefined : `distance ${Math.round(construction.path.distanceMeters)} m out of range`,
      });
      if (!inRange) {
        failures.push({
          code: 'DISTANCE_OUT_OF_RANGE',
          message: `Route length ${Math.round(construction.path.distanceMeters)} m is outside ${Math.round(minDistance)}–${Math.round(maxDistance)} m.`,
          candidateId: item.placement.id,
        });
        continue;
      }
      routes.push({
        id: item.placement.id,
        source: 'valhalla',
        developmentOnly: true,
        coordinates: construction.path.coordinates,
        targetCoordinates: geographic,
        distanceMeters: construction.path.distanceMeters,
        shapeScore: score.score,
        coverage: score.coverage,
        scoreBreakdown: shapeScoreBreakdown(score),
        metadata: {
          rotationDegrees: item.placement.rotationDegrees,
          scale: item.placement.scale,
          placement: item.placement.distanceFromStartMeters < 1 ? 'start-anchored' : 'offset',
          offsetAcrossMeters: item.placement.distanceFromStartMeters,
          method: construction.path.method,
          connectedFromStart: construction.connectedFromStart,
          startSnapDistanceMeters: construction.startSnapDistanceMeters,
          lengthError: score.lengthError,
          distanceError: score.distanceError,
          detourRatio: score.details.detourRatio,
          backtrackRatio: score.details.backtrackRatio,
          score,
        },
      });
    } catch (error) {
      const failure = toConstructionFailure(error, item.placement.id);
      failures.push(failure);
      routed.push({
        placementId: item.placement.id,
        rotationDegrees: item.placement.rotationDegrees,
        scale: item.placement.scale,
        eastMeters: item.placement.eastMeters,
        northMeters: item.placement.northMeters,
        streetFitScore: item.score,
        routeDistanceMeters: null,
        shapeScore: null,
        order: null,
        coverage: null,
        failure: failure.message,
      });
    }
  }

  const svg = renderStreetFitSearchSvg(input.start, collected.ways, ranked.slice(0, 5), routes[0] ?? null);
  const textReport = formatStreetFitSearchReport({
    word,
    evaluated: rankedAll.length,
    passed: passed.length,
    graphWayCount: collected.ways.length,
    ranked,
    routed,
  });

  return {
    developmentOnly: true,
    word,
    start: input.start,
    targetDistanceMeters: input.targetDistanceMeters,
    graphWayCount: collected.ways.length,
    graphCollectValhallaCalls: collected.valhallaCalls,
    evaluated: rankedAll.length,
    passed: passed.length,
    ranked,
    routed,
    routes,
    failures,
    textReport,
    svg,
    elapsedMs: Date.now() - started,
  };
}

export async function generateStreetFitExperimentalRoutes(input: {
  word: string;
  start: Coordinate;
  targetDistanceMeters: number;
}): Promise<GenerateRoutesResponse> {
  const experiment = await runStreetFitSearchExperiment(input);
  const wordShape = buildWordShape(input.word);
  const bestTarget = experiment.routes[0]?.targetCoordinates ?? [];
  return {
    source: 'valhalla',
    developmentOnly: true,
    warning: 'DEVELOPMENT ONLY — experimental street-fit placement search. Not shown in Home → Routes → Run.',
    word: wordShape.word,
    wordShape: {
      word: wordShape.word,
      width: wordShape.width,
      height: wordShape.height,
      aspectRatio: wordShape.aspectRatio,
      length: wordShape.length,
    },
    target: {
      coordinates: bestTarget,
      lengthMeters: polylineLengthMeters(bestTarget),
    },
    start: input.start,
    elapsedMs: experiment.elapsedMs,
    routes: experiment.routes.slice(0, config.maxReturnedRoutes),
    failures: experiment.failures,
    search: {
      specCount: experiment.evaluated,
      rotationCount: STREET_FIT_SEARCH.rotationCount,
      placementCount: experiment.evaluated,
      initialScale: STREET_FIT_SEARCH.scales[0] ?? 0.6,
      maxAttempts: 1,
      routedAttempts: experiment.routed.length,
      inRangeCandidates: experiment.routes.length,
      returnedRoutes: Math.min(experiment.routes.length, config.maxReturnedRoutes),
      valhallaCalls: experiment.graphCollectValhallaCalls + experiment.routed.length,
    },
  };
}

export function formatStreetFitSearchReport(input: {
  word: string;
  evaluated: number;
  passed: number;
  graphWayCount: number;
  ranked: StreetFitPlacementResult[];
  routed: StreetFitSearchReport['routed'];
}): string {
  const lines = [
    `${input.word} street-fit placement search`,
    `evaluated ${input.evaluated} placements`,
    `passed threshold ${STREET_FIT_SEARCH.passThreshold} : ${input.passed}`,
    `graph ways ${input.graphWayCount}`,
    '',
    'Top placements:',
  ];
  for (const [index, item] of input.ranked.entries()) {
    const letters = item.letters
      .map((letter) => `${letter.id}:${letter.score.toFixed(2)}/ord ${letter.order.toFixed(2)}`)
      .join(' ');
    lines.push(
      `${String(index + 1).padStart(2, ' ')}. ${item.placement.id}  score ${item.score.toFixed(3)}  rot ${item.placement.rotationDegrees}  scale ${item.placement.scale}  offset ${item.placement.eastMeters},${item.placement.northMeters}  dist ${item.placement.distanceFromStartMeters}m`,
    );
    lines.push(
      `    coverage ${(item.coverage * 100).toFixed(0)}%  gap ${Math.round(item.maxGapMeters)}m  forward ${(item.forwardProgress * 100).toFixed(0)}%  edges ${item.usableEdgeCount}  connected ${item.connectedPathFeasible}  purity ${item.purity.toFixed(2)}`,
    );
    if (letters) {
      lines.push(`    letters ${letters}`);
    }
  }
  lines.push('');
  lines.push('Routed top placements:');
  for (const item of input.routed) {
    lines.push(
      `- ${item.placementId}  street-fit ${item.streetFitScore.toFixed(3)}  route ${item.routeDistanceMeters == null ? '—' : `${Math.round(item.routeDistanceMeters)} m`}  score ${item.shapeScore == null ? '—' : item.shapeScore.toFixed(3)}  order ${item.order == null ? '—' : item.order.toFixed(3)}${item.failure ? `  (${item.failure})` : ''}`,
    );
  }
  return lines.join('\n');
}

export function writeStreetFitSearchSvg(svg: string, filename = 'robz-street-fit-search.svg') {
  const path = resolve(DIAGNOSTIC_DIR, filename);
  writeFileSync(path, svg);
  return path;
}

async function locateInChunks(coordinates: Coordinate[], radius: number) {
  const chunkSize = 16;
  const results: Awaited<ReturnType<typeof locatePedestrianEdgeSets>> = [];
  for (let index = 0; index < coordinates.length; index += chunkSize) {
    const chunk = coordinates.slice(index, index + chunkSize);
    const located = await locatePedestrianEdgeSets(chunk, radius, { verbose: true });
    results.push(...located);
  }
  return results;
}

function dedupeClose(points: Vec2[], meters: number): Vec2[] {
  const unique: Vec2[] = [];
  for (const point of points) {
    if (unique.some((existing) => Math.hypot(existing.x - point.x, existing.y - point.y) < meters)) {
      continue;
    }
    unique.push(point);
  }
  return unique;
}

function renderStreetFitSearchSvg(
  start: Coordinate,
  graph: StreetGraphWay[],
  ranked: StreetFitPlacementResult[],
  bestRoute: GeneratedRoute | null,
): string {
  const best = ranked[0];
  const routeLocal = bestRoute ? coordinatesToLocalMeters(start, bestRoute.coordinates) : [];
  const all = [
    { x: 0, y: 0 },
    ...graph.flatMap((way) => way.points),
    ...ranked.flatMap((item) => item.target),
    ...routeLocal,
  ];
  const xs = all.map((point) => point.x);
  const ys = all.map((point) => point.y);
  const minX = (xs.length === 0 ? 0 : Math.min(...xs)) - 80;
  const maxX = (xs.length === 0 ? 100 : Math.max(...xs)) + 80;
  const minY = (ys.length === 0 ? 0 : Math.min(...ys)) - 80;
  const maxY = (ys.length === 0 ? 100 : Math.max(...ys)) + 120;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const project = (point: Vec2) => ({ x: point.x - minX, y: maxY - point.y });
  const toPoints = (line: Vec2[]) =>
    line
      .map((point) => {
        const projected = project(point);
        return `${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
      })
      .join(' ');

  const graphLines = graph
    .filter((way) => way.points.length >= 2)
    .map(
      (way) =>
        `<polyline points="${toPoints(way.points)}" fill="none" stroke="#d9d4cc" stroke-width="1.2" opacity="0.8"/>`,
    )
    .join('\n');

  const alignedLines = (best?.alignedWays ?? [])
    .map((way) => way.samples.map((sample) => sample.point))
    .filter((line) => line.length >= 2)
    .map(
      (line) =>
        `<polyline points="${toPoints(line)}" fill="none" stroke="#2a7" stroke-width="3.5" stroke-linecap="round" opacity="0.9"/>`,
    )
    .join('\n');

  const placementLines = ranked
    .map((item, index) => {
      const color = index === 0 ? '#111' : ['#c45', '#1a6bb5', '#b8860b', '#6a5acd'][index - 1] ?? '#666';
      const widthPx = index === 0 ? 4 : 2;
      const dash = index === 0 ? '14 8' : '6 6';
      return `<polyline points="${toPoints(item.target)}" fill="none" stroke="${color}" stroke-width="${widthPx}" stroke-dasharray="${dash}" stroke-linejoin="round"/>`;
    })
    .join('\n');

  const routeLine =
    routeLocal.length >= 2
      ? `<polyline points="${toPoints(routeLocal)}" fill="none" stroke="#4a7fd4" stroke-width="2.5" opacity="0.7"/>`
      : '';
  const startDot = project({ x: 0, y: 0 });
  const offsetDot = best
    ? project({ x: best.placement.eastMeters, y: best.placement.northMeters })
    : startDot;

  const labels = ranked
    .slice(0, 5)
    .map((item, index) => {
      const point = item.target[0] ?? { x: item.placement.eastMeters, y: item.placement.northMeters };
      const projected = project(point);
      return `<text x="${projected.x.toFixed(1)}" y="${(projected.y - 10).toFixed(1)}" font-size="22" font-family="sans-serif" fill="#111">#${index + 1} ${item.score.toFixed(2)} r${item.placement.rotationDegrees} s${item.placement.scale}</text>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" width="1200" height="${Math.round((1200 * height) / width)}">
  <rect width="100%" height="100%" fill="#f4f3ef"/>
  <text x="16" y="28" font-size="18" font-family="sans-serif" fill="#111">DEVELOPMENT / street-fit placement search</text>
  <text x="16" y="50" font-size="12" font-family="sans-serif" fill="#666">gray = pedestrian graph · green = best aligned streets · dashed = top placements · black = #1 · dot = user start</text>
  ${graphLines}
  ${alignedLines}
  ${routeLine}
  ${placementLines}
  <circle cx="${startDot.x.toFixed(1)}" cy="${startDot.y.toFixed(1)}" r="8" fill="#c45"/>
  <circle cx="${offsetDot.x.toFixed(1)}" cy="${offsetDot.y.toFixed(1)}" r="5" fill="#111"/>
  ${labels}
</svg>
`;
}
