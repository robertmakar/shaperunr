/**
 * Controlled A vs B construction comparison on one ROBZ candidate.
 * Does not use the 48-spec search.
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
  tracePedestrianShape,
} from '../routing/valhalla';
import { placeShapeCoordinates } from './candidate-search';
import { constructOrderedStreetRoute } from './ordered-street-route';

const START = { latitude: 30.0444, longitude: 31.2357 };

async function main() {
  const wordShape = buildWordShape('ROBZ');
  const base = dimensionsForTargetLength(wordShape, 4000);
  const projected = projectShapeToGeographic(wordShape.points, {
    center: START,
    widthMeters: base.widthMeters * 0.9,
    heightMeters: base.heightMeters * 0.9,
    rotationDegrees: 22.5,
  });
  const placed = placeShapeCoordinates(projected.coordinates, START, {
    rotationDegrees: 22.5,
    offsetAcrossMeters: 0,
  });

  const startedA = Date.now();
  const a = await constructTraceMapSnap(placed);
  const scoreA = scoreRouteAgainstShape(a.coordinates, placed);
  const msA = Date.now() - startedA;

  const startedB = Date.now();
  const b = await constructOrderedStreetRoute({ start: START, targetCoordinates: placed });
  const scoreB = scoreRouteAgainstShape(b.path.coordinates, placed);
  const msB = Date.now() - startedB;

  console.log(
    JSON.stringify(
      {
        candidate: {
          word: 'ROBZ',
          targetDistance: 4000,
          rotation: 22.5,
          scale: 0.9,
          placement: 'start-anchored',
          start: START,
        },
        A_trace_route: {
          method: 'trace_route',
          anchorCount: a.anchorCount,
          meanSnapDistance: round(a.meanSnap),
          maxSnapDistance: round(a.maxSnap),
          routeDistance: Math.round(a.distance),
          score: round(scoreA.score),
          order: round(scoreA.breakdown.order),
          proximity: round(scoreA.breakdown.proximity),
          coverage: round(scoreA.coverage),
          backtrackRatio: round(scoreA.details.backtrackRatio),
          exactRepeats: a.coordinates.length - uniqueCount(a.coordinates),
          valhallaCalls: a.calls,
          latencyMs: msA,
        },
        B_ordered_breaks: {
          method: 'route_breaks',
          geometricAnchors: b.targetSampleCount,
          acceptedAnchors: b.anchors.length,
          rejectedAnchors: b.rejectedCount,
          meanSnapDistance: round(b.meanSnapDistance),
          maxSnapDistance: round(b.maxSnapDistance),
          routeDistance: Math.round(b.path.distanceMeters),
          score: round(scoreB.score),
          order: round(scoreB.breakdown.order),
          proximity: round(scoreB.breakdown.proximity),
          coverage: round(scoreB.coverage),
          backtrackRatio: round(scoreB.details.backtrackRatio),
          reversalRatio: round(b.immediateReversalRatio),
          exactRepeats: b.consecutiveDuplicateCount,
          valhallaCalls: b.valhallaCalls,
          latencyMs: msB,
          anchors: b.anchors.map((anchor) => ({
            lat: Number(anchor.snapped.latitude.toFixed(5)),
            lon: Number(anchor.snapped.longitude.toFixed(5)),
            snap: Number(anchor.distanceMeters.toFixed(1)),
            wayId: anchor.wayId,
          })),
        },
      },
      null,
      2,
    ),
  );
}

async function constructTraceMapSnap(placed: { latitude: number; longitude: number }[]) {
  const samples = resampleCoordinates(placed, 36);
  const located = await locatePedestrianPoints(
    [START, ...samples],
    Math.max(config.snapRadiusMeters, config.startRadiusMeters),
  );
  let calls = 1;
  const kept = located.slice(1).filter((point) => point.distanceMeters <= config.snapRadiusMeters);
  const collapsed = collapseSnaps(kept);
  const snapped = collapsed.map((point) => point.snapped);
  const path = await tracePedestrianShape(snapped);
  calls += 1;
  let coordinates = path.coordinates;
  const startSnap = located[0];
  const first = coordinates[0];
  if (startSnap && first && distanceMeters(startSnap.snapped, first) > 35) {
    const connector = await routePedestrianLeg(startSnap.snapped, first);
    calls += 1;
    coordinates = [...connector.coordinates, ...coordinates.slice(1)];
  }
  return {
    coordinates,
    distance: polylineLengthMeters(coordinates),
    anchorCount: collapsed.length,
    meanSnap: average(collapsed.map((point) => point.distanceMeters)),
    maxSnap: Math.max(0, ...collapsed.map((point) => point.distanceMeters)),
    calls,
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

function collapseSnaps(
  points: Array<{ snapped: { latitude: number; longitude: number }; distanceMeters: number }>,
) {
  const collapsed: typeof points = [];
  for (const point of points) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && distanceMeters(previous.snapped, point.snapped) < 18) {
      continue;
    }
    collapsed.push(point);
  }
  return collapsed;
}

function uniqueCount(points: { latitude: number; longitude: number }[]): number {
  return new Set(points.map((point) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`)).size;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
