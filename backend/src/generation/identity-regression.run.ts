/**
 * DEVELOPMENT ONLY. Reproduce known-good experimental cases and print the
 * exact product/identity rejection breakdown. Does not change generation.
 */
import { polylineLength, projectPointOnPolyline, resamplePolyline } from '@/lib/geometry';
import { coordinatesToLocalMeters, polylineLengthMeters } from '@/lib/shape-projection';

import type { GeneratedRoute } from '../types';
import {
  experimentalProductRejectionReasons,
  meetsExperimentalProductThreshold,
} from './experimental-product';
import { runExperimentalPipeline } from './graph-constrained-pipeline';
import { identitySearchOrigin, snapSearchOrigin } from './snap-search-origin';
import { analyzeGeneratedRouteIdentity, TARGET_IDENTITY } from './target-identity';

const CASES = [
  {
    name: 'L Alexandria 2km',
    word: 'L',
    latitude: 31.227549356302422,
    longitude: 29.94947010481379,
    targetDistance: 2000,
    expect: 'must-pass',
    prior: 'ok/2 score 0.863 cov 0.725 order 0.881 len 1093',
  },
  {
    name: 'L Zamalek 2km',
    word: 'L',
    latitude: 30.0619,
    longitude: 31.2195,
    targetDistance: 2000,
    expect: 'must-pass',
    prior: 'ok/1 score 0.877 cov 0.750 order 0.880 len 1518 (best had targetSpan reject)',
  },
  {
    name: 'L Zamalek 2.5km',
    word: 'L',
    latitude: 30.0619,
    longitude: 31.2195,
    targetDistance: 2500,
    expect: 'must-pass',
    prior: 'ok/1 0.866 / 0.825 / 0.841 len 2288',
  },
  {
    name: 'Z north Cairo 2.5km',
    word: 'Z',
    latitude: 30.08033,
    longitude: 31.2357,
    targetDistance: 2500,
    expect: 'must-pass',
    prior: 'ok/2 0.862 / 0.775 / 0.803 len 2444',
  },
  {
    name: 'O Zamalek 1.5km',
    word: 'O',
    latitude: 30.0619,
    longitude: 31.2195,
    targetDistance: 1500,
    expect: 'must-reject',
    prior: 'no_viable_shape coverage 0.575 + targetSpan',
  },
  {
    name: 'ROBZ Downtown 4km',
    word: 'ROBZ',
    latitude: 30.0444,
    longitude: 31.2357,
    targetDistance: 4000,
    expect: 'must-reject',
    prior: 'no_viable_shape 0.718/0.762/0.610 len 994 reject targetSpan,lengthRatio,wordTraversal',
  },
] as const;

const NEARBY_ALEXANDRIA = [
  { name: 'Alexandria diagnostic GPS', latitude: 31.227549356302422, longitude: 29.94947010481379 },
  { name: 'Alexandria +40m east', latitude: 31.227549356302422, longitude: 29.94989 },
  { name: 'Alexandria +80m north', latitude: 31.22827, longitude: 29.94947010481379 },
] as const;

function fmt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(3);
}

function countReasons(routes: GeneratedRoute[], word: string, targetDistance: number): Record<string, number> {
  const counts: Record<string, number> = {
    oldGatesOnly: 0,
    targetSpan: 0,
    lengthRatio: 0,
    wordTraversal: 0,
    acceptedAfterIdentity: 0,
    acceptedBeforeIdentity: 0,
  };
  for (const route of routes) {
    const before = experimentalProductRejectionReasons(route, { word, targetDistance, skipIdentity: true });
    const after = experimentalProductRejectionReasons(route, { word, targetDistance });
    if (before.length === 0) counts.acceptedBeforeIdentity += 1;
    if (after.length === 0) counts.acceptedAfterIdentity += 1;
    if (before.length > 0) counts.oldGatesOnly += 1;
    if (after.includes('targetSpan')) counts.targetSpan += 1;
    if (after.includes('lengthRatio')) counts.lengthRatio += 1;
    if (after.includes('wordTraversal')) counts.wordTraversal += 1;
  }
  return counts;
}

