/**
 * Diagnostic only. Does not change production generation.
 *
 * Rebuilds the current best live ROBZ candidate (22.5°, scale 0.9, start-anchored)
 * and compares three constructors on the SAME located snaps:
 *   A. /trace_route map_snap (production)
 *   B. /route with ordered through points
 *   C. sequential /route legs between consecutive snaps
 *   D. hybrid: sparse anchors + sequential legs
 */
import { resamplePolyline } from '@/lib/geometry';
import { scoreRouteAgainstShape } from '@/lib/shape-match';
import {
  coordinatesToLocalMeters,
  dimensionsForTargetLength,
  distanceMeters,
  offsetCoordinate,
  polylineLengthMeters,
  projectShapeToGeographic,
} from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

import { config } from '../config';
import {
  locatePedestrianPoints,
  routePedestrianLeg,
  routeThroughPedestrianPoints,
  tracePedestrianShape,
  type SnappedPoint,
  type ValhallaPath,
} from '../routing/valhalla';
import { placeShapeCoordinates } from './candidate-search';

const START = { latitude: 30.0444, longitude: 31.2357 };
const SAMPLE_COUNT = 36;
const COLLAPSE_METERS = 18;
const HYBRID_ANCHORS = 14;

async function main() {
  const wordShape = buildWordShape('ROBZ');
  const base = dimensionsForTargetLength(wordShape, 4000);
  const scale = 0.9;
  const projected = projectShapeToGeographic(wordShape.points, {
    center: START,
    widthMeters: base.widthMeters * scale,
    heightMeters: base.heightMeters * scale,
    rotationDegrees: 22.5,
  });
  const placed = placeShapeCoordinates(projected.coordinates, START, {
    rotationDegrees: 22.5,
    offsetAcrossMeters: 0,
  });
  const samples = resampleCoordinates(placed, SAMPLE_COUNT);

  const locateRadius = Math.max(config.snapRadiusMeters, config.startRadiusMeters);
  const located = await locatePedestrianPoints([START, ...samples], locateRadius);
  const startSnap = located[0];
  const rawShape = located.slice(1);
  const kept = rawShape.filter((point) => point.distanceMeters <= config.snapRadiusMeters);
  const collapsed = collapseSnaps(kept);
  const snapped = collapsed.map((point) => point.snapped);

  const wayCounts = new Map<number, number>();
  for (const point of collapsed) {
    if (point.wayId != null) {
      wayCounts.set(point.wayId, (wayCounts.get(point.wayId) ?? 0) + 1);
    }
  }
  const repeatedWays = [...wayCounts.values()].filter((count) => count >= 2).length;

  console.log('=== SNAP DIAGNOSTICS (same inputs for A/B/C/D) ===');
  console.log(
    JSON.stringify(
      {
        rotation: 22.5,
        scale,
        geometricLength: Math.round(projected.lengthMeters),
        locateRadius,
        snapFilter: config.snapRadiusMeters,
        samples: samples.length,
        snappedWithin100m: kept.length,
        collapsed18m: collapsed.length,
        uniqueWayIds: wayCounts.size,
        waysWithMultipleSnaps: repeatedWays,
        meanSnapDisplacement: mean(kept.map((point) => point.distanceMeters)),
        maxSnapDisplacement: Math.max(...kept.map((point) => point.distanceMeters)),
        collapsedLength: Math.round(polylineLengthMeters(snapped)),
        consecutiveSnapMean: meanConsecutive(snapped),
        startSnap: startSnap
          ? { distance: round(startSnap.distanceMeters), wayId: startSnap.wayId }
          : null,
      },
      null,
      2,
    ),
  );

  const methods: Array<{ name: string; path: ValhallaPath; calls: number }> = [];

  const trace = await timed('A_trace_route', () => tracePedestrianShape(snapped));
  methods.push({ name: 'A_trace_route_map_snap', path: trace.value, calls: 1 });

  const through = await timed('B_route_through', () =>
    routeThroughPedestrianPoints(thinPoints(snapped, 20)),
  );
  methods.push({ name: 'B_route_through_20', path: through.value, calls: 1 });

  const sequential = await timed('C_sequential', () => sequentialRoute(snapped));
  methods.push({
    name: `C_sequential_${snapped.length - 1}_legs`,
    path: sequential.value.path,
    calls: sequential.value.calls,
  });

  const hybridAnchors = thinPoints(snapped, HYBRID_ANCHORS);
  const hybrid = await timed('D_hybrid', () => sequentialRoute(hybridAnchors));
  methods.push({
    name: `D_hybrid_${hybridAnchors.length}_anchors`,
    path: hybrid.value.path,
    calls: hybrid.value.calls,
  });

  console.log('\n=== ROUTE CONSTRUCTOR COMPARISON ===');
  for (const method of methods) {
    const score = scoreRouteAgainstShape(method.path.coordinates, placed);
    console.log(
      JSON.stringify({
        method: method.name,
        valhallaCalls: method.calls,
        distanceMeters: Math.round(method.path.distanceMeters),
        coords: method.path.coordinates.length,
        uniqueCoords: uniqueCount(method.path.coordinates),
        exactRepeats: method.path.coordinates.length - uniqueCount(method.path.coordinates),
        consecutiveDuplicates: consecutiveDuplicates(method.path.coordinates),
        score: round(score.score),
        order: round(score.breakdown.order),
        proximity: round(score.breakdown.proximity),
        coverage: round(score.coverage),
        lengthFit: round(score.breakdown.lengthFit),
        detour: round(score.breakdown.detour),
        backtrack: round(score.breakdown.backtrack),
        dtwFit: round(score.details.order.dtwFit),
        monotonicFit: round(score.details.order.monotonicFit),
        jumpFit: round(score.details.order.jumpFit),
        directionFit: round(score.details.order.directionFit),
      }),
    );
  }
}

