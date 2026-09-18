import { selectShapeAnchors } from '@/lib/shape-anchors';

import {
  collapseDuplicateAnchors,
  concatenateRouteCoordinates,
  pickConstrainedSnap,
  type OrderedAnchor,
} from './ordered-street-route';

type SelfTest = { name: string; passed: boolean; detail: string };

function run(): SelfTest[] {
  const straight = selectShapeAnchors(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    { minCount: 2, maxCount: 4 },
  );
  const corner = selectShapeAnchors(
    [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 6 },
    ],
    { minCount: 3, maxCount: 6 },
  );
  const bowl = selectShapeAnchors(
    Array.from({ length: 37 }, (_, index) => {
      const angle = (index / 36) * Math.PI * 2;
      return { x: Math.cos(angle), y: Math.sin(angle) };
    }),
    { minCount: 8, maxCount: 12 },
  );
  const z = selectShapeAnchors(
    [
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    { minCount: 4, maxCount: 8 },
  );

  const xs = bowl.map((point) => point.x);
  const ys = bowl.map((point) => point.y);
  const hasLeft = Math.min(...xs) < -0.7;
  const hasRight = Math.max(...xs) > 0.7;
  const hasBottom = Math.min(...ys) < -0.7;
  const hasTop = Math.max(...ys) > 0.7;

  const farEdge = {
    snapped: { latitude: 30.05, longitude: 31.24 },
    wayId: 2,
    distanceMeters: 55,
  };
  const closeParallel = {
    snapped: { latitude: 30.0446, longitude: 31.2365 },
    wayId: 2,
    distanceMeters: 6,
  };
  const continuation = {
    snapped: { latitude: 30.0445, longitude: 31.236 },
    wayId: 1,
    distanceMeters: 12,
  };
  const previous: OrderedAnchor = {
    input: { latitude: 30.0444, longitude: 31.2357 },
    snapped: { latitude: 30.0444, longitude: 31.2358 },
    wayId: 1,
    distanceMeters: 8,
  };
  const chosen = pickConstrainedSnap([farEdge, closeParallel, continuation], previous.input, previous);
  const rejected = pickConstrainedSnap([farEdge], previous.input, previous);

  const collapsed = collapseDuplicateAnchors([
    previous,
    {
      input: { latitude: 30.04441, longitude: 31.23571 },
      snapped: { latitude: 30.04441, longitude: 31.23581 },
      wayId: 1,
      distanceMeters: 4,
    },
    {
      input: { latitude: 30.045, longitude: 31.237 },
      snapped: { latitude: 30.045, longitude: 31.237 },
      wayId: 3,
      distanceMeters: 5,
    },
  ]);

  const concatenated = concatenateRouteCoordinates([
    [
      { latitude: 1, longitude: 1 },
      { latitude: 2, longitude: 2 },
    ],
    [
      { latitude: 2, longitude: 2 },
      { latitude: 3, longitude: 3 },
    ],
  ]);

  return [
    {
      name: 'straight stroke simplification keeps endpoints, not a dense sample',
      passed: straight.length === 2 && straight[0]?.x === 0 && straight[1]?.x === 10,
      detail: `${straight.length} pts ${straight.map((point) => `${point.x},${point.y}`).join(' → ')}`,
    },
    {
      name: 'sharp corners are preserved',
      passed:
        corner.length >= 3 &&
        corner.some((point) => Math.abs(point.x - 8) < 0.2 && Math.abs(point.y) < 0.2),
      detail: `${corner.length} pts ${corner.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' → ')}`,
    },
    {
      name: 'bowl extrema are preserved',
      passed: bowl.length >= 8 && bowl.length <= 12 && hasLeft && hasRight && hasTop && hasBottom,
      detail: `n=${bowl.length} x=[${Math.min(...xs).toFixed(2)},${Math.max(...xs).toFixed(2)}] y=[${Math.min(...ys).toFixed(2)},${Math.max(...ys).toFixed(2)}]`,
    },
    {
      name: 'ordered anchors follow the drawing sequence',
      passed: z.length >= 4 && z[0]?.y === 10 && (z[z.length - 1]?.y ?? 1) === 0 && z[0]!.x < 1,
      detail: z.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' → '),
    },
    {
      name: 'reject snap displacement over 40m',
      passed: rejected == null,
      detail: `far=${farEdge.distanceMeters}m`,
    },
    {
      name: 'prefer previous-street continuation over a slightly closer parallel road',
      passed: chosen?.wayId === 1,
      detail: `way=${chosen?.wayId} dist=${chosen?.distanceMeters}`,
    },
    {
      name: 'duplicate nearby anchors collapse',
      passed: collapsed.length === 2,
      detail: `n=${collapsed.length}`,
    },
    {
      name: 'route-leg concatenation drops duplicate boundary coordinates',
      passed:
        concatenated.length === 3 &&
        concatenated[0]?.latitude === 1 &&
        concatenated[1]?.latitude === 2 &&
        concatenated[2]?.latitude === 3,
      detail: concatenated.map((point) => point.latitude).join('→'),
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