function progressTrace(route: GeneratedRoute): string {
  const origin = route.targetCoordinates[0];
  const shape = route.shapeCoordinates ?? route.coordinates;
  if (!origin || shape.length < 2 || route.targetCoordinates.length < 2) {
    return '  progress: missing geometry';
  }
  const localRoute = coordinatesToLocalMeters(origin, shape);
  const localTarget = coordinatesToLocalMeters(origin, route.targetCoordinates);
  const sampled = resamplePolyline(localRoute, TARGET_IDENTITY.sampleCount);
  const threshold = Math.max(
    18,
    Math.min(
      Math.min(
        Math.max(...localTarget.map((p) => p.x)) - Math.min(...localTarget.map((p) => p.x)),
        Math.max(...localTarget.map((p) => p.y)) - Math.min(...localTarget.map((p) => p.y)),
      ) * 0.22,
      polylineLength(localTarget) * 0.025,
    ),
  );
  const rows = sampled.map((point, index) => {
    const hit = projectPointOnPolyline(point, localTarget);
    const on = hit.distance <= threshold ? 'on' : 'off';
    return `${String(index).padStart(2, '0')}:${hit.progress.toFixed(3)}/${on}/${hit.distance.toFixed(0)}`;
  });
  return `  progress n=${rows.length} thresh=${threshold.toFixed(1)}m\n  ${rows.join('  ')}`;
}

function describeRoute(route: GeneratedRoute, word: string, targetDistance: number): string {
  const before = experimentalProductRejectionReasons(route, { word, targetDistance, skipIdentity: true });
  const after = experimentalProductRejectionReasons(route, { word, targetDistance });
  const identity = analyzeGeneratedRouteIdentity(route, { word, targetDistance });
  const pathIdentity =
    route.metadata && route.targetCoordinates.length >= 2
      ? null
      : null;
  void pathIdentity;
  const shapeDistance = route.metadata.shapeRouteDistanceMeters ?? polylineLengthMeters(route.shapeCoordinates ?? []);
  const connectorDistance = route.metadata.connectorDistanceMeters ?? 0;
  const totalDistance = route.metadata.totalDistanceMeters ?? route.distanceMeters;
  const beforeAfterSame =
    JSON.stringify((route.shapeCoordinates ?? []).map((p) => [p.latitude, p.longitude])) ===
    JSON.stringify((route.shapeCoordinates ?? []).map((p) => [p.latitude, p.longitude]));
  return [
    `  id=${route.id} rot=${route.metadata.rotationDegrees} scale=${route.metadata.scale} e=${route.metadata.eastMeters} n=${route.metadata.northMeters}`,
    `  OLD score=${fmt(route.shapeScore)} cov=${fmt(route.coverage)} order=${fmt(route.scoreBreakdown.order)} back=${fmt(route.metadata.backtrackRatio)} gap=${fmt(route.metadata.largestGap)}`,
    `  shapeDistance=${Math.round(shapeDistance)} connector=${Math.round(connectorDistance)} total=${Math.round(totalDistance)} requested=${targetDistance} projectedTarget=${Math.round(identity.targetLengthMeters)}`,
    `  lengthRatio=${fmt(identity.lengthRatioRequested)} (shape/requested) projected=${fmt(identity.lengthRatioProjected)} (shape/projectedTarget)`,
    `  targetSpan=${fmt(identity.targetSpan)} naiveSpan=${fmt(identity.naiveSpan)} occ=${fmt(identity.spanOccupancy)} progress ${fmt(identity.onTargetProgressMin)}→${fmt(identity.onTargetProgressMax)} start=${fmt(identity.startProgress)} end=${fmt(identity.endProgress)}`,
    `  wordTraversal=${fmt(identity.wordTraversal)} lettersVisited=${identity.lettersVisited}/${identity.letters.length} inOrder=${identity.lettersVisitedInOrder} mostOfWord=${identity.traversesMostOfWord}`,
    `  letters ${identity.letters.map((item) => `${item.letter}:${item.meaningfullyVisited ? 'YES' : 'no'} cov=${item.coverage.toFixed(2)} ord=${item.order.toFixed(2)}`).join(' | ') || '(single-letter or none)'}`,
    `  rejectBeforeIdentity=${before.join(',') || 'none'} rejectAfter=${after.join(',') || 'none'}`,
    `  geometryUnchangedByIdentity=${beforeAfterSame} shapePts=${(route.shapeCoordinates ?? []).length} targetPts=${route.targetCoordinates.length}`,
    progressTrace(route),
  ].join('\n');
}

