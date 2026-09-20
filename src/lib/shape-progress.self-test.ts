import { distanceMeters, offsetCoordinate } from '@/lib/shape-projection';
import {
  advanceShapeProgress,
  calculateShapeProgress,
  createShapeProgressState,
  shapeProgressCoordinates,
} from '@/lib/shape-progress';

type SelfTest = { name: string; passed: boolean; detail: string };

const ORIGIN = { latitude: 30.0619, longitude: 31.2195 };
const SHAPE = [
  ORIGIN,
  offsetCoordinate(ORIGIN, 100, 0),
  offsetCoordinate(ORIGIN, 200, 0),
  offsetCoordinate(ORIGIN, 300, 0),
  offsetCoordinate(ORIGIN, 400, 0),
];

function at(progress: number, northMeters = 0) {
  return offsetCoordinate(ORIGIN, progress * 400, northMeters);
}

function traceTo(progress: number) {
  const points = [at(0)];
  for (let value = 0.1; value < progress; value += 0.1) {
    points.push(at(value));
  }
  points.push(at(progress));
  return [points];
}

const empty = calculateShapeProgress(SHAPE, []);
const before = calculateShapeProgress(SHAPE, [
  [
    offsetCoordinate(ORIGIN, -250, 0),
    offsetCoordinate(ORIGIN, -100, 0),
    offsetCoordinate(ORIGIN, -40, 0),
  ],
]);
const atStart = calculateShapeProgress(SHAPE, [[at(0, 10)]]);
const at25 = calculateShapeProgress(SHAPE, traceTo(0.25));
const at50 = calculateShapeProgress(SHAPE, traceTo(0.5));
const at90 = calculateShapeProgress(SHAPE, traceTo(0.9));
const endpoint = calculateShapeProgress(SHAPE, traceTo(1));

let jitter = createShapeProgressState();
jitter = advanceShapeProgress(SHAPE, at(0), jitter);
jitter = advanceShapeProgress(SHAPE, at(0.1), jitter);
jitter = advanceShapeProgress(SHAPE, at(0.2), jitter);
jitter = advanceShapeProgress(SHAPE, at(0.3), jitter);
jitter = advanceShapeProgress(SHAPE, at(0.4), jitter);
jitter = advanceShapeProgress(SHAPE, at(0.43), jitter);
const beforeBackwardJitter = jitter.progress;
jitter = advanceShapeProgress(SHAPE, at(0.41), jitter);

let jump = createShapeProgressState();
jump = advanceShapeProgress(SHAPE, at(0), jump);
jump = advanceShapeProgress(SHAPE, at(0.1), jump);
jump = advanceShapeProgress(SHAPE, at(0.2), jump);
jump = advanceShapeProgress(SHAPE, at(0.9), jump);

const connectorOnly = calculateShapeProgress(SHAPE, [
  [
    offsetCoordinate(ORIGIN, -300, 0),
    offsetCoordinate(ORIGIN, -200, 0),
    offsetCoordinate(ORIGIN, -100, 0),
    offsetCoordinate(ORIGIN, -40, 0),
  ],
]);
const acrossPause = calculateShapeProgress(SHAPE, [
  [at(0), at(0.1), at(0.2), at(0.3)],
  [at(0.3), at(0.4), at(0.5)],
]);
const completedThenJitter = advanceShapeProgress(
  SHAPE,
  at(0.6),
  endpoint,
);
const completedCoordinates = shapeProgressCoordinates(SHAPE, 0.5);

const tests: SelfTest[] = [
  {
    name: 'empty GPS trace has zero progress',
    passed:
      empty.progress === 0 &&
      !empty.completed &&
      empty.currentStatus === 'on_your_way',
    detail: `progress=${empty.progress} completed=${empty.completed}`,
  },
  {
    name: 'GPS before shape stays on your way at zero progress',
    passed:
      before.progress === 0 &&
      !before.reachedShapeStart &&
      before.currentStatus === 'on_your_way',
    detail: `progress=${before.progress} reached=${before.reachedShapeStart}`,
  },
  {
    name: 'GPS near shape start begins drawing near zero',
    passed:
      atStart.reachedShapeStart &&
      atStart.progress <= 0.03 &&
      atStart.currentStatus === 'drawing',
    detail: `progress=${atStart.progress.toFixed(3)} reached=${atStart.reachedShapeStart}`,
  },
  {
    name: 'ordered traversal reaches about 25 percent',
    passed: Math.abs(at25.progress - 0.25) <= 0.03,
    detail: at25.progress.toFixed(3),
  },
  {
    name: 'ordered traversal reaches about 50 percent',
    passed: Math.abs(at50.progress - 0.5) <= 0.03,
    detail: at50.progress.toFixed(3),
  },
  {
    name: 'ordered traversal reaches about 90 percent',
    passed: Math.abs(at90.progress - 0.9) <= 0.03 && !at90.completed,
    detail: `${at90.progress.toFixed(3)} completed=${at90.completed}`,
  },
  {
    name: 'ordered endpoint traversal completes at 100 percent',
    passed:
      endpoint.completed &&
      endpoint.progress === 1 &&
      endpoint.progressPercent === 100,
    detail: `${endpoint.progressPercent}% completed=${endpoint.completed}`,
  },
  {
    name: 'backward GPS jitter does not lower displayed progress',
    passed:
      Math.abs(beforeBackwardJitter - 0.43) <= 0.03 &&
      jitter.progress === beforeBackwardJitter,
    detail: `before=${beforeBackwardJitter.toFixed(3)} after=${jitter.progress.toFixed(3)}`,
  },
  {
    name: 'large one-fix jump cannot skip from 20 to 90 percent',
    passed: jump.progress <= 0.3 && !jump.completed,
    detail: `projected=0.900 accepted=${jump.progress.toFixed(3)}`,
  },
  {
    name: 'connector-only movement does not count as shape progress',
    passed:
      connectorOnly.progress === 0 &&
      !connectorOnly.reachedShapeStart,
    detail: `progress=${connectorOnly.progress} reached=${connectorOnly.reachedShapeStart}`,
  },
  {
    name: 'progress continues across pause-separated GPS segments',
    passed:
      Math.abs(acrossPause.progress - 0.5) <= 0.04 &&
      acrossPause.gpsSegmentIndex === 1,
    detail: `progress=${acrossPause.progress.toFixed(3)} segment=${acrossPause.gpsSegmentIndex}`,
  },
  {
    name: 'completion persists through later GPS jitter',
    passed:
      completedThenJitter.completed &&
      completedThenJitter.progress === 1,
    detail: `progress=${completedThenJitter.progress} completed=${completedThenJitter.completed}`,
  },
  {
    name: 'completed shape coordinates stop at current progress',
    passed:
      completedCoordinates.length === 3 &&
      completedCoordinates[2] != null &&
      SHAPE[2] != null &&
      distanceMeters(completedCoordinates[2], SHAPE[2]) < 0.1,
    detail: `points=${completedCoordinates.length}`,
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
