import {
  HOME_BASE_STREETS,
  HOME_ROUTE_WIDTH,
  homeWordFromInput,
  layoutHomeRoutePoints,
  layoutHomeScene,
  routeBounds,
} from './home-street-path';

type Result = { name: string; passed: boolean; detail: string };

const SIZE = { width: 390, height: 300 };

const empty = layoutHomeRoutePoints('', SIZE);
const l = layoutHomeRoutePoints('L', SIZE);
const o = layoutHomeRoutePoints('O', SIZE);
const robz = layoutHomeRoutePoints('ROBZ', SIZE);
const lBounds = routeBounds(l);
const oBounds = routeBounds(o);
const robzBounds = routeBounds(robz);
const oFirst = o[0];
const oLast = o[o.length - 1];
const oGap =
  oFirst && oLast ? Math.hypot(oFirst.x - oLast.x, oFirst.y - oLast.y) : Number.POSITIVE_INFINITY;
const lScene = layoutHomeScene('L', SIZE);
const emptyScene = layoutHomeScene('', SIZE);
const IPHONE = { width: 390, height: 207 };
const PRO = { width: 430, height: 228 };
const iphoneEmpty = layoutHomeScene('', IPHONE);
const iphoneL = layoutHomeScene('L', IPHONE);
const iphoneLBounds = routeBounds(layoutHomeRoutePoints('L', IPHONE));
const proEmpty = layoutHomeScene('', PRO);
const proL = layoutHomeScene('L', PRO);
const proLBounds = routeBounds(layoutHomeRoutePoints('L', PRO));

const results: Result[] = [
  {
    name: 'input keeps letters only',
    passed: homeWordFromInput(' ro-bz! ') === 'ROBZ' && homeWordFromInput('') === '',
    detail: homeWordFromInput(' ro-bz! '),
  },
  {
    name: 'empty word has no route',
    passed: empty.length === 0 && emptyScene.route.length === 0 && emptyScene.streets.length > 8,
    detail: `route=${empty.length} streets=${emptyScene.streets.length}`,
  },
  {
    name: 'active route stroke is slightly thicker than the original 2.6',
    passed: HOME_ROUTE_WIDTH >= 2.99 && HOME_ROUTE_WIDTH <= 3.12,
    detail: `width=${HOME_ROUTE_WIDTH}`,
  },
  {
    name: 'base streets are a quiet irregular network',
    passed:
      HOME_BASE_STREETS.length >= 12 &&
      HOME_BASE_STREETS.every((line) => line.opacity >= 0.15 && line.opacity <= 0.18),
    detail: `n=${HOME_BASE_STREETS.length}`,
  },
  {
    name: 'L is taller than it is wide and turns toward the right',
    passed: Boolean(
      l.length >= 4 &&
        lBounds &&
        lBounds.height > lBounds.width * 0.7 &&
        (l[l.length - 1]?.x ?? 0) > (l[0]?.x ?? 0) + 20,
    ),
    detail: `pts=${l.length} ${lBounds?.width.toFixed(0)}x${lBounds?.height.toFixed(0)}`,
  },
  {
    name: 'O closes on itself',
    passed: o.length >= 8 && oGap < 18,
    detail: `pts=${o.length} gap=${oGap.toFixed(1)}`,
  },
  {
    name: 'ROBZ is wider than a single L',
    passed: Boolean(robz.length > l.length && robzBounds && lBounds && robzBounds.width > lBounds.width + 40),
    detail: `robz=${robz.length} w=${robzBounds?.width.toFixed(0)} lW=${lBounds?.width.toFixed(0)}`,
  },
  {
    name: 'L scene weaves the route into streets',
    passed: lScene.route.length >= 3 && lScene.streets.length > emptyScene.streets.length,
    detail: `route=${lScene.route.length} streets=${lScene.streets.length}`,
  },
  {
    name: '390x207 canvas still lays out streets and L',
    passed: Boolean(
      iphoneEmpty.streets.length > 8 &&
        iphoneEmpty.route.length === 0 &&
        iphoneL.route.length >= 3 &&
        iphoneLBounds &&
        iphoneLBounds.height > 80,
    ),
    detail: `streets=${iphoneEmpty.streets.length} lRoute=${iphoneL.route.length}`,
  },
  {
    name: '430x228 canvas still lays out streets and L',
    passed: Boolean(
      proEmpty.streets.length > 8 &&
        proL.route.length >= 3 &&
        proLBounds &&
        proLBounds.height > 80,
    ),
    detail: `streets=${proEmpty.streets.length} lRoute=${proL.route.length}`,
  },
];

for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
}
if (results.some((result) => !result.passed)) {
  process.exitCode = 1;
}
