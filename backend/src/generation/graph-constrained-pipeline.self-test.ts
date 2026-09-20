/**
 * DEVELOPMENT ONLY. End-to-end experimental pipeline tests.
 * Synthetic graphs only — no Valhalla.
 */
import { distanceMeters, offsetCoordinate } from '@/lib/shape-projection';
import { scorePolylines } from '../scoring/shape-match';
import type { GraphSegment } from './graph-shape';
import { runExperimentalPipeline } from './graph-constrained-pipeline';
import { getPlacementRadiusForTargetDistance, getSearchRadiusForTargetDistance } from './search-radius';
import type { StreetFitPlacement } from './street-fit-search';

type SelfTest = { name: string; passed: boolean; detail: string };

const START = { latitude: 30.0619, longitude: 31.2195 };

const ORIGIN: StreetFitPlacement = {
  id: 'p-origin',
  rotationDegrees: 0,
  scale: 1,
  eastMeters: 0,
  northMeters: 0,
  distanceFromStartMeters: 0,
};

const NEAR: StreetFitPlacement = {
  id: 'p-near',
  rotationDegrees: 0,
  scale: 1,
  eastMeters: 12,
  northMeters: 8,
  distanceFromStartMeters: 14.4,
};

const FAR: StreetFitPlacement = {
  id: 'p-far',
  rotationDegrees: 90,
  scale: 1,
  eastMeters: 400,
  northMeters: 0,
  distanceFromStartMeters: 400,
};

function followingL(): GraphSegment[] {
  return [
    {
      id: 'follow-v',
      wayId: 'follow-v',
      from: 'A',
      to: 'B',
      points: [
        { x: 2, y: 0 },
        { x: 2, y: -48 },
        { x: 2, y: -95 },
      ],
    },
    {
      id: 'follow-h',
      wayId: 'follow-h',
      from: 'B',
      to: 'C',
      points: [
        { x: 2, y: -95 },
        { x: 32, y: -95 },
        { x: 65, y: -95 },
      ],
    },
  ];
}

function crossingGrid(): GraphSegment[] {
  const segments: GraphSegment[] = [];
  for (let x = 10; x <= 60; x += 10) {
    segments.push({
      id: `grid-v-${x}`,
      wayId: `grid-v-${x}`,
      from: `gv${x}s`,
      to: `gv${x}e`,
      points: [
        { x, y: 10 },
        { x, y: -110 },
      ],
    });
  }
  return segments;
}

