/**
 * DEVELOPMENT ONLY. Deterministic synthetic graphs for the
 * graph-constrained shape router.
 *
 * A following path must beat a dense crossing grid. Disconnected,
 * reversed, detouring, and duplicated streets must not win.
 */
import {
  buildShapeGraph,
  routeGraphConstrainedShape,
  type GraphSegment,
  type ShapeKind,
} from './graph-shape';

type SelfTest = { name: string; passed: boolean; detail: string };

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
  segments.push({
    id: 'cross-origin',
    wayId: 'cross-origin',
    from: 'A',
    to: 'gx',
    points: [
      { x: 2, y: 80 },
      { x: 80, y: 80 },
    ],
  });
  return segments;
}

function oClockwise(): GraphSegment[] {
  return [
    {
      id: 'cw-n',
      wayId: 'cw-n',
      from: 'ON',
      to: 'NE',
      points: [
        { x: 50, y: 92 },
        { x: 92, y: 92 },
      ],
    },
    {
      id: 'cw-e',
      wayId: 'cw-e',
      from: 'NE',
      to: 'SE',
      points: [
        { x: 92, y: 92 },
        { x: 92, y: 8 },
      ],
    },
    {
      id: 'cw-s',
      wayId: 'cw-s',
      from: 'SE',
      to: 'SW',
      points: [
        { x: 92, y: 8 },
        { x: 8, y: 8 },
      ],
    },
    {
      id: 'cw-w',
      wayId: 'cw-w',
      from: 'SW',
      to: 'NW',
      points: [
        { x: 8, y: 8 },
        { x: 8, y: 92 },
      ],
    },
    {
      id: 'cw-close',
      wayId: 'cw-close',
      from: 'NW',
      to: 'ON',
      points: [
        { x: 8, y: 92 },
        { x: 50, y: 92 },
      ],
    },
  ];
}

function backwardsL(): GraphSegment[] {
  return [
    {
      id: 'to-end',
      wayId: 'to-end',
      from: 'A',
      to: 'C',
      points: [
        { x: 2, y: 80 },
        { x: 80, y: 2 },
      ],
    },
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
      to: 'A2',
      points: [
        { x: 2, y: 2 },
        { x: 2, y: 80 },
      ],
    },
  ];
}

function disconnectedClose(): GraphSegment[] {
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

function detourL(): GraphSegment[] {
  return [
    ...followingL(),
    {
      id: 'detour',
      wayId: 'detour',
      from: 'B',
      to: 'C',
      points: [
        { x: 2, y: 2 },
        { x: 2, y: -220 },
        { x: 220, y: -220 },
        { x: 220, y: 2 },
        { x: 80, y: 2 },
      ],
    },
  ];
}

function reversalL(): GraphSegment[] {
  return followingL();
}

function oTarget(): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index <= 24; index += 1) {
    const angle = Math.PI / 2 + (index / 24) * Math.PI * 2;
    points.push({
      x: 50 + 40 * Math.cos(angle),
      y: 50 + 40 * Math.sin(angle),
    });
  }
  return points;
}

function oLoop(): GraphSegment[] {
  const ring = [
    { id: 'o-n', from: 'ON', to: 'NW', points: [{ x: 50, y: 92 }, { x: 8, y: 92 }] },
    { id: 'o-w', from: 'NW', to: 'SW', points: [{ x: 8, y: 92 }, { x: 8, y: 8 }] },
    { id: 'o-s', from: 'SW', to: 'SE', points: [{ x: 8, y: 8 }, { x: 92, y: 8 }] },
    { id: 'o-e', from: 'SE', to: 'NE', points: [{ x: 92, y: 8 }, { x: 92, y: 92 }] },
    { id: 'o-close', from: 'NE', to: 'ON', points: [{ x: 92, y: 92 }, { x: 50, y: 92 }] },
  ];
  return ring.map((segment) => ({ ...segment, wayId: segment.id }));
}

function oInteriorGrid(): GraphSegment[] {
  const segments: GraphSegment[] = [];
  for (let x = 20; x <= 80; x += 15) {
    segments.push({
      id: `o-grid-v-${x}`,
      wayId: `o-grid-v-${x}`,
      from: `ogv${x}s`,
      to: `ogv${x}e`,
      points: [
        { x, y: 5 },
        { x, y: 95 },
      ],
    });
  }
  for (let y = 20; y <= 80; y += 15) {
    segments.push({
      id: `o-grid-h-${y}`,
      wayId: `o-grid-h-${y}`,
      from: `ogh${y}s`,
      to: `ogh${y}e`,
      points: [
        { x: 5, y },
        { x: 95, y },
      ],
    });
  }
  return segments;
}

