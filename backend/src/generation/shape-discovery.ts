/**
 * DEVELOPMENT ONLY. Real-world shape discovery.
 *
 * Searches whether the Egypt pedestrian graph contains any location where
 * O / Z / L can actually be followed. Reuses the graph-constrained search
 * unchanged. Locate only — no Valhalla /route or /trace_route.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coordinate } from '@/lib/geo';
import {
  boundingBox2,
  distanceToPolyline,
  resamplePolyline,
  type Vec2,
} from '@/lib/geometry';
import { offsetCoordinate } from '@/lib/shape-projection';
import { buildWordShape } from '@/lib/word-shape';

import {
  collectNeighborhoodShapeGraph,
  startConnector,
  type ShapeGraphCollection,
} from './graph-shape-router';
import {
  GRAPH_SHAPE,
  buildShapeGraph,
  routeGraphConstrainedShape,
  snapNodeId,
  type GraphSegment,
  type GraphShapeResult,
  type ShapeGraph,
  type ShapeKind,
} from './graph-shape';
import { projectWordPlacement } from './street-fit-search';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

export const SHAPE_DISCOVERY_SHAPES: ShapeKind[] = ['O', 'Z', 'L'];
export const SHAPE_DISCOVERY_DISTANCES = [1500, 2000, 2500, 3000, 4000] as const;
export const SHAPE_DISCOVERY_ORIGIN: Coordinate = { latitude: 30.0444, longitude: 31.2357 };

export type DiscoveryLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};

export type DiscoveryCandidate = {
  locationId: string;
  locationName: string;
  latitude: number;
  longitude: number;
  shape: ShapeKind;
  targetDistanceMeters: number;
  actualPathMeters: number;
  coverage: number;
  headingAgreement: number;
  headingAgreementDegrees: number;
  meanPerpendicularError: number;
  forwardProgress: number;
  backtracking: number;
  largestGap: number;
  distanceRatio: number;
  connected: boolean;
  feasible: boolean;
  graphScore: number;
  discoveryScore: number;
  failureReason: string | null;
  graphEdgeCount: number;
  candidateEdgeCount: number;
  statesExplored: number;
  result: GraphShapeResult;
  target: Vec2[];
  graph: Vec2[][];
};

export type TopologyAudit = {
  graphEdges: number;
  nodes: number;
  endpointJoins: number;
  likelyIntersections: number;
  suspiciousJoins: number;
  missingMidBlockConnections: number;
  snapMeters: number;
};

export type ShapeDiscoveryReport = {
  developmentOnly: true;
  experiment: 'real-world-shape-discovery';
  locationsTested: number;
  shapesTested: number;
  distancesTested: number;
  combinations: number;
  graphEdgesExamined: number;
  searchStates: number;
  valhallaLocateCalls: number;
  valhallaRouteCalls: 0;
  elapsedMs: number;
  topology: TopologyAudit;
  candidates: DiscoveryCandidate[];
  bestByShape: Partial<Record<ShapeKind, DiscoveryCandidate>>;
  viableCount: number;
  noneViable: boolean;
  textReport: string;
  svg: string;
};

export function discoveryLocations(): DiscoveryLocation[] {
  const named: DiscoveryLocation[] = [
    { id: 'downtown', name: 'Downtown Cairo', latitude: 30.0444, longitude: 31.2357 },
    { id: 'zamalek', name: 'Zamalek', latitude: 30.0619, longitude: 31.2195 },
    { id: 'maadi', name: 'Maadi', latitude: 29.9606, longitude: 31.2577 },
    { id: 'new-cairo', name: 'New Cairo', latitude: 30.0084, longitude: 31.4915 },
    { id: 'heliopolis', name: 'Heliopolis', latitude: 30.0912, longitude: 31.3244 },
    { id: 'nasr-city', name: 'Nasr City', latitude: 30.0566, longitude: 31.3425 },
  ];
  const grid: DiscoveryLocation[] = [];
  for (const radius of [4000, 8000]) {
    for (let heading = 0; heading < 360; heading += 45) {
      const radians = (heading * Math.PI) / 180;
      const east = Math.round(Math.sin(radians) * radius);
      const north = Math.round(Math.cos(radians) * radius);
      const coordinate = offsetCoordinate(SHAPE_DISCOVERY_ORIGIN, east, north);
      grid.push({
        id: `downtown-r${radius}-h${heading}`,
        name: `Downtown ${radius / 1000}km ${heading}°`,
        latitude: Number(coordinate.latitude.toFixed(5)),
        longitude: Number(coordinate.longitude.toFixed(5)),
      });
    }
  }
  const merged = [...named];
  for (const point of grid) {
    const duplicate = merged.some((existing) => distanceApproxMeters(existing, point) < 900);
    if (!duplicate) {
      merged.push(point);
    }
  }
  return merged;
}

export function discoveryScore(result: GraphShapeResult): number {
  const metrics = result.metrics;
  if (!metrics.connected || metrics.routeDistanceMeters <= 0) {
    return 0;
  }
  const perp = Number.isFinite(metrics.meanPerpendicularError)
    ? 1 - Math.min(1, metrics.meanPerpendicularError / 50)
    : 0;
  const ratio = 1 - Math.min(1, Math.abs(metrics.distanceRatio - 1));
  const gap = 1 - Math.min(1, metrics.largestTargetProgressGap);
  return clamp01(
    0.3 * metrics.targetCoverage +
      0.18 * metrics.forwardProgress +
      0.16 * metrics.headingAgreement +
      0.12 * perp +
      0.1 * 1 +
      0.08 * (1 - metrics.backtracking) +
      0.04 * ratio +
      0.02 * gap,
  );
}

export function isFeasible(result: GraphShapeResult): boolean {
  const metrics = result.metrics;
  return (
    result.failure == null &&
    metrics.connected &&
    metrics.routeDistanceMeters > 0 &&
    metrics.targetCoverage >= 0.55 &&
    metrics.headingAgreement >= 0.45 &&
    metrics.forwardProgress >= 0.55 &&
    metrics.backtracking <= 0.4
  );
}

export function compareDiscoveryCandidates(a: DiscoveryCandidate, b: DiscoveryCandidate): number {
  if (a.feasible !== b.feasible) {
    return a.feasible ? -1 : 1;
  }
  if (a.discoveryScore !== b.discoveryScore) {
    return b.discoveryScore - a.discoveryScore;
  }
  if (a.coverage !== b.coverage) {
    return b.coverage - a.coverage;
  }
  if (a.shape !== b.shape) {
    return a.shape.localeCompare(b.shape);
  }
  if (a.targetDistanceMeters !== b.targetDistanceMeters) {
    return a.targetDistanceMeters - b.targetDistanceMeters;
  }
  return a.locationId.localeCompare(b.locationId);
}

export function rankDiscoveryCandidates(candidates: readonly DiscoveryCandidate[]): DiscoveryCandidate[] {
  return [...candidates].sort(compareDiscoveryCandidates);
}

export function evaluateDiscoveryCandidate(input: {
  location: DiscoveryLocation;
  shape: ShapeKind;
  targetDistanceMeters: number;
  collection: ShapeGraphCollection;
}): DiscoveryCandidate {
  const word = buildWordShape(input.shape);
  const projected = projectWordPlacement(word, input.targetDistanceMeters, {
    rotationDegrees: 0,
    scale: 1,
    eastMeters: 0,
    northMeters: 0,
  });
  const corridor = filterCorridorSegments(input.collection.segments, projected.target);
  return candidateFromSearch({
    location: input.location,
    shape: input.shape,
    targetDistanceMeters: input.targetDistanceMeters,
    target: projected.target,
    graph: buildShapeGraph(corridor),
    corridorPolylines: corridor.map((segment) => segment.points),
  });
}

export function candidateFromSearch(input: {
  location: DiscoveryLocation;
  shape: ShapeKind;
  targetDistanceMeters: number;
  target: readonly Vec2[];
  graph: ShapeGraph;
  corridorPolylines?: Vec2[][];
}): DiscoveryCandidate {
  const result = routeGraphConstrainedShape({
    target: input.target,
    kind: input.shape,
    graph: input.graph,
  });
  const metrics = result.metrics;
  return {
    locationId: input.location.id,
    locationName: input.location.name,
    latitude: input.location.latitude,
    longitude: input.location.longitude,
    shape: input.shape,
    targetDistanceMeters: input.targetDistanceMeters,
    actualPathMeters: metrics.routeDistanceMeters,
    coverage: metrics.targetCoverage,
    headingAgreement: metrics.headingAgreement,
    headingAgreementDegrees: metrics.headingAgreementDegrees,
    meanPerpendicularError: metrics.meanPerpendicularError,
    forwardProgress: metrics.forwardProgress,
    backtracking: metrics.backtracking,
    largestGap: metrics.largestTargetProgressGap,
    distanceRatio: metrics.distanceRatio,
    connected: metrics.connected,
    feasible: isFeasible(result),
    graphScore: metrics.graphShapeScore,
    discoveryScore: discoveryScore(result),
    failureReason: result.failureReason,
    graphEdgeCount: result.search.graphEdgeCount,
    candidateEdgeCount: result.search.candidateEdgeCount,
    statesExplored: result.search.statesExplored,
    result,
    target: input.target.map((point) => ({ ...point })),
    graph: input.corridorPolylines ?? input.graph.segments.map((segment) => segment.points),
  };
}

export function auditGraphTopology(graph: ShapeGraph): TopologyAudit {
  const snapMeters = GRAPH_SHAPE.nodeSnapMeters;
  const rawByNode = new Map<string, Vec2[]>();
  const degree = new Map<string, number>();
  for (const segment of graph.segments) {
    const start = segment.points[0];
    const end = segment.points[segment.points.length - 1];
    if (!start || !end) {
      continue;
    }
    pushNode(rawByNode, segment.from, start);
    pushNode(rawByNode, segment.to, end);
    degree.set(segment.from, (degree.get(segment.from) ?? 0) + 1);
    degree.set(segment.to, (degree.get(segment.to) ?? 0) + 1);
  }

  let endpointJoins = 0;
  let likelyIntersections = 0;
  let suspiciousJoins = 0;
  for (const [id, points] of rawByNode) {
    const incident = degree.get(id) ?? 0;
    if (incident < 2) {
      continue;
    }
    endpointJoins += 1;
    const spread = maxPairDistance(points);
    if (incident >= 3 && spread <= 3) {
      likelyIntersections += 1;
    } else if (spread > 3.5 && spread <= snapMeters + 0.5) {
      suspiciousJoins += 1;
    } else if (incident >= 3) {
      likelyIntersections += 1;
    }
  }

  let missingMidBlockConnections = 0;
  for (const segment of graph.segments) {
    if (segment.points.length < 3) {
      continue;
    }
    const interior = segment.points.slice(1, -1);
    const missing = interior.some((point) => {
      const id = snapNodeId(point);
      return Boolean(graph.nodes[id] && id !== segment.from && id !== segment.to);
    });
    if (missing) {
      missingMidBlockConnections += 1;
    }
  }

  return {
    graphEdges: graph.segments.length,
    nodes: Object.keys(graph.nodes).length,
    endpointJoins,
    likelyIntersections,
    suspiciousJoins,
    missingMidBlockConnections,
    snapMeters,
  };
}

export async function runShapeDiscovery(
  options: {
    locations?: DiscoveryLocation[];
    shapes?: ShapeKind[];
    distances?: number[];
  } = {},
): Promise<ShapeDiscoveryReport> {
  const started = Date.now();
  const locations = options.locations ?? discoveryLocations();
  const shapes = options.shapes ?? SHAPE_DISCOVERY_SHAPES;
  const distances = options.distances ?? [...SHAPE_DISCOVERY_DISTANCES];
  const candidates: DiscoveryCandidate[] = [];
  const topologyParts: TopologyAudit[] = [];
  let valhallaLocateCalls = 0;
  let graphEdgesExamined = 0;
  let searchStates = 0;

  for (const location of locations) {
    const origin = { latitude: location.latitude, longitude: location.longitude };
    const collection = await collectNeighborhoodShapeGraph(origin);
    valhallaLocateCalls += collection.valhallaCalls;
    graphEdgesExamined += collection.segments.length;
    topologyParts.push(auditGraphTopology(buildShapeGraph(collection.segments)));
    for (const shape of shapes) {
      for (const targetDistanceMeters of distances) {
        const candidate = evaluateDiscoveryCandidate({
          location,
          shape,
          targetDistanceMeters,
          collection,
        });
        searchStates += candidate.statesExplored;
        candidates.push(candidate);
      }
    }
  }

  const ranked = rankDiscoveryCandidates(candidates);
  const bestByShape: Partial<Record<ShapeKind, DiscoveryCandidate>> = {};
  for (const shape of shapes) {
    const best = ranked.find((item) => item.shape === shape);
    if (best) {
      bestByShape[shape] = best;
    }
  }
  const topology = mergeTopology(topologyParts);
  const viableCount = ranked.filter((item) => item.feasible).length;
  const noneViable = viableCount === 0;
  const elapsedMs = Date.now() - started;
  const textReport = formatDiscoveryReport({
    ranked,
    bestByShape,
    locationsTested: locations.length,
    shapesTested: shapes.length,
    distancesTested: distances.length,
    graphEdgesExamined,
    searchStates,
    valhallaLocateCalls,
    elapsedMs,
    topology,
    noneViable,
  });
  const svg = renderDiscoverySvg(bestByShape, noneViable);

  return {
    developmentOnly: true,
    experiment: 'real-world-shape-discovery',
    locationsTested: locations.length,
    shapesTested: shapes.length,
    distancesTested: distances.length,
    combinations: ranked.length,
    graphEdgesExamined,
    searchStates,
    valhallaLocateCalls,
    valhallaRouteCalls: 0,
    elapsedMs,
    topology,
    candidates: ranked,
    bestByShape,
    viableCount,
    noneViable,
    textReport,
    svg,
  };
}

export function writeShapeDiscoverySvg(svg: string, filename = 'shape-discovery.svg') {
  const path = resolve(DIAGNOSTIC_DIR, filename);
  writeFileSync(path, svg);
  return path;
}

export function formatDiscoveryReport(input: {
  ranked: DiscoveryCandidate[];
  bestByShape: Partial<Record<ShapeKind, DiscoveryCandidate>>;
  locationsTested: number;
  shapesTested: number;
  distancesTested: number;
  graphEdgesExamined: number;
  searchStates: number;
  valhallaLocateCalls: number;
  elapsedMs: number;
  topology: TopologyAudit;
  noneViable: boolean;
}): string {
  const lines = [
    'Real-world shape discovery (DEVELOPMENT ONLY)',
    'Search uses the existing graph-constrained router. No /route or /trace_route calls.',
    `locations ${input.locationsTested}  shapes ${input.shapesTested}  distances ${input.distancesTested}  combinations ${input.ranked.length}`,
    `graph edges examined ${input.graphEdgesExamined}  search states ${input.searchStates}`,
    `Valhalla locate ${input.valhallaLocateCalls}  Valhalla route 0  runtime ${input.elapsedMs} ms`,
    '',
    'Graph topology (reconstructed from locate polylines, 8 m endpoint snap):',
    `  edges ${input.topology.graphEdges}  nodes ${input.topology.nodes}`,
    `  endpoint joins ${input.topology.endpointJoins}  likely intersections ${input.topology.likelyIntersections}`,
    `  suspicious joins ${input.topology.suspiciousJoins}  missing mid-block connections ${input.topology.missingMidBlockConnections}`,
    '',
    'Shape | Distance | Location | Coverage | Heading | Error | Backtrack | Connected | Feasible',
    '------|----------|----------|----------|---------|-------|-----------|-----------|---------',
  ];
  for (const item of input.ranked) {
    lines.push(
      `${item.shape.padEnd(5)} | ${String(item.targetDistanceMeters).padStart(8)} | ${item.locationName.slice(0, 22).padEnd(22)} | ${pct(item.coverage).padStart(8)} | ${fmt(item.headingAgreementDegrees).padStart(7)} | ${fmt(item.meanPerpendicularError).padStart(5)} | ${pct(item.backtracking).padStart(9)} | ${String(item.connected).padStart(9)} | ${item.feasible ? 'yes' : 'no'}`,
    );
  }
  lines.push('');
  lines.push('Top candidates by shape:');
  for (const shape of SHAPE_DISCOVERY_SHAPES) {
    const best = input.bestByShape[shape];
    if (!best) {
      lines.push(`${shape}: none`);
      continue;
    }
    lines.push(`${shape}`);
    lines.push(`  location ${best.locationName}  ${best.latitude}, ${best.longitude}`);
    lines.push(`  target distance ${best.targetDistanceMeters} m  actual ${fmt(best.actualPathMeters)} m`);
    lines.push(`  coverage ${pct(best.coverage)}  heading ${fmt(best.headingAgreementDegrees)}°  error ${fmt(best.meanPerpendicularError)} m`);
    lines.push(`  forward ${pct(best.forwardProgress)}  backtrack ${pct(best.backtracking)}  max gap ${pct(best.largestGap)}`);
    lines.push(`  connected ${best.connected}  feasible ${best.feasible}  graph score ${best.graphScore.toFixed(3)}  discovery ${best.discoveryScore.toFixed(3)}`);
    lines.push(`  failure ${best.failureReason ?? 'none'}`);
    lines.push(`  recognizable hint ${best.feasible ? 'maybe' : 'no'} (SVG is decisive)`);
  }
  lines.push('');
  if (input.noneViable) {
    lines.push('No viable real-world shape found in the tested Egypt graph.');
  } else {
    lines.push(`${input.ranked.filter((item) => item.feasible).length} feasible candidate(s). SVG is the acceptance check.`);
  }
  return lines.join('\n');
}

export function filterCorridorSegments(
  segments: Array<Omit<GraphSegment, 'from' | 'to'> | GraphSegment>,
  target: readonly Vec2[],
): Array<Omit<GraphSegment, 'from' | 'to'>> {
  const box = boundingBox2(target);
  if (!box) {
    return [];
  }
  const pad = GRAPH_SHAPE.corridorMeters;
  return segments.filter((segment) => {
    if (segment.points.length < 2) {
      return false;
    }
    const inBox = segment.points.some(
      (point) =>
        point.x >= box.minX - pad &&
        point.x <= box.maxX + pad &&
        point.y >= box.minY - pad &&
        point.y <= box.maxY + pad,
    );
    if (!inBox) {
      return false;
    }
    return segment.points.some((point) => distanceToPolyline(point, target) <= pad);
  });
}

function renderDiscoverySvg(
  bestByShape: Partial<Record<ShapeKind, DiscoveryCandidate>>,
  noneViable: boolean,
): string {
  const panels = SHAPE_DISCOVERY_SHAPES.map((shape, index) => {
    const item = bestByShape[shape];
    if (!item) {
      return `<text x="20" y="${120 + index * 460}" font-size="16" font-family="sans-serif">No ${shape} candidate</text>`;
    }
    return renderPanel(item, index);
  });
  const height = 460 * SHAPE_DISCOVERY_SHAPES.length + 100;
  const verdict = noneViable
    ? 'No viable real-world shape found in the tested Egypt graph. SVG is the authority — do not treat a high numeric score as success.'
    : 'Best candidate per shape. Visual recognizability is the authority, not the numeric score.';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 ${height}" width="1100" height="${height}">
  <rect width="100%" height="100%" fill="#f4f3ef"/>
  <text x="16" y="26" font-size="18" font-family="sans-serif" fill="#111">DEVELOPMENT / real-world shape discovery</text>
  <text x="16" y="46" font-size="12" font-family="sans-serif" fill="#666">dashed black = ideal · gray = nearby streets · green = selected connected path · red start · blue end · arrows = target progress</text>
  <text x="16" y="64" font-size="12" font-family="sans-serif" fill="#666">${verdict}</text>
  ${panels.join('\n')}
</svg>`;
}

function renderPanel(item: DiscoveryCandidate, index: number): string {
  const originY = 96 + index * 460;
  const connector = startConnector({ x: 0, y: 0 }, item.result.pathPoints[0]);
  const all = [...item.target, ...item.result.pathPoints, ...item.graph.flat(), ...connector.points, { x: 0, y: 0 }];
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
  const project = (point: Vec2) => ({
    x: ox + (point.x - minX) * scale,
    y: originY + (maxY - point.y) * scale,
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
    .map((line) => `<polyline points="${toPoints(line)}" fill="none" stroke="#d4cfc6" stroke-width="1.3" opacity="0.85"/>`)
    .join('\n');
  const target = `<polyline points="${toPoints(item.target)}" fill="none" stroke="#111" stroke-width="3" stroke-dasharray="10 7" stroke-linejoin="round"/>`;
  const arrows = progressArrows(item.target, project);
  const path =
    item.result.pathPoints.length >= 2
      ? `<polyline points="${toPoints(item.result.pathPoints)}" fill="none" stroke="#2a7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>`
      : '';
  const start = item.result.pathPoints[0];
  const end = item.result.pathPoints[item.result.pathPoints.length - 1];
  const startDot = start
    ? `<circle cx="${project(start).x.toFixed(1)}" cy="${project(start).y.toFixed(1)}" r="6" fill="#c45"/>`
    : '';
  const endDot = end
    ? `<circle cx="${project(end).x.toFixed(1)}" cy="${project(end).y.toFixed(1)}" r="6" fill="#1a6bb5"/>`
    : '';
  const label = `<text x="${ox}" y="${originY - 10}" font-size="14" font-family="sans-serif" fill="#111">${item.shape}  ${item.locationName}  ${item.targetDistanceMeters} m  cov ${pct(item.coverage)}  ${item.feasible ? 'feasible?' : item.failureReason ?? 'not feasible'}</text>`;
  return `${label}\n${graphLines}\n${target}\n${arrows}\n${path}\n${startDot}\n${endDot}`;
}

function progressArrows(target: Vec2[], project: (point: Vec2) => { x: number; y: number }): string {
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

function mergeTopology(parts: TopologyAudit[]): TopologyAudit {
  if (parts.length === 0) {
    return {
      graphEdges: 0,
      nodes: 0,
      endpointJoins: 0,
      likelyIntersections: 0,
      suspiciousJoins: 0,
      missingMidBlockConnections: 0,
      snapMeters: GRAPH_SHAPE.nodeSnapMeters,
    };
  }
  return parts.reduce(
    (sum, part) => ({
      graphEdges: sum.graphEdges + part.graphEdges,
      nodes: sum.nodes + part.nodes,
      endpointJoins: sum.endpointJoins + part.endpointJoins,
      likelyIntersections: sum.likelyIntersections + part.likelyIntersections,
      suspiciousJoins: sum.suspiciousJoins + part.suspiciousJoins,
      missingMidBlockConnections: sum.missingMidBlockConnections + part.missingMidBlockConnections,
      snapMeters: GRAPH_SHAPE.nodeSnapMeters,
    }),
    {
      graphEdges: 0,
      nodes: 0,
      endpointJoins: 0,
      likelyIntersections: 0,
      suspiciousJoins: 0,
      missingMidBlockConnections: 0,
      snapMeters: GRAPH_SHAPE.nodeSnapMeters,
    },
  );
}

function pushNode(map: Map<string, Vec2[]>, id: string, point: Vec2) {
  const list = map.get(id) ?? [];
  list.push(point);
  map.set(id, list);
}

function maxPairDistance(points: Vec2[]): number {
  let max = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      if (!a || !b) {
        continue;
      }
      max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return max;
}

function distanceApproxMeters(a: DiscoveryLocation, b: DiscoveryLocation): number {
  const east = (b.longitude - a.longitude) * 111320 * Math.cos((a.latitude * Math.PI) / 180);
  const north = (b.latitude - a.latitude) * 111320;
  return Math.hypot(east, north);
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

function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(1);
}

function pct(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${Math.round(value * 100)}%`;
}
