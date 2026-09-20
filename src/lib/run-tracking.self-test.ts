import {
  appendRunSessionGpsFix,
  appendGpsFix,
  elapsedRunMilliseconds,
  finishRunTrackingSession,
  formatElapsedClock,
  isRunTrackingActive,
  liveRunDistanceMeters,
  pauseRunTrackingSession,
  resumeRunTrackingSession,
  runCoursePhase,
  runPermissionDeniedCopy,
  runSessionDistanceMeters,
  runSessionPath,
  shouldAcceptGpsFix,
  startRunTrackingSession,
} from '@/lib/run-tracking';

type SelfTest = { name: string; passed: boolean; detail: string };

const SHAPE_START = { latitude: 30.0619, longitude: 31.2195 };
const NEAR_SHAPE = { latitude: 30.062, longitude: 31.2196 };
const FAR_FROM_SHAPE = { latitude: 30.07, longitude: 31.23 };
const STEP = { latitude: 30.0622, longitude: 31.2197 };
const RESUME_FIX = { latitude: 30.07, longitude: 31.23 };
const RESUME_STEP = { latitude: 30.0702, longitude: 31.2302 };

function fix(
  coordinate: { latitude: number; longitude: number },
  timestamp: number,
) {
  return { coordinate, timestamp, accuracy: 8 };
}

const started = appendRunSessionGpsFix(
  appendRunSessionGpsFix(startRunTrackingSession(0), fix(NEAR_SHAPE, 0)),
  fix(STEP, 10_000),
);
const paused = pauseRunTrackingSession(started, 10_000);
const resumed = appendRunSessionGpsFix(
  appendRunSessionGpsFix(
    resumeRunTrackingSession(paused, 30_000),
    fix(RESUME_FIX, 30_000),
  ),
  fix(RESUME_STEP, 40_000),
);
const finished = finishRunTrackingSession(resumed, 40_000);

