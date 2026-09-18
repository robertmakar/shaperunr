/**
 * DEVELOPMENT ONLY. Surveys pedestrian edges near an ideal word drawing.
 * Does not change route generation, scoring, candidate search, or UI.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundingBox2, polylineLength, resamplePolyline, type Vec2 } from '@/lib/geometry';
import {
  coordinatesToLocalMeters,
  dimensionsForTargetLength,
  offsetCoordinate,
  projectPoint,
  projectShapeToGeographic,
} from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

import { placeShapeCoordinates } from '../generation/candidate-search';
import { scoreRouteAgainstShape } from '../scoring/shape-match';
import { locatePedestrianEdgeSets, routeViaBreakLocations } from '../routing/valhalla';
import {
  aggregateRegion,
  analyzeWaySamples,
  detectCoverageGaps,
  projectOntoTarget,
  regionsFromLetterLengths,
  STREET_FIT,
  streetFitVerdict,
  summarizeStreetFit,
  usableSamples,
  type AnalyzedWay,
  type RegionFit,
  type StreetFitSummary,
  type StreetFitVerdict,
} from './street-fit';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

export const STREET_FIT_DEFAULTS = {
  word: 'ROBZ',
  targetDistance: 4000,
  rotationDegrees: 22.5,
  scale: 0.9,
  latitude: 30.0444,
  longitude: 31.2357,
} as const;

export type StreetFitCandidate = {
  word: string;
  targetDistance: number;
  rotationDegrees: number;
  scale: number;
  latitude: number;
  longitude: number;
};

export type StreetFitDiagnosticReport = {
  developmentOnly: true;
  candidate: StreetFitCandidate;
  targetLengthMeters: number;
  sampleCount: number;
  nearbyRadiusMeters: number;
  regions: RegionFit[];
  overall: StreetFitSummary;
  verdict: StreetFitVerdict;
  verdictReason: string;
  ways: Array<{
    wayId: string;
    sampleCount: number;
    meanPerpendicularDistance: number;
    forwardRatio: number | null;
    meanHeadingAgreement: number | null;
  }>;
  svg: string;
  textReport: string;
};

export async function runStreetFitDiagnostic(
  input: Partial<StreetFitCandidate> = {},
): Promise<StreetFitDiagnosticReport> {
  const candidate: StreetFitCandidate = { ...STREET_FIT_DEFAULTS, ...input };
  const start = { latitude: candidate.latitude, longitude: candidate.longitude };
  const word = buildWordShape(candidate.word);
  const base = dimensionsForTargetLength(word, candidate.targetDistance);
  const options = {
    center: start,
    widthMeters: base.widthMeters * candidate.scale,
    heightMeters: base.heightMeters * candidate.scale,
    rotationDegrees: candidate.rotationDegrees,
  };
  const projected = projectShapeToGeographic(word.points, options);
  const placed = placeShapeCoordinates(projected.coordinates, start, {
    rotationDegrees: candidate.rotationDegrees,
    offsetAcrossMeters: 0,
  });
  const origin = placed[0] ?? start;
  const target = coordinatesToLocalMeters(origin, placed);
  const targetLength = polylineLength(target);

  const first = projected.coordinates[0];
  const shift = first ? coordinatesToLocalMeters(start, [first])[0] : { x: 0, y: 0 };
  const bounds = boundingBox2(word.points);
  const letters = bounds
    ? word.letters.map((letter) => {
        const geographic = letter.points.map((point) =>
          projectPoint(
            point,
            bounds,
            options.center,
            options.widthMeters,
            options.heightMeters,
            options.rotationDegrees,
          ),
        );
        const placedLetter = geographic.map((point) =>
          offsetCoordinate(point, -(shift?.x ?? 0), -(shift?.y ?? 0)),
        );
        return {
          id: letter.char,
          length: polylineLength(coordinatesToLocalMeters(origin, placedLetter)),
          points: coordinatesToLocalMeters(origin, placedLetter),
        };
      })
    : [];

  const sampleCount = Math.max(80, Math.round(targetLength / 20));
  const samples = resamplePolyline(target, sampleCount);
  const sampleCoordinates = samples.map((point) => offsetCoordinate(origin, point.x, point.y));
  const edgeSets = await locateInChunks(sampleCoordinates, STREET_FIT.nearbyRadiusMeters);

  const byWay = new Map<string, Vec2[]>();
  for (const set of edgeSets) {
    for (const edge of set.edges) {
      const wayId =
        edge.wayId == null
          ? `anon:${edge.snapped.latitude.toFixed(5)},${edge.snapped.longitude.toFixed(5)}`
          : String(edge.wayId);
      const coordinates = edge.shape && edge.shape.length >= 2 ? edge.shape : [edge.snapped];
      const locals = coordinatesToLocalMeters(origin, coordinates);
      const list = byWay.get(wayId) ?? [];
      list.push(...locals);
      byWay.set(wayId, list);
    }
  }

  const ways: AnalyzedWay[] = [...byWay.entries()].map(([wayId, points]) => {
    const nearby = dedupeClose(points, 8).filter(
      (point) => projectOntoTarget(point, target).perpendicularDistance <= STREET_FIT.nearbyRadiusMeters,
    );
    return analyzeWaySamples(wayId, nearby, target);
  }).filter((way) => way.samples.length > 0);
  const regions = regionsFromLetterLengths(letters.map((letter) => ({ id: letter.id, length: letter.length })));
  let regionFits = regions.map((region) => aggregateRegion(region, ways, targetLength));
  const routed = await probeRegionPaths(origin, target, regionFits, ways, letters, targetLength);
  regionFits = regionFits.map((region) => {
    const probe = routed.get(region.id);
    if (!probe) {
      return region;
    }
    return {
      ...region,
      routedPathFeasible: probe.connected,
      routedMeanDistance: probe.meanDistance,
      routedOrder: probe.order,
      plausibleContinuousPath: probe.connected || region.plausibleContinuousPath,
    };
  });
  const overall = summarizeStreetFit(regionFits, ways, targetLength);
  const { verdict, reason } = streetFitVerdict(overall, regionFits);
  const svg = renderStreetFitSvg(
    target,
    letters,
    ways,
    [...routed.values()].map((probe) => probe.points).filter((line) => line.length >= 2),
  );
  const textReport = formatStreetFitReport(candidate.word, regionFits, overall, targetLength, reason);

  return {
    developmentOnly: true,
    candidate,
    targetLengthMeters: targetLength,
    sampleCount,
    nearbyRadiusMeters: STREET_FIT.nearbyRadiusMeters,
    regions: regionFits,
    overall,
    verdict,
    verdictReason: reason,
    ways: ways
      .map((way) => ({
        wayId: way.wayId,
        sampleCount: way.samples.length,
        meanPerpendicularDistance: way.meanPerpendicularDistance,
        forwardRatio: way.forwardRatio,
        meanHeadingAgreement: way.meanHeadingAgreement,
      }))
      .sort((a, b) => a.meanPerpendicularDistance - b.meanPerpendicularDistance)
      .slice(0, 40),
    svg,
    textReport,
  };
}

export function formatStreetFitReport(
  word: string,
  regions: RegionFit[],
  overall: StreetFitSummary,
  targetLengthMeters: number,
  verdictReason?: string,
): string {
  const lines = [`${word} street-fit diagnostic`];
  for (const region of regions) {
    const heading =
      region.meanHeadingAgreement == null
        ? 'n/a'
        : `${Math.round((1 - region.meanHeadingAgreement) * 90)}°`;
    const dist = Number.isFinite(region.bestPerpendicularDistance)
      ? `${region.bestPerpendicularDistance.toFixed(1)}m`
      : 'none';
    lines.push(
      `${region.id}: coverage ${Math.round(region.coverage * 100)}%, best distance ${dist}, heading ${heading}, usable edges ${region.usableWayCount}`,
    );
    lines.push(
      `   available ${Math.round(region.availableEdgeLengthMeters)} m, forward ${(region.forwardCoverage * 100).toFixed(0)}%, path ${region.plausibleContinuousPath ? 'plausible' : 'unlikely'}${region.routedPathFeasible == null ? '' : `, routed ${region.routedPathFeasible ? 'yes' : 'no'}${region.routedMeanDistance == null ? '' : ` @ ${region.routedMeanDistance.toFixed(1)}m`}`}${region.routedOrder == null ? '' : `, order ${region.routedOrder.toFixed(3)}`}`,
    );
  }
  lines.push('');
  lines.push('Overall:');
  lines.push(`- target length ${Math.round(targetLengthMeters)} m`);
  lines.push(`- pedestrian graph coverage ${Math.round(overall.pedestrianGraphCoverage * 100)}%`);
  lines.push(
    `- mean best distance ${Number.isFinite(overall.meanBestDistance) ? overall.meanBestDistance.toFixed(1) : 'none'} m`,
  );
  lines.push(`- maximum gap ${Math.round(overall.maximumGapMeters)} m`);
  lines.push(`- forward-progress coverage ${Math.round(overall.forwardProgressCoverage * 100)}%`);
  lines.push(`- connected-path feasibility ${Math.round(overall.connectedPathFeasibility * 100)}%`);
  lines.push(`- usable ways ${overall.usableWayCount}`);
  if (verdictReason) {
    lines.push('');
    lines.push(verdictReason);
  }
  return lines.join('\n');
}

export function writeStreetFitSvg(svg: string, filename = 'robz-street-fit.svg') {
  const path = resolve(DIAGNOSTIC_DIR, filename);
  writeFileSync(path, svg);
  return path;
}

async function locateInChunks(
  coordinates: Array<{ latitude: number; longitude: number }>,
  radius: number,
) {
  const chunkSize = 16;
  const results: Awaited<ReturnType<typeof locatePedestrianEdgeSets>> = [];
  for (let index = 0; index < coordinates.length; index += chunkSize) {
    const chunk = coordinates.slice(index, index + chunkSize);
    const located = await locatePedestrianEdgeSets(chunk, radius, { verbose: true });
    results.push(...located);
  }
  return results;
}

async function probeRegionPaths(
  origin: { latitude: number; longitude: number },
  target: Vec2[],
  regions: RegionFit[],
  ways: AnalyzedWay[],
  letters: Array<{ id: string; points: Vec2[] }>,
  targetLengthMeters: number,
) {
  const probes = new Map<
    string,
    { connected: boolean; meanDistance: number; coverage: number; order: number | null; points: Vec2[] }
  >();

  for (const region of regions) {
    const samples = usableSamples(ways.flatMap((way) => way.samples))
      .filter((sample) => sample.progress >= region.startProgress && sample.progress <= region.endProgress)
      .sort((a, b) => a.progress - b.progress);
    const picks = pickEven(samples, 4);
    if (picks.length < 2) {
      probes.set(region.id, {
        connected: false,
        meanDistance: Number.POSITIVE_INFINITY,
        coverage: 0,
        order: null,
        points: [],
      });
      continue;
    }
    try {
      const path = await routeViaBreakLocations(
        picks.map((sample) => offsetCoordinate(origin, sample.point.x, sample.point.y)),
      );
      const local = coordinatesToLocalMeters(origin, path.coordinates);
      const projections = local.map((point) => projectOntoTarget(point, target));
      const inRegion = projections.filter(
        (hit) => hit.progress >= region.startProgress - 0.02 && hit.progress <= region.endProgress + 0.02,
      );
      const distances = (inRegion.length > 0 ? inRegion : projections).map((hit) => hit.perpendicularDistance);
      const span = Math.max(region.endProgress - region.startProgress, 1e-6);
      const gaps = detectCoverageGaps(
        inRegion.map((hit) => (hit.progress - region.startProgress) / span),
        span * targetLengthMeters,
        12,
      );
      const meanDistance = distances.length === 0 ? Number.POSITIVE_INFINITY : mean(distances);
      const letter = letters.find((item) => item.id === region.id);
      const order =
        letter && local.length >= 2
          ? scoreRouteAgainstShape(
              local.map((point) => offsetCoordinate(origin, point.x, point.y)),
              letter.points.map((point) => offsetCoordinate(origin, point.x, point.y)),
            ).breakdown.order
          : null;
      probes.set(region.id, {
        connected:
          Number.isFinite(meanDistance) &&
          meanDistance <= STREET_FIT.nearbyRadiusMeters &&
          gaps.coverage >= 0.3,
        meanDistance,
        coverage: gaps.coverage,
        order,
        points: local,
      });
    } catch {
      probes.set(region.id, {
        connected: false,
        meanDistance: Number.POSITIVE_INFINITY,
        coverage: 0,
        order: null,
        points: [],
      });
    }
  }

  return probes;
}

function pickEven<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) {
    return [...items];
  }
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = Math.round((index / (count - 1)) * (items.length - 1));
    const item = items[at];
    if (item) {
      picked.push(item);
    }
  }
  return picked;
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

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderStreetFitSvg(
  target: Vec2[],
  letters: Array<{ id: string; points: Vec2[] }>,
  ways: AnalyzedWay[],
  routedPaths: Vec2[][],
): string {
  const all = [
    ...target,
    ...ways.flatMap((way) => way.samples.map((sample) => sample.point)),
    ...routedPaths.flat(),
  ];
  const xs = all.map((point) => point.x);
  const ys = all.map((point) => point.y);
  const minX = (xs.length === 0 ? 0 : Math.min(...xs)) - 40;
  const maxX = (xs.length === 0 ? 100 : Math.max(...xs)) + 40;
  const minY = (ys.length === 0 ? 0 : Math.min(...ys)) - 40;
  const maxY = (ys.length === 0 ? 100 : Math.max(...ys)) + 80;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const project = (point: Vec2) => ({
    x: point.x - minX,
    y: maxY - point.y,
  });
  const toPoints = (line: Vec2[]) =>
    line
      .map((point) => {
        const projected = project(point);
        return `${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
      })
      .join(' ');

  const wayLines = ways
    .map((way) => {
      const line = way.samples.map((sample) => sample.point);
      if (line.length === 0) {
        return '';
      }
      const usable = usableSamples(way.samples).length > 0;
      const reverse = (way.forwardRatio ?? 1) < 0.5;
      const color = usable && !reverse ? '#2a7' : reverse ? '#c45' : usable ? '#1a6bb5' : '#999';
      const widthPx = usable ? 3.2 : 1.4;
      if (line.length === 1) {
        const point = project(line[0]!);
        return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${usable ? 5 : 3}" fill="${color}" opacity="0.85"/>`;
      }
      return `<polyline points="${toPoints(line)}" fill="none" stroke="${color}" stroke-width="${widthPx}" stroke-linecap="round" opacity="0.85"/>`;
    })
    .join('\n');

  const letterLabels = letters
    .map((letter) => {
      const first = letter.points[0];
      if (!first) {
        return '';
      }
      const projected = project(first);
      return `<text x="${projected.x.toFixed(1)}" y="${(projected.y - 8).toFixed(1)}" font-size="28" font-family="sans-serif" fill="#111">${letter.id}</text>`;
    })
    .join('\n');

  const routedLine = routedPaths
    .filter((line) => line.length >= 2)
    .map(
      (line) =>
        `<polyline points="${toPoints(line)}" fill="none" stroke="#4a7fd4" stroke-width="2" stroke-dasharray="6 6" opacity="0.55"/>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" width="1100" height="${Math.round((1100 * height) / width)}">
  <rect width="100%" height="100%" fill="#f4f3ef"/>
  <text x="16" y="28" font-size="18" font-family="sans-serif" fill="#111">DEVELOPMENT / ROBZ street-fit</text>
  <text x="16" y="50" font-size="12" font-family="sans-serif" fill="#666">black dashed = ideal ROBZ · green = forward usable · red = reverse · gray = nearby · blue = Valhalla walk probe</text>
  ${wayLines}
  ${routedLine}
  <polyline points="${toPoints(target)}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="14 8"/>
  ${letterLabels}
</svg>
`;
}
