/**
 * DEVELOPMENT ONLY. Diagnose experimental O and I without changing production.
 *
 *   npx tsx src/generation/oi-letter-diagnostic.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boundingBox2,
  distance2,
  polylineLength,
  projectPointOnPolyline,
  resamplePolyline,
  type Vec2,
} from '@/lib/geometry';
import { flattenLetterStrokes, getLetterShape } from '@/lib/letter-shapes';
import { offsetCoordinate } from '@/lib/shape-projection';
import { scorePolylines, shapeScoreBreakdown } from '../scoring/shape-match';

import {
  EXPERIMENTAL_PRODUCT,
  experimentalProductRejectionReasons,
} from './experimental-product';
import {
  EXPERIMENTAL_PIPELINE,
  runExperimentalPipeline,
  type ExperimentalPipelineReport,
  type FeasibilityRecord,
} from './graph-constrained-pipeline';
import { isClosedTarget, regionsForKind } from './graph-shape';
import { shapeKindFromWord } from './graph-shape-router';
import type { GeneratedRoute } from '../types';
import { analyzeTargetIdentity } from './target-identity';
import {
  buildWalkableWordShape,
  coverStrokesOnInk,
  longestEmptyJump,
  walkableLetterPoints,
} from './walkable-target';

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT_TXT = resolve(DIR, 'oi-letter-diagnostic.txt');
const OUT_JSON = resolve(DIR, 'oi-letter-diagnostic.json');

const LOCATIONS = [
  {
    id: 'alexandria',
    name: 'Alexandria diagnostic',
    latitude: 31.227549356302422,
    longitude: 29.94947010481379,
  },
  { id: 'zamalek', name: 'Zamalek', latitude: 30.0619, longitude: 31.2195 },
  { id: 'downtown', name: 'Downtown Cairo', latitude: 30.0444, longitude: 31.2357 },
] as const;

const CASES = [
  ...LOCATIONS.flatMap((location) =>
    (['O', 'I'] as const).flatMap((letter) =>
      ([2000, 4000] as const).map((distance) => ({ location, letter, distance })),
    ),
  ),
  { location: LOCATIONS[1], letter: 'O' as const, distance: 1500 },
];

function fmt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(3);
}

function xy(points: readonly Vec2[], limit = 28): string {
  const sliced = points.length > limit ? resamplePolyline(points, limit) : points;
  return sliced.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' → ');
}

function geoLine(
  origin: { latitude: number; longitude: number },
  points: readonly Vec2[],
  limit = 16,
): string {
  const sliced = points.length > limit ? resamplePolyline(points, limit) : points;
  return sliced
    .map((point) => {
      const geo = offsetCoordinate(origin, point.x, point.y);
      return `${geo.latitude.toFixed(5)},${geo.longitude.toFixed(5)}`;
    })
    .join(' → ');
}

function polygonArea(points: readonly Vec2[]): number {
  if (points.length < 3) {
    return 0;
  }
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function countCorners(points: readonly Vec2[], minDeg = 50): number {
  let count = 0;
  const n = points.length;
  const closed = isClosedTarget(points);
  const last = closed ? n : n - 1;
  const start = closed ? 0 : 1;
  for (let index = start; index < last; index += 1) {
    const a = points[(index - 1 + n) % n];
    const b = points[index];
    const c = points[(index + 1) % n];
    if (!a || !b || !c) {
      continue;
    }
    const d1x = b.x - a.x;
    const d1y = b.y - a.y;
    const d2x = c.x - b.x;
    const d2y = c.y - b.y;
    const n1 = Math.hypot(d1x, d1y);
    const n2 = Math.hypot(d2x, d2y);
    if (n1 < 1e-6 || n2 < 1e-6) {
      continue;
    }
    const angle = Math.acos(Math.max(-1, Math.min(1, (d1x * d2x + d1y * d2y) / (n1 * n2))));
    if ((angle * 180) / Math.PI >= minDeg) {
      count += 1;
    }
  }
  return count;
}

function profile(points: readonly Vec2[]) {
  const box = boundingBox2(points);
  const length = polylineLength(points);
  const first = points[0];
  const last = points[points.length - 1];
  const startEndGap = first && last ? distance2(first, last) : 0;
  const width = box?.width ?? 0;
  const height = box?.height ?? 0;
  const area = polygonArea(points);
  const circularity = length <= 1e-6 ? 0 : (4 * Math.PI * area) / (length * length);
  const corners = countCorners(points);
  const closed = isClosedTarget(points);
  return {
    pointCount: points.length,
    length,
    width,
    height,
    aspect: height <= 1e-6 ? 0 : width / height,
    closed,
    startEndGap,
    circularity,
    corners,
    rectangular:
      closed &&
      corners >= 3 &&
      circularity < 0.86 &&
      width / Math.max(height, 1) >= 0.55 &&
      width / Math.max(height, 1) <= 1.8,
  };
}

function nearestDistance(point: Vec2, route: readonly Vec2[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1];
    const b = route[index];
    if (!a || !b) {
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 <= 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
  }
  return best;
}

function mapUnitOntoTarget(unit: Vec2, unitPath: readonly Vec2[], target: readonly Vec2[]): Vec2 {
  const hit = projectPointOnPolyline(unit, unitPath);
  const length = polylineLength(target);
  if (length <= 0) {
    return target[0] ?? { x: 0, y: 0 };
  }
  let remaining = hit.progress * length;
  for (let index = 1; index < target.length; index += 1) {
    const a = target[index - 1]!;
    const b = target[index]!;
    const seg = distance2(a, b);
    if (remaining <= seg || index === target.length - 1) {
      const t = seg <= 0 ? 0 : remaining / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= seg;
  }
  return target[target.length - 1] ?? { x: 0, y: 0 };
}

function iStrokeCoverage(route: readonly Vec2[], target: readonly Vec2[]): string {
  const shape = getLetterShape('I');
  if (!shape || route.length < 2 || target.length < 2) {
    return 'n/a';
  }
  const unit = walkableLetterPoints(shape);
  const threshold = Math.max(18, Math.min(polylineLength(target) * 0.04, 42));
  const names = ['topBar', 'stem', 'bottomBar'];
  return shape.strokes
    .map((stroke, index) => {
      const samples = resamplePolyline(stroke, 10).map((point) => mapUnitOntoTarget(point, unit, target));
      const hit = samples.filter((point) => nearestDistance(point, route) <= threshold).length / samples.length;
      return `${names[index] ?? `s${index}`}=${hit.toFixed(2)}`;
    })
    .join(' ');
}

function describeTarget(letter: 'O' | 'I'): string[] {
  const shape = getLetterShape(letter)!;
  const flat = flattenLetterStrokes(shape);
  const walk = walkableLetterPoints(shape);
  const cover = coverStrokesOnInk(shape.strokes);
  const word = buildWalkableWordShape(letter);
  const kind = shapeKindFromWord(letter);
  const genericRegions = regionsForKind('generic', word.points);
  const usedRegions = regionsForKind(kind, word.points);
  return [
    `letter ${letter} kind=${kind} strokes=${shape.strokes.length} flattenPts=${flat.length} walkPts=${walk.length} coverPts=${cover.length}`,
    `  flattenJump=${longestEmptyJump(flat, shape.strokes).toFixed(3)} walkJump=${longestEmptyJump(walk, shape.strokes).toFixed(3)} coverLen=${polylineLength(cover).toFixed(3)} flattenLen=${polylineLength(flat).toFixed(3)}`,
    `  walkable closed=${isClosedTarget(word.points)} length=${word.length.toFixed(3)} aspect=${word.aspectRatio.toFixed(3)} ${word.width.toFixed(3)}x${word.height.toFixed(3)}`,
    `  used regions ${usedRegions.map((region) => `${region.id}:${region.startProgress.toFixed(2)}-${region.endProgress.toFixed(2)}`).join(', ')}`,
    `  generic-corner regions ${genericRegions.map((region) => `${region.id}:${region.startProgress.toFixed(2)}-${region.endProgress.toFixed(2)}`).join(', ')}`,
    `  flatten ${xy(flat.map((point) => ({ x: point.x * 100, y: point.y * 100 })))}`,
    `  walkable ${xy(walk.map((point) => ({ x: point.x * 100, y: point.y * 100 })))}`,
    `  covering ${xy(cover.map((point) => ({ x: point.x * 100, y: point.y * 100 })))}`,
  ];
}

function candidateReasons(
  item: FeasibilityRecord,
  letter: string,
  distance: number,
  scored: { score: number; coverage: number } | null,
  order: number,
  identity: ReturnType<typeof analyzeTargetIdentity> | null,
): string[] {
  const stub = {
    id: item.placementId,
    shapeScore: scored?.score ?? 0,
    coverage: scored?.coverage ?? item.coverage,
    scoreBreakdown: {
      proximity: 0,
      coverage: scored?.coverage ?? item.coverage,
      order,
      lengthFit: 0,
      detour: 0,
      backtrack: 0,
      finalScore: scored?.score ?? 0,
    },
    metadata: {
      connected: item.connected,
      backtrackRatio: item.backtracking,
      largestGap: item.largestGap,
      headingAgreementDegrees: item.headingAgreementDegrees,
      shapeRouteDistanceMeters: item.shapeRouteMeters,
    },
    targetCoordinates: [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.001 },
    ],
    shapeCoordinates: [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.001 },
    ],
    coordinates: [],
    connectorCoordinates: [],
    source: 'valhalla' as const,
    developmentOnly: true as const,
    distanceMeters: item.shapeRouteMeters,
  };
  const reasons = experimentalProductRejectionReasons(stub as unknown as GeneratedRoute, {
    skipIdentity: true,
  });
  if (identity) {
    if (identity.targetSpan < EXPERIMENTAL_PRODUCT.minTargetSpan) reasons.push('targetSpan');
    const ratio = identity.lengthRatioRequested ?? identity.lengthRatioProjected;
    if (ratio < EXPERIMENTAL_PRODUCT.minLengthRatio) reasons.push('lengthRatio');
  }
  return [...new Set(reasons)];
}

function describeFeasible(
  item: FeasibilityRecord,
  letter: string,
  distance: number,
  rank: number,
  origin: { latitude: number; longitude: number },
): string[] {
  const scored = item.pathPoints.length >= 2 ? scorePolylines(item.pathPoints, item.target) : null;
  const breakdown = scored ? shapeScoreBreakdown(scored) : null;
  const identity =
    item.pathPoints.length >= 2
      ? analyzeTargetIdentity({
          route: item.pathPoints,
          target: item.target,
          word: letter,
          requestedDistanceMeters: distance,
        })
      : null;
  const path = profile(item.pathPoints);
  const target = profile(item.target);
  const reasons = candidateReasons(item, letter, distance, scored, breakdown?.order ?? 0, identity);
  const quality =
    scored && scored.score >= EXPERIMENTAL_PIPELINE.strongShapeScore
      ? 'excellent'
      : scored && scored.score >= EXPERIMENTAL_PIPELINE.acceptableShapeScore
        ? 'acceptable'
        : 'weak';
  const loopClosed = item.result.startNode != null && item.result.startNode === item.result.endNode;
  return [
    `  #${rank} ${item.placementId} feasible=${item.feasible} fail=${item.failureReason ?? 'none'} quality=${quality}`,
    `    rot=${item.rotationDegrees} scale=${item.scale} e=${item.eastMeters.toFixed(1)} n=${item.northMeters.toFixed(1)} ways=${item.result.metrics.uniqueWays} states=${item.result.search.statesExplored}`,
    `    shapeScore=${fmt(scored?.score)} cov=${fmt(scored?.coverage ?? item.coverage)} order=${fmt(breakdown?.order)} heading=${fmt(item.headingAgreementDegrees)}°`,
    `    connected=${item.connected} back=${fmt(item.backtracking)} gap=${fmt(item.largestGap)} graphCov=${fmt(item.coverage)} fwd=${fmt(item.forwardProgress)}`,
    `    targetSpan=${fmt(identity?.targetSpan)} naiveSpan=${fmt(identity?.naiveSpan)} occupancy=${fmt(identity?.spanOccupancy)} lengthRatio=${fmt(identity?.lengthRatioRequested)} shapeM=${Math.round(item.shapeRouteMeters)}`,
    `    reject=${reasons.join(',') || 'none'}`,
    `    nodes start=${item.result.startNode ?? 'n/a'} end=${item.result.endNode ?? 'n/a'} sameNode=${loopClosed}`,
    `    target ${target.width.toFixed(0)}x${target.height.toFixed(0)}m len=${target.length.toFixed(0)} closed=${target.closed} circ=${target.circularity.toFixed(2)} corners=${target.corners}`,
    `    path   ${path.width.toFixed(0)}x${path.height.toFixed(0)}m len=${path.length.toFixed(0)} closed=${path.closed} circ=${path.circularity.toFixed(2)} corners=${path.corners} startEnd=${path.startEndGap.toFixed(0)}m rectangular=${path.rectangular}`,
    letter === 'I' ? `    I-bands ${iStrokeCoverage(item.pathPoints, item.target)}` : '',
    `    pathXY ${xy(item.pathPoints)}`,
    `    pathGeo ${geoLine(origin, item.pathPoints)}`,
    `    targetGeo ${geoLine(origin, item.target)}`,
  ].filter(Boolean);
}

function describeRouted(report: ExperimentalPipelineReport, letter: string, distance: number): string[] {
  const lines = [`  routed ${report.routes.length}  pipeline=${report.status}`];
  for (const route of report.routes) {
    const reasons = experimentalProductRejectionReasons(route, { word: letter, targetDistance: distance });
    lines.push(
      `  routed ${route.id} score=${fmt(route.shapeScore)} cov=${fmt(route.coverage)} order=${fmt(route.scoreBreakdown.order)} heading=${fmt(route.metadata.headingAgreementDegrees)}° back=${fmt(route.metadata.backtrackRatio)} gap=${fmt(route.metadata.largestGap)} connected=${route.metadata.connected} shapeM=${Math.round(route.metadata.shapeRouteDistanceMeters ?? 0)} reject=${reasons.join(',') || 'PASS'}`,
    );
  }
  return lines;
}

function serializeCandidate(
  item: FeasibilityRecord,
  letter: string,
  distance: number,
  origin: { latitude: number; longitude: number },
) {
  const scored = item.pathPoints.length >= 2 ? scorePolylines(item.pathPoints, item.target) : null;
  const breakdown = scored ? shapeScoreBreakdown(scored) : null;
  const identity =
    item.pathPoints.length >= 2
      ? analyzeTargetIdentity({
          route: item.pathPoints,
          target: item.target,
          word: letter,
          requestedDistanceMeters: distance,
        })
      : null;
  return {
    placementId: item.placementId,
    feasible: item.feasible,
    failureReason: item.failureReason,
    rotationDegrees: item.rotationDegrees,
    scale: item.scale,
    eastMeters: item.eastMeters,
    northMeters: item.northMeters,
    uniqueWays: item.result.metrics.uniqueWays,
    startNode: item.result.startNode,
    endNode: item.result.endNode,
    sameNode: item.result.startNode != null && item.result.startNode === item.result.endNode,
    shapeScore: scored?.score ?? null,
    coverage: scored?.coverage ?? item.coverage,
    order: breakdown?.order ?? null,
    heading: item.headingAgreementDegrees,
    connected: item.connected,
    backtrack: item.backtracking,
    largestGap: item.largestGap,
    graphCoverage: item.coverage,
    forwardProgress: item.forwardProgress,
    targetSpan: identity?.targetSpan ?? null,
    naiveSpan: identity?.naiveSpan ?? null,
    lengthRatio: identity?.lengthRatioRequested ?? null,
    shapeMeters: item.shapeRouteMeters,
    reject: candidateReasons(item, letter, distance, scored, breakdown?.order ?? 0, identity),
    pathProfile: profile(item.pathPoints),
    targetProfile: profile(item.target),
    iBands: letter === 'I' ? iStrokeCoverage(item.pathPoints, item.target) : null,
    pathXY: item.pathPoints,
    targetXY: item.target,
    pathGeo: item.pathPoints.map((point) => offsetCoordinate(origin, point.x, point.y)),
    targetGeo: item.target.map((point) => offsetCoordinate(origin, point.x, point.y)),
  };
}

async function runQuiet(input: Parameters<typeof runExperimentalPipeline>[0]) {
  const original = console.log;
  console.log = () => {};
  try {
    return await runExperimentalPipeline(input, { connectStart: false });
  } finally {
    console.log = original;
  }
}

const started = Date.now();
const lines = [
  'DEVELOPMENT / O and I letter diagnostic',
  `generated ${new Date().toISOString()}`,
  'production pipeline, thresholds, and UI unchanged',
  '',
  '======== TARGET GEOMETRY (unit space ×100) ========',
  ...describeTarget('O'),
  '',
  ...describeTarget('I'),
  '',
  'Notes:',
  '- O is a single closed ellipse (18 samples), kind=O, one loop region. Graph goal for loops is coverage>=0.70, not progress>=0.88.',
  '- I is a 3-stroke serif I. Flatten jumps stay on ink (reverse along serifs), so covering is NOT used.',
  '- Covering I would start on the stem and retrace it to attach the bars; flatten reverse-along-serif is the current choice.',
  '- I kind=generic, so regions come from corner splits rather than a dedicated I kind.',
  '',
];
const jsonCases: unknown[] = [];

function persist() {
  writeFileSync(OUT_TXT, `${lines.join('\n')}\n`);
  writeFileSync(
    OUT_JSON,
    `${JSON.stringify({ generated: new Date().toISOString(), cases: jsonCases }, null, 2)}\n`,
  );
}

persist();

for (const item of CASES) {
  const report = await runQuiet({
    word: item.letter,
    start: { latitude: item.location.latitude, longitude: item.location.longitude },
    targetDistanceMeters: item.distance,
  });
  const origin = {
    latitude: report.diagnostics.searchOriginSnap.snappedLatitude,
    longitude: report.diagnostics.searchOriginSnap.snappedLongitude,
  };
  const feasible = report.diagnostics.feasibility
    .filter((row) => row.feasible)
    .sort((a, b) => b.discoveryScore - a.discoveryScore)
    .slice(0, 6);
  const graphFail = report.diagnostics.feasibility
    .filter((row) => !row.feasible)
    .reduce<Record<string, number>>((acc, row) => {
      const reason = row.failureReason ?? 'unknown';
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {});
  const product = report.routes.filter(
    (route) =>
      experimentalProductRejectionReasons(route, {
        word: item.letter,
        targetDistance: item.distance,
      }).length === 0,
  );
  lines.push(
    `======== ${item.letter} ${item.location.name} ${item.distance}m ========`,
    `placements=${report.diagnostics.placementsEvaluated} graphPool=${report.diagnostics.feasibility.length} graphFeasible=${report.diagnostics.graphFeasible} routed=${report.routes.length} product=${product.length} pipeline=${report.status}`,
    `searchOrigin ${origin.latitude}, ${origin.longitude} snap=${report.diagnostics.searchOriginSnap.snapDistanceMeters.toFixed(1)}m`,
    `graph failures: ${Object.entries(graphFail)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ') || 'none'}`,
  );
  const dumped: FeasibilityRecord[] = [];
  if (feasible.length === 0) {
    const best = [...report.diagnostics.feasibility].sort(
      (a, b) => b.coverage - a.coverage || b.discoveryScore - a.discoveryScore,
    )[0];
    lines.push(
      `NO graph-feasible candidates. Best rejected: ${best?.placementId ?? 'none'} cov=${fmt(best?.coverage)} gap=${fmt(best?.largestGap)} fail=${best?.failureReason ?? 'none'}`,
    );
    if (best && best.pathPoints.length >= 2) {
      lines.push(...describeFeasible(best, item.letter, item.distance, 0, origin));
      dumped.push(best);
    }
  } else {
    lines.push(`top graph-feasible ${feasible.length}:`);
    feasible.forEach((row, index) => {
      lines.push(...describeFeasible(row, item.letter, item.distance, index + 1, origin));
    });
    dumped.push(...feasible);
  }
  lines.push(...describeRouted(report, item.letter, item.distance));
  lines.push('');
  jsonCases.push({
    letter: item.letter,
    location: item.location,
    distance: item.distance,
    placements: report.diagnostics.placementsEvaluated,
    graphFeasible: report.diagnostics.graphFeasible,
    routed: report.routes.length,
    product: product.length,
    pipeline: report.status,
    graphFailures: graphFail,
    searchOrigin: origin,
    candidates: dumped.map((row) => serializeCandidate(row, item.letter, item.distance, origin)),
    routedRoutes: report.routes.map((route) => ({
      id: route.id,
      shapeScore: route.shapeScore,
      coverage: route.coverage,
      order: route.scoreBreakdown.order,
      heading: route.metadata.headingAgreementDegrees,
      backtrack: route.metadata.backtrackRatio,
      largestGap: route.metadata.largestGap,
      connected: route.metadata.connected,
      shapeMeters: route.metadata.shapeRouteDistanceMeters,
      reject: experimentalProductRejectionReasons(route, {
        word: item.letter,
        targetDistance: item.distance,
      }),
      shapeGeo: route.shapeCoordinates,
      targetGeo: route.targetCoordinates,
    })),
  });
  persist();
}

lines.push(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
persist();
console.log(lines.join('\n'));
console.log(`\nwrote ${OUT_TXT}`);
console.log(`wrote ${OUT_JSON}`);
