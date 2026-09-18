/**
 * DEVELOPMENT ONLY. Live Cairo graph-constrained letter experiment.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';
import { polylineLength, resamplePolyline, type Vec2 } from '@/lib/geometry';
import { coordinatesToLocalMeters, offsetCoordinate } from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

import { locatePedestrianEdgeSets } from '../routing/valhalla';
import { projectWordPlacement } from './street-fit-search';
import {
  buildShapeGraph,
  GRAPH_SHAPE,
  GRAPH_SHAPE_EXPERIMENT,
  routeGraphConstrainedShape,
  type GraphShapeResult,
  type ShapeKind,
} from './graph-shape';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

export const GRAPH_SHAPE_TEST_LETTERS: ShapeKind[] = ['O', 'Z', 'L'];

export type GraphShapeLetterReport = {
  letter: ShapeKind;
  result: GraphShapeResult;
  target: Vec2[];
  graph: Vec2[][];
  graphEdgeCount: number;
  recognizableHint: boolean;
};

export type GraphShapeExperimentReport = {
  developmentOnly: true;
  experiment: 'graph-constrained-shape-router';
  enabled: boolean;
  start: Coordinate;
  targetDistanceMeters: number;
  letters: GraphShapeLetterReport[];
  textReport: string;
  svg: string;
  elapsedMs: number;
};

export async function runGraphShapeExperiment(input: {
  start?: Coordinate;
  targetDistanceMeters?: number;
} = {}): Promise<GraphShapeExperimentReport> {
  const started = Date.now();
  const start = input.start ?? { latitude: 30.0444, longitude: 31.2357 };
  const targetDistanceMeters = input.targetDistanceMeters ?? 900;
  const letters: GraphShapeLetterReport[] = [];

  for (const letter of GRAPH_SHAPE_TEST_LETTERS) {
    const word = buildWordShape(letter);
    const projected = projectWordPlacement(word, targetDistanceMeters, {
      rotationDegrees: 0,
      scale: 1,
      eastMeters: 0,
      northMeters: 0,
    });
    const target = projected.target;
    const graph = await collectCorridorGraph(start, target);
    const result = routeGraphConstrainedShape({
      target,
      graph: buildShapeGraph(graph.segments),
      kind: letter,
    });
    letters.push({
      letter,
      result,
      target,
      graph: graph.segments.map((segment) => segment.points),
      graphEdgeCount: graph.segments.length,
      recognizableHint: hintRecognizable(letter, result),
    });
  }

  const textReport = formatGraphShapeReport(letters, targetDistanceMeters);
  const svg = renderGraphShapeSvg(letters);

  return {
    developmentOnly: true,
    experiment: 'graph-constrained-shape-router',
    enabled: GRAPH_SHAPE_EXPERIMENT,
    start,
    targetDistanceMeters,
    letters,
    textReport,
    svg,
    elapsedMs: Date.now() - started,
  };
}

export function writeGraphShapeSvg(svg: string, filename = 'graph-shape-test.svg') {
  const path = resolve(DIAGNOSTIC_DIR, filename);
  writeFileSync(path, svg);
  return path;
}

export function formatGraphShapeReport(
  letters: GraphShapeLetterReport[],
  targetDistanceMeters: number,
): string {
  const lines = [
    'Graph-constrained shape router',
    `target distance ${targetDistanceMeters} m  corridor ${GRAPH_SHAPE.corridorMeters} m`,
    '',
  ];
  for (const item of letters) {
    const m = item.result.metrics;
    lines.push(`${item.letter}`);
    lines.push(`- route distance ${fmt(m.routeDistanceMeters)} m`);
    lines.push(`- target distance ${fmt(m.targetDistanceMeters)} m`);
    lines.push(`- perpendicular error ${fmt(m.perpendicularError)} m`);
    lines.push(`- heading agreement ${(m.headingAgreement * 100).toFixed(0)}%`);
    lines.push(`- target coverage ${(m.targetCoverage * 100).toFixed(0)}%`);
    lines.push(`- forward progress ${(m.forwardProgress * 100).toFixed(0)}%`);
    lines.push(`- backtracking ${(m.backtracking * 100).toFixed(0)}%`);
    lines.push(`- unique ways ${m.uniqueWays}`);
    lines.push(`- graph path length ${m.graphPathLength} verts, ${item.graphEdgeCount} corridor edges`);
    lines.push(`- final shape score ${m.shapeScore.toFixed(3)}`);
    lines.push(`- failure ${item.result.failure ?? 'none'}`);
    lines.push(`- recognizable hint ${item.recognizableHint ? 'maybe' : 'no'} (SVG is decisive)`);
    lines.push('');
  }
  return lines.join('\n');
}

async function collectCorridorGraph(origin: Coordinate, target: Vec2[]) {
  const length = polylineLength(target);
  const samples = resamplePolyline(target, Math.max(24, Math.round(length / 22)));
  const coordinates = samples.map((point) => offsetCoordinate(origin, point.x, point.y));
  const edgeSets = await locateInChunks(coordinates, GRAPH_SHAPE.corridorMeters);
  const seen = new Set<string>();
  const segments: Array<{ id: string; wayId: string; points: Vec2[] }> = [];

  for (const set of edgeSets) {
    for (const edge of set.edges) {
      const shape = edge.shape && edge.shape.length >= 2 ? edge.shape : null;
      if (!shape) {
        continue;
      }
      const id = edge.edgeId ?? `way:${edge.wayId ?? 'anon'}:${shape[0]?.latitude.toFixed(5)},${shape[0]?.longitude.toFixed(5)}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const points = coordinatesToLocalMeters(origin, shape);
      if (polylineLength(points) < 4) {
        continue;
      }
      segments.push({
        id,
        wayId: edge.wayId != null ? String(edge.wayId) : id,
        points,
      });
    }
  }
  return { segments };
}

async function locateInChunks(coordinates: Coordinate[], radius: number) {
  const chunkSize = 16;
  const results: Awaited<ReturnType<typeof locatePedestrianEdgeSets>> = [];
  for (let index = 0; index < coordinates.length; index += chunkSize) {
    const located = await locatePedestrianEdgeSets(coordinates.slice(index, index + chunkSize), radius, {
      verbose: true,
    });
    results.push(...located);
  }
  return results;
}

function hintRecognizable(letter: ShapeKind, result: GraphShapeResult): boolean {
  const m = result.metrics;
  if (result.failure || m.routeDistanceMeters <= 0) {
    return false;
  }
  if (m.targetCoverage < 0.55 || m.headingAgreement < 0.45 || m.forwardProgress < 0.55) {
    return false;
  }
  if (letter === 'O' && m.uniqueWays < 3) {
    return false;
  }
  return m.shapeScore >= 0.55;
}

function renderGraphShapeSvg(letters: GraphShapeLetterReport[]): string {
  const panels = letters.map((item, index) => renderPanel(item, index));
  const height = 420 * letters.length + 70;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 ${height}" width="1100" height="${height}">
  <rect width="100%" height="100%" fill="#f4f3ef"/>
  <text x="16" y="28" font-size="18" font-family="sans-serif" fill="#111">DEVELOPMENT / graph-constrained shape router</text>
  <text x="16" y="48" font-size="12" font-family="sans-serif" fill="#666">black dashed = ideal letter · gray = corridor streets · green = selected connected path · red = start · blue = end</text>
  ${panels.join('\n')}
</svg>`;
}

function renderPanel(item: GraphShapeLetterReport, index: number): string {
  const originY = 70 + index * 420;
  const all = [...item.target, ...item.result.pathPoints, ...item.graph.flat()];
  const xs = all.map((point) => point.x);
  const ys = all.map((point) => point.y);
  const minX = (xs.length ? Math.min(...xs) : 0) - 40;
  const maxX = (xs.length ? Math.max(...xs) : 100) + 40;
  const minY = (ys.length ? Math.min(...ys) : 0) - 40;
  const maxY = (ys.length ? Math.max(...ys) : 100) + 40;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const scale = Math.min(1060 / width, 340 / height);
  const ox = 20;
  const oy = originY;
  const project = (point: Vec2) => ({
    x: ox + (point.x - minX) * scale,
    y: oy + (maxY - point.y) * scale,
  });
  const toPoints = (line: Vec2[]) =>
    line
      .map((point) => {
        const projected = project(point);
        return `${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
      })
      .join(' ');

  const graphLines = item.graph
    .filter((line) => line.length >= 2)
    .map(
      (line) =>
        `<polyline points="${toPoints(line)}" fill="none" stroke="#d4cfc6" stroke-width="1.4" opacity="0.9"/>`,
    )
    .join('\n');
  const target = `<polyline points="${toPoints(item.target)}" fill="none" stroke="#111" stroke-width="3" stroke-dasharray="10 7" stroke-linejoin="round"/>`;
  const path =
    item.result.pathPoints.length >= 2
      ? `<polyline points="${toPoints(item.result.pathPoints)}" fill="none" stroke="#2a7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`
      : '';
  const start = item.result.pathPoints[0];
  const end = item.result.pathPoints[item.result.pathPoints.length - 1];
  const startDot = start
    ? `<circle cx="${project(start).x.toFixed(1)}" cy="${project(start).y.toFixed(1)}" r="6" fill="#c45"/>`
    : '';
  const endDot = end
    ? `<circle cx="${project(end).x.toFixed(1)}" cy="${project(end).y.toFixed(1)}" r="6" fill="#1a6bb5"/>`
    : '';
  const m = item.result.metrics;
  const label = `<text x="${ox}" y="${oy - 8}" font-size="16" font-family="sans-serif" fill="#111">${item.letter}  ${Math.round(m.routeDistanceMeters)} m  score ${m.shapeScore.toFixed(2)}  cov ${(m.targetCoverage * 100).toFixed(0)}%  ${item.result.failure ?? 'ok'}</text>`;

  return `${label}\n${graphLines}\n${target}\n${path}\n${startDot}\n${endDot}`;
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(1);
}
