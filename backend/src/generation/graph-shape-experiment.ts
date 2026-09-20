/**
 * DEVELOPMENT ONLY. Live Cairo graph-constrained letter experiment.
 *
 * Default location is downtown Cairo. Do not move it to manufacture a
 * successful-looking result. Shape recognizability is judged from the SVG,
 * not from numeric coverage.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';
import { resamplePolyline, type Vec2 } from '@/lib/geometry';
import { buildWordShape } from '@/lib/word-shape';

import {
  collectPedestrianShapeGraph,
  startConnector,
  type StartConnector,
} from './graph-shape-router';
import {
  GRAPH_SHAPE,
  GRAPH_SHAPE_EXPERIMENT,
  buildShapeGraph,
  routeGraphConstrainedShape,
  type GraphShapeResult,
  type ShapeKind,
} from './graph-shape';
import { projectWordPlacement } from './street-fit-search';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

export const GRAPH_SHAPE_TEST_LETTERS: ShapeKind[] = ['O', 'Z', 'L'];
export const GRAPH_SHAPE_DEFAULT_START: Coordinate = { latitude: 30.0444, longitude: 31.2357 };
export const GRAPH_SHAPE_SECOND_START: Coordinate = { latitude: 30.0626, longitude: 31.2196 };
export const GRAPH_SHAPE_DEFAULT_DISTANCE = 4000;

export type GraphShapeLetterReport = {
  letter: ShapeKind;
  result: GraphShapeResult;
  target: Vec2[];
  graph: Vec2[][];
  graphEdgeCount: number;
  candidateEdgeCount: number;
  statesExplored: number;
  valhallaCalls: number;
  connector: StartConnector;
  recognizableHint: boolean;
};

export type GraphShapeExperimentReport = {
  developmentOnly: true;
  experiment: 'graph-constrained-shape-router';
  enabled: boolean;
  start: Coordinate;
  targetDistanceMeters: number;
  rotationDegrees: number;
  scale: number;
  letters: GraphShapeLetterReport[];
  textReport: string;
  svg: string;
  elapsedMs: number;
  valhallaCalls: number;
};

export type GraphShapeExperimentInput = {
  start?: Coordinate;
  targetDistanceMeters?: number;
  rotationDegrees?: number;
  scale?: number;
  letters?: ShapeKind[];
};

export async function runGraphShapeExperiment(
  input: GraphShapeExperimentInput = {},
): Promise<GraphShapeExperimentReport> {
  const started = Date.now();
  const start = input.start ?? GRAPH_SHAPE_DEFAULT_START;
  const targetDistanceMeters = input.targetDistanceMeters ?? GRAPH_SHAPE_DEFAULT_DISTANCE;
  const rotationDegrees = input.rotationDegrees ?? 0;
  const scale = input.scale ?? 1;
  const requested = input.letters?.length ? input.letters : GRAPH_SHAPE_TEST_LETTERS;
  const letters: GraphShapeLetterReport[] = [];

  for (const letter of requested) {
    const word = buildWordShape(letter);
    const projected = projectWordPlacement(word, targetDistanceMeters, {
      rotationDegrees,
      scale,
      eastMeters: 0,
      northMeters: 0,
    });
    const target = projected.target;
    const collection = await collectPedestrianShapeGraph(start, target);
    const result = routeGraphConstrainedShape({
      target,
      graph: buildShapeGraph(collection.segments),
      kind: letter,
    });
    letters.push({
      letter,
      result,
      target,
      graph: collection.segments.map((segment) => segment.points),
      graphEdgeCount: collection.segments.length,
      candidateEdgeCount: result.search.candidateEdgeCount,
      statesExplored: result.search.statesExplored,
      valhallaCalls: collection.valhallaCalls,
      connector: startConnector({ x: 0, y: 0 }, result.pathPoints[0]),
      recognizableHint: hintRecognizable(letter, result),
    });
  }

  const valhallaCalls = letters.reduce((sum, item) => sum + item.valhallaCalls, 0);
  const textReport = formatGraphShapeReport({
    letters,
    start,
    targetDistanceMeters,
    rotationDegrees,
    scale,
    elapsedMs: Date.now() - started,
    valhallaCalls,
  });
  const svg = renderGraphShapeSvg(letters, start, targetDistanceMeters);

  return {
    developmentOnly: true,
    experiment: 'graph-constrained-shape-router',
    enabled: GRAPH_SHAPE_EXPERIMENT,
    start,
    targetDistanceMeters,
    rotationDegrees,
    scale,
    letters,
    textReport,
    svg,
    elapsedMs: Date.now() - started,
    valhallaCalls,
  };
}

export function writeGraphShapeSvg(svg: string, filename = 'graph-shape-test.svg') {
  const path = resolve(DIAGNOSTIC_DIR, filename);
  writeFileSync(path, svg);
  return path;
}

export function formatGraphShapeReport(input: {
  letters: GraphShapeLetterReport[];
  start: Coordinate;
  targetDistanceMeters: number;
  rotationDegrees: number;
  scale: number;
  elapsedMs: number;
  valhallaCalls: number;
}): string {
  const lines = [
    'Graph-constrained shape router (DEVELOPMENT ONLY)',
    `start ${input.start.latitude}, ${input.start.longitude}`,
    `requested target distance ${input.targetDistanceMeters} m  rotation ${input.rotationDegrees}  scale ${input.scale}`,
    `corridor ${GRAPH_SHAPE.corridorMeters} m  runtime ${input.elapsedMs} ms  Valhalla calls ${input.valhallaCalls}`,
    'Connectivity from Valhalla locate edge polylines (endpoint snap). No invented mid-block joins.',
    'Shape metrics exclude the start connector. SVG is the acceptance check, not the numeric score.',
    '',
  ];
  for (const item of input.letters) {
    const m = item.result.metrics;
    lines.push(`target: ${item.letter}`);
    lines.push(`target distance: ${fmt(m.targetDistanceMeters)} m`);
    lines.push(`actual graph path: ${fmt(m.routeDistanceMeters)} m`);
    lines.push(`distance ratio: ${fmt(m.distanceRatio)}`);
    lines.push(`target coverage: ${pct(m.targetCoverage)}`);
    lines.push(`forward progress: ${pct(m.forwardProgress)}`);
    lines.push(`mean perpendicular error: ${fmt(m.meanPerpendicularError)} m`);
    lines.push(`max perpendicular error: ${fmt(m.maxPerpendicularError)} m`);
    lines.push(`heading agreement: ${fmt(m.headingAgreementDegrees)}°`);
    lines.push(`progress span: ${pct(m.progressSpan)}`);
    lines.push(`backtracking: ${pct(m.backtracking)}`);
    lines.push(`unique ways: ${m.uniqueWays}`);
    lines.push(`repeated ways: ${m.repeatedWays}`);
    lines.push(`largest target-progress gap: ${pct(m.largestTargetProgressGap)}`);
    lines.push(`connected: ${m.connected}`);
    lines.push(`graph-shape score: ${m.graphShapeScore.toFixed(3)}`);
    lines.push(`shape-match score (not search objective): ${m.shapeScore.toFixed(3)}`);
    lines.push(`start connector: ${fmt(item.connector.lengthMeters)} m (excluded from shape score)`);
    lines.push(
      `graph edges: ${item.graphEdgeCount}  candidate edges: ${item.candidateEdgeCount}  search states: ${item.statesExplored}  Valhalla calls: ${item.valhallaCalls}`,
    );
    lines.push(`regions: ${item.result.regions.map((region) => region.id).join(' → ') || 'none'}`);
    lines.push(`failure: ${item.result.failureReason ?? 'none'}`);
    lines.push(`recognizable hint: ${item.recognizableHint ? 'maybe' : 'no'} (SVG is decisive)`);
    lines.push('');
  }
  return lines.join('\n');
}

function hintRecognizable(letter: ShapeKind, result: GraphShapeResult): boolean {
  const m = result.metrics;
  if (result.failure || m.routeDistanceMeters <= 0 || !m.connected) {
    return false;
  }
  if (m.targetCoverage < 0.55 || m.headingAgreement < 0.45 || m.forwardProgress < 0.55) {
    return false;
  }
  if (letter === 'O' && m.uniqueWays < 3) {
    return false;
  }
  return m.graphShapeScore >= 0.5;
}

function renderGraphShapeSvg(
  letters: GraphShapeLetterReport[],
  start: Coordinate,
  targetDistanceMeters: number,
): string {
  const panels = letters.map((item, index) => renderPanel(item, index));
  const height = 460 * Math.max(letters.length, 1) + 90;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 ${height}" width="1100" height="${height}">
  <rect width="100%" height="100%" fill="#f4f3ef"/>
  <text x="16" y="26" font-size="18" font-family="sans-serif" fill="#111">DEVELOPMENT / graph-constrained shape router</text>
  <text x="16" y="46" font-size="12" font-family="sans-serif" fill="#666">${start.latitude}, ${start.longitude} · requested ${targetDistanceMeters} m · dashed black = ideal · gray = nearby streets · green = selected connected path · orange = start connector · red start · blue end · arrows = target progress</text>
  <text x="16" y="64" font-size="12" font-family="sans-serif" fill="#666">Do not treat numeric coverage as success. A dense grid can sit 1 m from the ink without following the letter.</text>
  ${panels.join('\n')}
</svg>`;
}

function renderPanel(item: GraphShapeLetterReport, index: number): string {
  const originY = 92 + index * 460;
  const all = [
    ...item.target,
    ...item.result.pathPoints,
    ...item.graph.flat(),
    ...item.connector.points,
    { x: 0, y: 0 },
  ];
  const xs = all.map((point) => point.x);
  const ys = all.map((point) => point.y);
  const minX = (xs.length ? Math.min(...xs) : 0) - 40;
  const maxX = (xs.length ? Math.max(...xs) : 100) + 40;
  const minY = (ys.length ? Math.min(...ys) : 0) - 40;
  const maxY = (ys.length ? Math.max(...ys) : 100) + 40;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const scale = Math.min(1060 / width, 360 / height);
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
        `<polyline points="${toPoints(line)}" fill="none" stroke="#d4cfc6" stroke-width="1.4" opacity="0.85"/>`,
    )
    .join('\n');
  const target = `<polyline points="${toPoints(item.target)}" fill="none" stroke="#111" stroke-width="3" stroke-dasharray="10 7" stroke-linejoin="round"/>`;
  const arrows = progressArrows(item.target, project);
  const path =
    item.result.pathPoints.length >= 2
      ? `<polyline points="${toPoints(item.result.pathPoints)}" fill="none" stroke="#2a7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>`
      : '';
  const connector =
    item.connector.points.length >= 2
      ? `<polyline points="${toPoints(item.connector.points)}" fill="none" stroke="#d9782c" stroke-width="2.5" stroke-dasharray="5 4"/>`
      : '';
  const transitions = item.result.transitions
    .map((point) => {
      const projected = project(point);
      return `<rect x="${(projected.x - 4).toFixed(1)}" y="${(projected.y - 4).toFixed(1)}" width="8" height="8" fill="#7a4" stroke="#163" stroke-width="1"/>`;
    })
    .join('\n');
  const start = item.result.pathPoints[0];
  const end = item.result.pathPoints[item.result.pathPoints.length - 1];
  const origin = project({ x: 0, y: 0 });
  const startDot = start
    ? `<circle cx="${project(start).x.toFixed(1)}" cy="${project(start).y.toFixed(1)}" r="6" fill="#c45"/>`
    : '';
  const endDot = end
    ? `<circle cx="${project(end).x.toFixed(1)}" cy="${project(end).y.toFixed(1)}" r="6" fill="#1a6bb5"/>`
    : '';
  const originDot = `<circle cx="${origin.x.toFixed(1)}" cy="${origin.y.toFixed(1)}" r="4" fill="#111"/>`;
  const m = item.result.metrics;
  const label = `<text x="${ox}" y="${oy - 10}" font-size="15" font-family="sans-serif" fill="#111">${item.letter}  path ${Math.round(m.routeDistanceMeters)} m / ${Math.round(m.targetDistanceMeters)} m  cov ${pct(m.targetCoverage)}  follow ${fmt(m.headingAgreementDegrees)}°  ${item.result.failureReason ?? 'ok'}</text>`;

  return `${label}\n${graphLines}\n${target}\n${arrows}\n${connector}\n${path}\n${transitions}\n${originDot}\n${startDot}\n${endDot}`;
}

function progressArrows(
  target: Vec2[],
  project: (point: Vec2) => { x: number; y: number },
): string {
  if (target.length < 2) {
    return '';
  }
  const samples = resamplePolyline(target, 9).slice(1, 8);
  return samples
    .map((point, index) => {
      const previous = samples[index - 1] ?? target[0];
      if (!previous) {
        return '';
      }
      const from = project(previous);
      const to = project(point);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const left = {
        x: to.x - 8 * Math.cos(angle - 0.45),
        y: to.y - 8 * Math.sin(angle - 0.45),
      };
      const right = {
        x: to.x - 8 * Math.cos(angle + 0.45),
        y: to.y - 8 * Math.sin(angle + 0.45),
      };
      return `<polygon points="${to.x.toFixed(1)},${to.y.toFixed(1)} ${left.x.toFixed(1)},${left.y.toFixed(1)} ${right.x.toFixed(1)},${right.y.toFixed(1)}" fill="#111" opacity="0.7"/>`;
    })
    .join('\n');
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(2);
}

function pct(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${(value * 100).toFixed(0)}%`;
}
