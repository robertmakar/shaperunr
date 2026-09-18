import {
  buildShapeGraph,
  routeGraphConstrainedShape,
  type GraphSegment,
} from './graph-shape';

type SelfTest = { name: string; passed: boolean; detail: string };

const TARGET = [
  { x: 0, y: 80 },
  { x: 0, y: 0 },
  { x: 80, y: 0 },
];

function followingSegments(): GraphSegment[] {
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

function crossingGridSegments(): GraphSegment[] {
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
  segments.push({
    id: 'grid-link',
    wayId: 'grid-link',
    from: 'B',
    to: 'gv10s',
    points: [
      { x: 2, y: 2 },
      { x: 10, y: -10 },
    ],
  });
  return segments;
}

function backwardsSegments(): GraphSegment[] {
  return [
    {
      id: 'back-h',
      wayId: 'back-h',
      from: 'C',
      to: 'B',
      points: [
        { x: 80, y: 2 },
        { x: 2, y: 2 },
      ],
    },
    {
      id: 'back-v',
      wayId: 'back-v',
      from: 'B',
      to: 'A',
      points: [
        { x: 2, y: 2 },
        { x: 2, y: 80 },
      ],
    },
  ];
}

function disconnectedCloseSegments(): GraphSegment[] {
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
      from: 'Y',
      to: 'Z',
      points: [
        { x: 6, y: 8 },
        { x: 70, y: 8 },
      ],
    },
  ];
}

function run(): SelfTest[] {
  const graph = buildShapeGraph([
    ...followingSegments(),
    ...crossingGridSegments(),
    ...backwardsSegments(),
    ...disconnectedCloseSegments(),
  ]);
  const result = routeGraphConstrainedShape({ target: TARGET, graph, kind: 'L' });
  const ways = new Set(result.wayIds);
  const points = result.pathPoints;

  const followsVertical = points.some((point) => point.x < 8 && point.y > 30);
  const followsHorizontal = points.some((point) => point.y < 8 && point.x > 30);
  const usedGrid = [...ways].some((way) => way.startsWith('grid-'));
  const usedIso = [...ways].some((way) => way.startsWith('iso-'));
  const usedBackOnly = ways.has('back-v') && ways.has('back-h') && !ways.has('follow-v');

  const onlyFollow = routeGraphConstrainedShape({
    target: TARGET,
    graph: buildShapeGraph(followingSegments()),
    kind: 'L',
  });
  const onlyGrid = routeGraphConstrainedShape({
    target: TARGET,
    graph: buildShapeGraph(crossingGridSegments()),
    kind: 'L',
  });

  return [
    {
      name: 'selects the connected target-following path',
      passed:
        result.failure == null &&
        ways.has('follow-v') &&
        ways.has('follow-h') &&
        followsVertical &&
        followsHorizontal,
      detail: `ways=${[...ways].join(',')} fail=${result.failure} score=${result.metrics.shapeScore.toFixed(3)}`,
    },
    {
      name: 'dense crossing grid does not win',
      passed: !usedGrid && onlyFollow.metrics.shapeScore > onlyGrid.metrics.shapeScore,
      detail: `usedGrid=${usedGrid} follow=${onlyFollow.metrics.shapeScore.toFixed(3)} grid=${onlyGrid.metrics.shapeScore.toFixed(3)}`,
    },
    {
      name: 'backwards path is not selected from the letter start',
      passed: !usedBackOnly && result.metrics.forwardProgress > 0.7,
      detail: `forward=${result.metrics.forwardProgress.toFixed(2)} ways=${[...ways].join(',')}`,
    },
    {
      name: 'disconnected close path is not selected',
      passed: !usedIso && (result.startNode === 'B' || result.edgeIds[0]?.startsWith('follow')),
      detail: `usedIso=${usedIso} start=${result.startNode} first=${result.edgeIds[0]}`,
    },
    {
      name: 'following path covers the L',
      passed: result.metrics.targetCoverage >= 0.6 && result.metrics.routeDistanceMeters > 100,
      detail: `coverage=${result.metrics.targetCoverage.toFixed(2)} dist=${result.metrics.routeDistanceMeters.toFixed(0)}`,
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
