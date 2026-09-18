import { nextCandidateScale, scaleFitsSearchWindow } from './adaptive-scale';

type SelfTest = { name: string; passed: boolean; detail: string };

function run(): SelfTest[] {
  const short = nextCandidateScale({
    currentScale: 1,
    targetDistanceMeters: 4000,
    actualDistanceMeters: 1432,
  });
  const collapsed = nextCandidateScale({
    currentScale: 1,
    targetDistanceMeters: 4000,
    actualDistanceMeters: 449,
  });
  const long = nextCandidateScale({
    currentScale: 1,
    targetDistanceMeters: 4000,
    actualDistanceMeters: 5786,
  });
  const near = nextCandidateScale({
    currentScale: 1,
    targetDistanceMeters: 4000,
    actualDistanceMeters: 3990,
  });
  const capped = nextCandidateScale({
    currentScale: 3.5,
    targetDistanceMeters: 4000,
    actualDistanceMeters: 1000,
  });

  return [
    {
      name: 'scale up when Valhalla returns a short route',
      passed: short.shouldRetry && short.scale > 1.9 && short.scale <= 2.35,
      detail: `scale=${short.scale.toFixed(3)} ratio=${short.ratio.toFixed(3)}`,
    },
    {
      name: 'clamp extreme collapse instead of jumping 8×',
      passed: collapsed.shouldRetry && collapsed.scale === 2.35,
      detail: `scale=${collapsed.scale.toFixed(3)} ratio=${collapsed.ratio.toFixed(3)}`,
    },
    {
      name: 'scale down when Valhalla overshoots',
      passed: long.shouldRetry && long.scale < 0.8 && long.scale > 0.6,
      detail: `scale=${long.scale.toFixed(3)} ratio=${long.ratio.toFixed(3)}`,
    },
    {
      name: 'tiny error still retries only if step is large enough',
      passed: Math.abs(near.scale - 1) < 0.06,
      detail: `scale=${near.scale.toFixed(3)} retry=${near.shouldRetry}`,
    },
    {
      name: 'do not retry when already at max scale',
      passed: !capped.shouldRetry && capped.scale === 3.5,
      detail: `scale=${capped.scale.toFixed(3)}`,
    },
    {
      name: 'reject scales that explode the search window',
      passed: !scaleFitsSearchWindow(4000, 1200, 4) && scaleFitsSearchWindow(4000, 1200, 2),
      detail: '12 km extent cap',
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
