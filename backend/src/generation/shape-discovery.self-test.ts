/**
 * DEVELOPMENT ONLY. Deterministic ranking tests for shape discovery.
 * Does not call Valhalla.
 */
import { buildShapeGraph, type GraphSegment } from './graph-shape';
import {
  candidateFromSearch,
  rankDiscoveryCandidates,
  type DiscoveryLocation,
} from './shape-discovery';

type SelfTest = { name: string; passed: boolean; detail: string };

const PLACE: DiscoveryLocation = {
  id: 'synth',
  name: 'Synthetic',
  latitude: 30.0444,
  longitude: 31.2357,
};

const L_TARGET = [
  { x: 0, y: 80 },
  { x: 0, y: 0 },
  { x: 80, y: 0 },
];

function followingL(): GraphSegment[] {
  return [
    {
      id: 'follow-v',
      wayId: 'follow-v',
      from: 'A',
      to: 'B',
      points: [
        { x: 2, y: 80 },
        { x: 2, y: 40 },
        { x: 2, y: 2 },
      ],
    },
    {
      id: 'follow-h',
      wayId: 'follow-h',
      from: 'B',
      to: 'C',
      points: [
        { x: 2, y: 2 },
        { x: 40, y: 2 },
        { x: 80, y: 2 },
      ],
    },
  ];
}

function crossingGrid(): GraphSegment[] {
  const segments: GraphSegment[] = [];
  for (let x = 10; x <= 70; x += 10) {
    segments.push({
      id: `grid-v-${x}`,
      wayId: `grid-v-${x}`,
      from: `gv${x}s`,
      to: `gv${x}e`,
      points: [
        { x, y: -10 },
        { x, y: 90 },
      ],
    });
  }
  for (let y = 10; y <= 70; y += 10) {
    segments.push({
      id: `grid-h-${y}`,
      wayId: `grid-h-${y}`,
      from: `gh${y}s`,
      to: `gh${y}e`,
      points: [
        { x: -10, y },
        { x: 90, y },
      ],
    });
  }
  return segments;
}

function disconnected(): GraphSegment[] {
  return [
    {
      id: 'iso-v',
      wayId: 'iso-v',
      from: 'X',
      to: 'Y',
      points: [
        { x: 6, y: 78 },
        { x: 6, y: 8 },
      ],
    },
    {
      id: 'iso-h',
      wayId: 'iso-h',
      from: 'W',
      to: 'Z',
      points: [
        { x: 40, y: 8 },
        { x: 80, y: 8 },
      ],
    },
  ];
}

function run(): SelfTest[] {
  const viable = candidateFromSearch({
    location: { ...PLACE, id: 'viable-small' },
    shape: 'L',
    targetDistanceMeters: 1500,
    target: L_TARGET,
    graph: buildShapeGraph(followingL()),
  });
  const dense = candidateFromSearch({
    location: { ...PLACE, id: 'dense-grid' },
    shape: 'L',
    targetDistanceMeters: 1500,
    target: L_TARGET,
    graph: buildShapeGraph(crossingGrid()),
  });
  const broken = candidateFromSearch({
    location: { ...PLACE, id: 'disconnected' },
    shape: 'L',
    targetDistanceMeters: 1500,
    target: L_TARGET,
    graph: buildShapeGraph(disconnected()),
  });
  const largeImpossible = candidateFromSearch({
    location: { ...PLACE, id: 'large-impossible' },
    shape: 'L',
    targetDistanceMeters: 4000,
    target: L_TARGET.map((point) => ({ x: point.x * 8, y: point.y * 8 })),
    graph: buildShapeGraph(crossingGrid()),
  });
  const ranked = rankDiscoveryCandidates([dense, largeImpossible, broken, viable]);
  const rankedAgain = rankDiscoveryCandidates([broken, viable, largeImpossible, dense]);

  return [
    {
      name: 'viable shape is ranked above an impossible shape',
      passed: ranked[0]?.locationId === 'viable-small' && viable.discoveryScore > dense.discoveryScore,
      detail: `first=${ranked[0]?.locationId} viable=${viable.discoveryScore.toFixed(3)} dense=${dense.discoveryScore.toFixed(3)} feasible=${viable.feasible}`,
    },
    {
      name: 'dense crossing streets do not rank highly',
      passed: !dense.feasible && dense.discoveryScore < viable.discoveryScore && ranked[0]?.locationId !== 'dense-grid',
      detail: `denseScore=${dense.discoveryScore.toFixed(3)} feasible=${dense.feasible} fail=${dense.failureReason}`,
    },
    {
      name: 'disconnected candidates are rejected',
      passed: !broken.feasible && (!broken.connected || broken.coverage < 0.55 || Boolean(broken.failureReason)),
      detail: `connected=${broken.connected} cov=${broken.coverage.toFixed(2)} fail=${broken.failureReason}`,
    },
    {
      name: 'smaller viable shapes can beat larger impossible ones',
      passed:
        viable.targetDistanceMeters < largeImpossible.targetDistanceMeters &&
        rankDiscoveryCandidates([largeImpossible, viable])[0]?.locationId === 'viable-small' &&
        viable.discoveryScore > largeImpossible.discoveryScore,
      detail: `small=${viable.discoveryScore.toFixed(3)} large=${largeImpossible.discoveryScore.toFixed(3)} largeFail=${largeImpossible.failureReason}`,
    },
    {
      name: 'results are deterministic',
      passed:
        ranked.map((item) => item.locationId).join(',') === rankedAgain.map((item) => item.locationId).join(','),
      detail: `order=${ranked.map((item) => item.locationId).join(',')}`,
    },
  ];
}

const tests = run();
for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