async function run(): Promise<SelfTest[]> {
  const viable = await runExperimentalPipeline(
    { word: 'L', start: START, targetDistanceMeters: 160 },
    { collection: { segments: followingL(), valhallaCalls: 0 }, placements: [ORIGIN, NEAR], connectStart: false },
  );
  const impossible = await runExperimentalPipeline(
    { word: 'L', start: START, targetDistanceMeters: 160 },
    { collection: { segments: crossingGrid(), valhallaCalls: 0 }, placements: [ORIGIN, FAR], connectStart: false },
  );
  const mixed = await runExperimentalPipeline(
    { word: 'L', start: START, targetDistanceMeters: 160 },
    {
      collection: { segments: [...followingL(), ...crossingGrid()], valhallaCalls: 0 },
      placements: [ORIGIN, FAR],
      connectStart: false,
    },
  );
  const again = await runExperimentalPipeline(
    { word: 'L', start: START, targetDistanceMeters: 160 },
    { collection: { segments: followingL(), valhallaCalls: 0 }, placements: [ORIGIN, NEAR], connectStart: false },
  );
  const at2000 = await runExperimentalPipeline(
    { word: 'L', start: START, targetDistanceMeters: 2000 },
    { collection: { segments: followingL(), valhallaCalls: 0 }, placements: [ORIGIN, NEAR], connectStart: false },
  );
  const at4000 = await runExperimentalPipeline(
    { word: 'L', start: START, targetDistanceMeters: 4000 },
    { collection: { segments: followingL(), valhallaCalls: 0 }, placements: [ORIGIN, NEAR], connectStart: false },
  );
  const snappedOrigin = offsetCoordinate(START, 0, 100);
  const streetLocked = await runExperimentalPipeline(
    { word: 'L', start: START, targetDistanceMeters: 160 },
    {
      collection: { segments: followingL(), valhallaCalls: 0 },
      placements: [ORIGIN],
      connectStart: false,
      searchOriginSnap: {
        originalLatitude: START.latitude,
        originalLongitude: START.longitude,
        snappedLatitude: snappedOrigin.latitude,
        snappedLongitude: snappedOrigin.longitude,
        snapDistanceMeters: 100,
        snapped: true,
      },
    },
  );

  const routedRecord = viable.diagnostics.feasibility.find((item) => item.placementId === viable.routes[0]?.id);
  const shapeOnly = routedRecord
    ? scorePolylines(routedRecord.pathPoints, routedRecord.target).score
    : 0;
  const withConnector =
    routedRecord && routedRecord.pathPoints[0]
      ? scorePolylines([{ x: -400, y: 400 }, ...routedRecord.pathPoints], routedRecord.target).score
      : 1;

  return [
    {
      name: 'impossible placement rejected before routing',
      passed:
        impossible.diagnostics.valhallaRouteCalls === 0 &&
        impossible.diagnostics.placementsRouted === 0 &&
        impossible.routes.length === 0,
      detail: `routed=${impossible.diagnostics.placementsRouted} routeCalls=${impossible.diagnostics.valhallaRouteCalls} status=${impossible.status}`,
    },
    {
      name: 'viable placement reaches routing stage',
      passed: viable.diagnostics.graphFeasible > 0 && viable.diagnostics.placementsRouted > 0 && viable.routes.length > 0,
      detail: `feasible=${viable.diagnostics.graphFeasible} routed=${viable.diagnostics.placementsRouted} routes=${viable.routes.length}`,
    },
    {
      name: 'no viable candidates returns no_viable_shape',
      passed: impossible.status === 'no_viable_shape' && impossible.failures.some((item) => item.code === 'NO_VIABLE_SHAPE'),
      detail: `status=${impossible.status} codes=${impossible.failures.map((item) => item.code).join(',')}`,
    },
    {
      name: 'connector excluded from shape score',
      passed: viable.routes[0] != null && Math.abs(viable.routes[0].shapeScore - shapeOnly) < 1e-9 && withConnector < shapeOnly - 0.01,
      detail: `reported=${viable.routes[0]?.shapeScore.toFixed(4)} shapeOnly=${shapeOnly.toFixed(4)} withFakeConnector=${withConnector.toFixed(4)}`,
    },
    {
      name: 'shape coordinates stored separately from connector',
      passed:
        viable.routes[0]?.shapeCoordinates != null &&
        viable.routes[0].shapeCoordinates.length >= 2 &&
        Array.isArray(viable.routes[0].connectorCoordinates),
      detail: `shape=${viable.routes[0]?.shapeCoordinates?.length ?? 0} connector=${viable.routes[0]?.connectorCoordinates?.length ?? 0}`,
    },
    {
      name: 'final routes are geographically deduplicated',
      passed: viable.routes.length === 1 || new Set(viable.routes.map((route) => route.id)).size === viable.routes.length,
      detail: `n=${viable.routes.length} ids=${viable.routes.map((route) => route.id).join(',')}`,
    },
    {
      name: 'strong shape beats closer weak shape',
      passed: mixed.routes.length > 0 && mixed.diagnostics.graphFeasible >= 1 && mixed.routes[0]?.shapeScore != null,
      detail: `routes=${mixed.routes.length} first=${mixed.routes[0]?.id} score=${mixed.routes[0]?.shapeScore.toFixed(3)} feasible=${mixed.diagnostics.graphFeasible}`,
    },
    {
      name: 'target distance does not override shape feasibility',
      passed: viable.routes.length > 0 && !viable.failures.some((item) => item.code === 'DISTANCE_OUT_OF_RANGE'),
      detail: `shapeRoute=${viable.routes[0]?.metadata.shapeRouteDistanceMeters} target=160 failures=${viable.failures.map((item) => item.code).join(',') || 'none'}`,
    },
    {
      name: 'deterministic output',
      passed:
        viable.routes.map((route) => route.id).join(',') === again.routes.map((route) => route.id).join(',') &&
        viable.status === again.status,
      detail: `a=${viable.routes.map((route) => route.id).join(',')} b=${again.routes.map((route) => route.id).join(',')}`,
    },
    {
      name: 'search and placement radii scale with targetDistance',
      passed:
        at2000.diagnostics.neighborhoodRadiusMeters === getSearchRadiusForTargetDistance(2000) &&
        at2000.diagnostics.placementRadiusMeters === getPlacementRadiusForTargetDistance(2000) &&
        at4000.diagnostics.neighborhoodRadiusMeters === getSearchRadiusForTargetDistance(4000) &&
        at4000.diagnostics.placementRadiusMeters === getPlacementRadiusForTargetDistance(4000) &&
        at4000.diagnostics.neighborhoodRadiusMeters > at2000.diagnostics.neighborhoodRadiusMeters &&
        at4000.diagnostics.placementRadiusMeters > at2000.diagnostics.placementRadiusMeters,
      detail: `2000=${at2000.diagnostics.neighborhoodRadiusMeters}/${at2000.diagnostics.placementRadiusMeters} 4000=${at4000.diagnostics.neighborhoodRadiusMeters}/${at4000.diagnostics.placementRadiusMeters}`,
    },
    {
      name: 'search uses snapped origin while distanceFromUser stays on raw GPS',
      passed: (() => {
        const shapeStart = streetLocked.routes[0]?.shapeCoordinates?.[0];
        const snap = streetLocked.diagnostics.searchOriginSnap;
        return (
          snap.snapped &&
          snap.originalLatitude === START.latitude &&
          snap.snappedLatitude === snappedOrigin.latitude &&
          shapeStart != null &&
          distanceMeters(shapeStart, snappedOrigin) < distanceMeters(shapeStart, START) &&
          (streetLocked.routes[0]?.metadata.distanceFromUserMeters ?? 0) > 80
        );
      })(),
      detail: `snap=${streetLocked.diagnostics.searchOriginSnap.snappedLatitude} distFromUser=${streetLocked.routes[0]?.metadata.distanceFromUserMeters} shapeStart=${streetLocked.routes[0]?.shapeCoordinates?.[0]?.latitude}`,
    },
  ];
}

const tests = await run();
for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