async function runCase(item: (typeof CASES)[number] | { name: string; word: string; latitude: number; longitude: number; targetDistance: number; expect?: string; prior?: string }) {
  const report = await runExperimentalPipeline({
    word: item.word,
    start: { latitude: item.latitude, longitude: item.longitude },
    targetDistanceMeters: item.targetDistance,
  });
  const routed = report.routes;
  const counts = countReasons(routed, item.word, item.targetDistance);
  const oldAccepted = routed.filter((route) =>
    meetsExperimentalProductThreshold(route, { word: item.word, targetDistance: item.targetDistance, skipIdentity: true }),
  );
  const newAccepted = routed.filter((route) =>
    meetsExperimentalProductThreshold(route, { word: item.word, targetDistance: item.targetDistance }),
  );
  const lines = [
    '',
    '========',
    `${item.name}  expect=${item.expect ?? ''}  prior=${item.prior ?? ''}`,
    `pipelineStatus=${report.status} placements=${report.diagnostics.placementsEvaluated} graphPool=${report.diagnostics.feasibility.length} graphFeasible=${report.diagnostics.graphFeasible} selectedForRouting=${report.diagnostics.placementsRouted} routed=${routed.length}`,
    `OLD product accepted (no identity): ${oldAccepted.length}`,
    `NEW product accepted (with identity): ${newAccepted.length}`,
    `rejection counts among routed: oldFail=${counts.oldGatesOnly} targetSpan=${counts.targetSpan} lengthRatio=${counts.lengthRatio} wordTraversal=${counts.wordTraversal}`,
    `singleLetterWordTraversalShouldSkip=${item.word.replace(/[^A-Za-z]/g, '').length <= 1}`,
  ];
  if (routed.length === 0) {
    lines.push('NO ROUTED CANDIDATES — failure is before product identity.');
    const failures = report.diagnostics.feasibility
      .filter((row) => !row.feasible)
      .reduce<Record<string, number>>((acc, row) => {
        const reason = row.failureReason ?? 'unknown';
        acc[reason] = (acc[reason] ?? 0) + 1;
        return acc;
      }, {});
    lines.push(`graph failure reasons: ${Object.entries(failures).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  }
  for (const route of routed) {
    lines.push('', describeRoute(route, item.word, item.targetDistance));
  }
  return { item, report, oldAccepted: oldAccepted.length, newAccepted: newAccepted.length, text: lines.join('\n') };
}

async function snapReport() {
  const lines = ['', '======== SEARCH ORIGIN SNAP (Alexandria nearby)'];
  for (const point of NEARBY_ALEXANDRIA) {
    const identity = identitySearchOrigin({ latitude: point.latitude, longitude: point.longitude });
    const snap = await snapSearchOrigin({ latitude: point.latitude, longitude: point.longitude });
    lines.push(
      `${point.name}: raw ${point.latitude}, ${point.longitude} → snapped ${snap.snappedLatitude}, ${snap.snappedLongitude} d=${snap.snapDistanceMeters.toFixed(1)} m way=${snap.wayId ?? 'none'} fallback=${snap.fallbackReason ?? 'none'} identityNoSnap=${identity.snappedLatitude}, ${identity.snappedLongitude}`,
    );
  }
  return lines.join('\n');
}

const started = Date.now();
const results = [];
for (const item of CASES) {
  results.push(await runCase(item));
  console.log(results[results.length - 1]!.text);
}
console.log(await snapReport());
console.log('\n======== SUMMARY');
for (const result of results) {
  console.log(
    `${result.item.name}: graph=${result.report.diagnostics.graphFeasible} routed=${result.report.routes.length} oldProduct=${result.oldAccepted} newProduct=${result.newAccepted} pipeline=${result.report.status}`,
  );
}
console.log(`elapsed ${(Date.now() - started) / 1000}s`);