function zTarget(): { x: number; y: number }[] {
  return [
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
}

function zFollowing(): GraphSegment[] {
  return [
    {
      id: 'z-top',
      wayId: 'z-top',
      from: 'ZT',
      to: 'ZTR',
      points: [
        { x: 2, y: 98 },
        { x: 98, y: 98 },
      ],
    },
    {
      id: 'z-diag',
      wayId: 'z-diag',
      from: 'ZTR',
      to: 'ZBL',
      points: [
        { x: 98, y: 98 },
        { x: 2, y: 2 },
      ],
    },
    {
      id: 'z-bot',
      wayId: 'z-bot',
      from: 'ZBL',
      to: 'ZBR',
      points: [
        { x: 2, y: 2 },
        { x: 98, y: 2 },
      ],
    },
  ];
}

function zGrid(): GraphSegment[] {
  const segments: GraphSegment[] = [];
  for (let x = 15; x <= 85; x += 14) {
    segments.push({
      id: `z-grid-v-${x}`,
      wayId: `z-grid-v-${x}`,
      from: `zgv${x}s`,
      to: `zgv${x}e`,
      points: [
        { x, y: -8 },
        { x, y: 108 },
      ],
    });
  }
  return segments;
}

function used(ways: readonly string[], prefix: string): boolean {
  return ways.some((way) => way === prefix || way.startsWith(prefix));
}

function route(kind: ShapeKind, target: { x: number; y: number }[], segments: GraphSegment[], multiLetter = false) {
  return routeGraphConstrainedShape({
    kind,
    target,
    graph: buildShapeGraph(segments),
    multiLetter,
  });
}

function run(): SelfTest[] {
  const mixedL = route('L', L_TARGET, [
    ...followingL(),
    ...crossingGrid(),
    ...backwardsL(),
    ...disconnectedClose(),
  ]);
  const onlyFollow = route('L', L_TARGET, followingL());
  const onlyGrid = route('L', L_TARGET, crossingGrid());
  const onlyIso = route('L', L_TARGET, disconnectedClose());
  const detour = route('L', L_TARGET, detourL());
  const reversal = route('L', L_TARGET, reversalL());
  const oFollow = route('O', oTarget(), [...oLoop(), ...oInteriorGrid()]);
  const oGrid = route('O', oTarget(), oInteriorGrid());
  const oCcw = route('O', oTarget(), oLoop());
  const oCw = route('O', oTarget(), oClockwise());
  const oBoth = route('O', oTarget(), [...oLoop(), ...oClockwise()]);
  const zFollow = route('Z', zTarget(), [...zFollowing(), ...zGrid()]);
  const lFollow = onlyFollow;
  const closedD = [
    { x: 10, y: 90 },
    { x: 10, y: 10 },
    { x: 55, y: 10 },
    { x: 78, y: 28 },
    { x: 78, y: 72 },
    { x: 55, y: 90 },
    { x: 10, y: 90 },
  ];
  const dFollow = route('generic', closedD, [
    {
      id: 'd-stem',
      wayId: 'd-stem',
      from: 'DS',
      to: 'DN',
      points: [
        { x: 12, y: 10 },
        { x: 12, y: 90 },
      ],
    },
    {
      id: 'd-n',
      wayId: 'd-n',
      from: 'DN',
      to: 'DNE',
      points: [
        { x: 12, y: 90 },
        { x: 55, y: 90 },
      ],
    },
    {
      id: 'd-e',
      wayId: 'd-e',
      from: 'DNE',
      to: 'DSE',
      points: [
        { x: 55, y: 90 },
        { x: 76, y: 72 },
        { x: 76, y: 28 },
        { x: 55, y: 10 },
      ],
    },
    {
      id: 'd-s',
      wayId: 'd-s',
      from: 'DSE',
      to: 'DS',
      points: [
        { x: 55, y: 10 },
        { x: 12, y: 10 },
      ],
    },
  ]);
  const eTarget = [
    { x: 70, y: 90 },
    { x: 10, y: 90 },
    { x: 10, y: 10 },
    { x: 70, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 50 },
    { x: 55, y: 50 },
  ];
  const eFollow = route('generic', eTarget, [
    {
      id: 'e-top',
      wayId: 'e-top',
      from: 'ETR',
      to: 'ETL',
      points: [
        { x: 70, y: 88 },
        { x: 12, y: 88 },
      ],
    },
    {
      id: 'e-stem-upper',
      wayId: 'e-stem-upper',
      from: 'ETL',
      to: 'EM',
      points: [
        { x: 12, y: 88 },
        { x: 12, y: 50 },
      ],
    },
    {
      id: 'e-stem-lower',
      wayId: 'e-stem-lower',
      from: 'EM',
      to: 'EBL',
      points: [
        { x: 12, y: 50 },
        { x: 12, y: 12 },
      ],
    },
    {
      id: 'e-bot',
      wayId: 'e-bot',
      from: 'EBL',
      to: 'EBR',
      points: [
        { x: 12, y: 12 },
        { x: 70, y: 12 },
      ],
    },
    {
      id: 'e-bar',
      wayId: 'e-bar',
      from: 'EM',
      to: 'EMR',
      points: [
        { x: 12, y: 50 },
        { x: 55, y: 50 },
      ],
    },
  ]);

  const mixedWays = mixedL.wayIds;
  const reversedBoth =
    reversal.edgeIds.some((id) => id.endsWith('>')) && reversal.edgeIds.some((id) => id.endsWith('<'));

  return [
    {
      name: 'A target-following path is selected',
      passed:
        mixedL.failure == null &&
        used(mixedWays, 'follow-v') &&
        used(mixedWays, 'follow-h') &&
        mixedL.metrics.connected,
      detail: `ways=${mixedWays.join(',')} fail=${mixedL.failure} score=${mixedL.metrics.graphShapeScore.toFixed(3)}`,
    },
    {
      name: 'B dense crossing grid does not win',
      passed:
        !mixedWays.some((way) => way.startsWith('grid-')) &&
        onlyFollow.metrics.graphShapeScore > onlyGrid.metrics.graphShapeScore &&
        (onlyGrid.failure != null || onlyGrid.metrics.targetCoverage < 0.5),
      detail: `usedGrid=${mixedWays.filter((way) => way.startsWith('grid-')).join(',') || 'none'} follow=${onlyFollow.metrics.graphShapeScore.toFixed(3)} grid=${onlyGrid.metrics.graphShapeScore.toFixed(3)} gridFail=${onlyGrid.failure}`,
    },
    {
      name: 'C backwards path is penalized',
      passed:
        oBoth.wayIds.some((way) => way.startsWith('o-')) &&
        !oBoth.wayIds.some((way) => way.startsWith('cw-')) &&
        oCcw.metrics.forwardProgress > 0.7,
      detail: `both=${oBoth.wayIds.join(',')} ccwFwd=${oCcw.metrics.forwardProgress.toFixed(2)} cwFwd=${oCw.metrics.forwardProgress.toFixed(2)}`,
    },
    {
      name: 'D disconnected edges are not one route',
      passed:
        !used(mixedWays, 'iso-') &&
        (!onlyIso.metrics.connected ||
          onlyIso.failure != null ||
          !(used(onlyIso.wayIds, 'iso-v') && used(onlyIso.wayIds, 'iso-h'))),
      detail: `mixedIso=${used(mixedWays, 'iso-')} isoWays=${onlyIso.wayIds.join(',')} isoFail=${onlyIso.failure} connected=${onlyIso.metrics.connected}`,
    },
    {
      name: 'E huge detour is penalized',
      passed: !used(detour.wayIds, 'detour') && used(detour.wayIds, 'follow-h'),
      detail: `ways=${detour.wayIds.join(',')} dist=${detour.metrics.routeDistanceMeters.toFixed(0)}`,
    },
    {
      name: 'F duplicate/reversal path is penalized',
      passed: !reversedBoth && reversal.metrics.repeatedWays === 0 && used(reversal.wayIds, 'follow-v'),
      detail: `repeated=${reversal.metrics.repeatedWays} edges=${reversal.edgeIds.join(',')}`,
    },
    {
      name: 'G O loop is selected over interior grid',
      passed:
        oFollow.failure == null &&
        oFollow.wayIds.some((way) => way.startsWith('o-')) &&
        !oFollow.wayIds.some((way) => way.startsWith('o-grid')) &&
        oFollow.metrics.graphShapeScore > oGrid.metrics.graphShapeScore,
      detail: `ways=${oFollow.wayIds.join(',')} score=${oFollow.metrics.graphShapeScore.toFixed(3)} grid=${oGrid.metrics.graphShapeScore.toFixed(3)} fail=${oFollow.failure}`,
    },
    {
      name: 'H Z following path is selected',
      passed:
        zFollow.failure == null &&
        used(zFollow.wayIds, 'z-top') &&
        used(zFollow.wayIds, 'z-diag') &&
        used(zFollow.wayIds, 'z-bot') &&
        !zFollow.wayIds.some((way) => way.startsWith('z-grid')),
      detail: `ways=${zFollow.wayIds.join(',')} fail=${zFollow.failure} score=${zFollow.metrics.graphShapeScore.toFixed(3)}`,
    },
    {
      name: 'I L following path is selected',
      passed:
        lFollow.failure == null &&
        used(lFollow.wayIds, 'follow-v') &&
        used(lFollow.wayIds, 'follow-h') &&
        lFollow.metrics.targetCoverage >= 0.6,
      detail: `ways=${lFollow.wayIds.join(',')} cov=${lFollow.metrics.targetCoverage.toFixed(2)} fail=${lFollow.failure}`,
    },
    {
      name: 'J closed generic D uses loop routing and covers the bowl',
      passed:
        dFollow.metrics.connected &&
        dFollow.metrics.targetCoverage >= 0.7 &&
        dFollow.metrics.routeDistanceMeters > 0,
      detail: `ways=${dFollow.wayIds.join(',')} cov=${dFollow.metrics.targetCoverage.toFixed(2)} fail=${dFollow.failure} back=${dFollow.metrics.backtracking.toFixed(2)}`,
    },
    {
      name: 'K walkable E covering can follow stem and middle bar',
      passed:
        eFollow.failure == null &&
        eFollow.metrics.connected &&
        used(eFollow.wayIds, 'e-bar') &&
        used(eFollow.wayIds, 'e-top') &&
        eFollow.metrics.targetCoverage >= 0.55,
      detail: `ways=${eFollow.wayIds.join(',')} cov=${eFollow.metrics.targetCoverage.toFixed(2)} fail=${eFollow.failure}`,
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