const tests: SelfTest[] = [
  {
    name: 'rejects inaccurate GPS fixes',
    passed: !shouldAcceptGpsFix([], {
      coordinate: NEAR_SHAPE,
      timestamp: 1,
      accuracy: 80,
    }),
    detail: 'accuracy 80 m',
  },
  {
    name: 'accepts first accurate fix',
    passed: shouldAcceptGpsFix([], {
      coordinate: NEAR_SHAPE,
      timestamp: 1,
      accuracy: 12,
    }),
    detail: 'empty path',
  },
  {
    name: 'ignores jitter smaller than min step',
    passed: !shouldAcceptGpsFix([NEAR_SHAPE], {
      coordinate: { latitude: 30.0620005, longitude: 31.2196005 },
      timestamp: 2,
      accuracy: 8,
    }),
    detail: 'sub-meter jitter',
  },
  {
    name: 'appends a real step and measures distance',
    passed: (() => {
      const path = appendGpsFix([NEAR_SHAPE], {
        coordinate: STEP,
        timestamp: 3,
        accuracy: 10,
      });
      return path.length === 2 && liveRunDistanceMeters(path) > 10;
    })(),
    detail: `n=${appendGpsFix([NEAR_SHAPE], { coordinate: STEP, timestamp: 3, accuracy: 10 }).length} m=${liveRunDistanceMeters(appendGpsFix([NEAR_SHAPE], { coordinate: STEP, timestamp: 3, accuracy: 10 })).toFixed(1)}`,
  },
  {
    name: 'connector phase until the shape start',
    passed: runCoursePhase(FAR_FROM_SHAPE, SHAPE_START) === 'connecting',
    detail: runCoursePhase(FAR_FROM_SHAPE, SHAPE_START),
  },
  {
    name: 'drawing phase at the shape start',
    passed: runCoursePhase(NEAR_SHAPE, SHAPE_START) === 'drawing',
    detail: runCoursePhase(NEAR_SHAPE, SHAPE_START),
  },
  {
    name: 'permission denied copy offers retry',
    passed:
      runPermissionDeniedCopy('denied').title === 'LOCATION NEEDED' &&
      runPermissionDeniedCopy('denied').action === 'TRY AGAIN',
    detail: runPermissionDeniedCopy('denied').action,
  },
  {
    name: 'restricted permission opens settings',
    passed: runPermissionDeniedCopy('restricted').action === 'OPEN SETTINGS',
    detail: runPermissionDeniedCopy('restricted').action,
  },
  {
    name: 'elapsed clock is mm:ss',
    passed: formatElapsedClock(0) === '0:00' && formatElapsedClock(125_000) === '2:05',
    detail: `${formatElapsedClock(0)} ${formatElapsedClock(125_000)}`,
  },
  {
    name: 'start enters running state, starts elapsed time, and accumulates GPS',
    passed:
      started.status === 'running' &&
      isRunTrackingActive(started) &&
      elapsedRunMilliseconds(started, 10_000) === 10_000 &&
      runSessionPath(started).length === 2 &&
      runSessionDistanceMeters(started) > 10,
    detail: `status=${started.status} elapsed=${elapsedRunMilliseconds(started, 10_000)} path=${runSessionPath(started).length}`,
  },
  {
    name: 'pause freezes elapsed time, tracking, and distance',
    passed: (() => {
      const attemptedFix = appendRunSessionGpsFix(
        paused,
        fix(RESUME_FIX, 20_000),
      );
      return (
        paused.status === 'paused' &&
        !isRunTrackingActive(paused) &&
        elapsedRunMilliseconds(paused, 30_000) === 10_000 &&
        runSessionDistanceMeters(attemptedFix) ===
          runSessionDistanceMeters(paused) &&
        runSessionPath(attemptedFix).length === runSessionPath(paused).length
      );
    })(),
    detail: `elapsed=${elapsedRunMilliseconds(paused, 30_000)} distance=${runSessionDistanceMeters(paused).toFixed(1)}`,
  },
  {
    name: 'resume continues elapsed time, trace, and distance',
    passed:
      resumed.status === 'running' &&
      isRunTrackingActive(resumed) &&
      elapsedRunMilliseconds(resumed, 40_000) === 20_000 &&
      runSessionPath(resumed).length === 4 &&
      runSessionDistanceMeters(resumed) > runSessionDistanceMeters(paused),
    detail: `elapsed=${elapsedRunMilliseconds(resumed, 40_000)} path=${runSessionPath(resumed).length} distance=${runSessionDistanceMeters(resumed).toFixed(1)}`,
  },
  {
    name: '20 seconds paused are excluded from elapsed running time',
    passed:
      elapsedRunMilliseconds(finished, 60_000) === 20_000 &&
      finished.status === 'finished',
    detail: `10s run + 20s pause + 10s run = ${elapsedRunMilliseconds(finished, 60_000) / 1000}s`,
  },
  {
    name: 'multiple pause and resume cycles accumulate running time only',
    passed: (() => {
      let session = startRunTrackingSession(0);
      session = pauseRunTrackingSession(session, 5_000);
      session = resumeRunTrackingSession(session, 15_000);
      session = pauseRunTrackingSession(session, 22_000);
      session = resumeRunTrackingSession(session, 42_000);
      session = finishRunTrackingSession(session, 50_000);
      return elapsedRunMilliseconds(session, 100_000) === 20_000;
    })(),
    detail: '5s + 7s + 8s = 20s',
  },
  {
    name: 'finish while paused preserves final elapsed time and distance',
    passed: (() => {
      const final = finishRunTrackingSession(paused, 30_000);
      return (
        final.status === 'finished' &&
        elapsedRunMilliseconds(final, 60_000) === 10_000 &&
        runSessionDistanceMeters(final) === runSessionDistanceMeters(paused)
      );
    })(),
    detail: `elapsed=${elapsedRunMilliseconds(finishRunTrackingSession(paused, 30_000), 60_000)} distance=${runSessionDistanceMeters(paused).toFixed(1)}`,
  },
  {
    name: 'first fix after resume starts a segment without an artificial distance jump',
    passed: (() => {
      const resumedSession = resumeRunTrackingSession(paused, 30_000);
      const reacquired = appendRunSessionGpsFix(
        resumedSession,
        fix(RESUME_FIX, 30_000),
      );
      return (
        resumedSession.pathSegments.length === 2 &&
        reacquired.pathSegments[1]?.length === 1 &&
        runSessionDistanceMeters(reacquired) ===
          runSessionDistanceMeters(paused)
      );
    })(),
    detail: `before=${runSessionDistanceMeters(paused).toFixed(1)} afterFirstFix=${runSessionDistanceMeters(appendRunSessionGpsFix(resumeRunTrackingSession(paused, 30_000), fix(RESUME_FIX, 30_000))).toFixed(1)}`,
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