async function sequentialRoute(points: { latitude: number; longitude: number }[]): Promise<{
  path: ValhallaPath;
  calls: number;
}> {
  const coordinates: { latitude: number; longitude: number }[] = [];
  let calls = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to) {
      continue;
    }
    calls += 1;
    const leg = await routePedestrianLeg(from, to);
    if (coordinates.length === 0) {
      coordinates.push(...leg.coordinates);
    } else {
      coordinates.push(...leg.coordinates.slice(1));
    }
  }
  return {
    calls,
    path: {
      coordinates,
      distanceMeters: polylineLengthMeters(coordinates),
      method: 'route_through',
    },
  };
}

function resampleCoordinates(
  coordinates: { latitude: number; longitude: number }[],
  sampleCount: number,
) {
  const origin = coordinates[0];
  if (!origin) {
    return [];
  }
  return resamplePolyline(coordinatesToLocalMeters(origin, coordinates), sampleCount).map((point) =>
    offsetCoordinate(origin, point.x, point.y),
  );
}

function collapseSnaps(points: SnappedPoint[]): SnappedPoint[] {
  const collapsed: SnappedPoint[] = [];
  for (const point of points) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && distanceMeters(previous.snapped, point.snapped) < COLLAPSE_METERS) {
      continue;
    }
    collapsed.push(point);
  }
  return collapsed;
}

function thinPoints(
  points: { latitude: number; longitude: number }[],
  maxCount: number,
) {
  if (points.length <= maxCount) {
    return points;
  }
  return resampleCoordinates(points, maxCount);
}

function uniqueCount(points: { latitude: number; longitude: number }[]): number {
  return new Set(points.map((point) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`))
    .size;
}

function consecutiveDuplicates(points: { latitude: number; longitude: number }[]): number {
  let count = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      previous &&
      current &&
      previous.latitude === current.latitude &&
      previous.longitude === current.longitude
    ) {
      count += 1;
    }
  }
  return count;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanConsecutive(points: { latitude: number; longitude: number }[]): number {
  if (points.length < 2) {
    return 0;
  }
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) {
      total += distanceMeters(previous, current);
    }
  }
  return total / (points.length - 1);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  try {
    const value = await work();
    console.log(`ran ${label} in ${Date.now() - started} ms`);
    return { value, ms: Date.now() - started };
  } catch (error) {
    console.log(`FAILED ${label}: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
