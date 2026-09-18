import {
  aggregateRegion,
  analyzeWaySamples,
  detectCoverageGaps,
  forwardRatio,
  headingAgreement,
  projectOntoTarget,
  regionsFromLetterLengths,
  summarizeStreetFit,
  usableSamples,
} from './street-fit';

type SelfTest = { name: string; passed: boolean; detail: string };

function run(): SelfTest[] {
  const target = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  const onCorner = projectOntoTarget({ x: 100, y: 40 }, target);
  const offset = projectOntoTarget({ x: 100, y: 40 }, target);
  const beside = projectOntoTarget({ x: 80, y: 10 }, target);

  const aligned = headingAgreement(0, 0);
  const perpendicular = headingAgreement(Math.PI / 2, 0);
  const reverse = headingAgreement(Math.PI, 0);

  const way = analyzeWaySamples(
    'way-1',
    [
      { x: 10, y: 4 },
      { x: 40, y: 4 },
      { x: 70, y: 4 },
    ],
    target,
  );
  const backwardWay = analyzeWaySamples(
    'way-2',
    [
      { x: 70, y: 8 },
      { x: 40, y: 8 },
      { x: 10, y: 8 },
    ],
    target,
  );

  const regions = regionsFromLetterLengths([
    { id: 'R', length: 50 },
    { id: 'O', length: 50 },
    { id: 'B', length: 50 },
    { id: 'Z', length: 50 },
  ]);
  const rFit = aggregateRegion(regions[0]!, [way], 200);
  const gaps = detectCoverageGaps([0.05, 0.1, 0.8, 0.85], 1000, 10);

  const usable = usableSamples([
    ...way.samples,
    {
      wayId: 'far',
      point: { x: 0, y: 80 },
      progress: 0.1,
      perpendicularDistance: 80,
      targetHeading: 0,
      edgeHeading: 0,
      headingAgreement: 1,
      reverse: false,
    },
    {
      wayId: 'reverse-parallel',
      point: { x: 20, y: 3 },
      progress: 0.1,
      perpendicularDistance: 3,
      targetHeading: 0,
      edgeHeading: Math.PI,
      headingAgreement: 1,
      reverse: true,
    },
  ]);

  const summary = summarizeStreetFit(
    [
      rFit,
      aggregateRegion(regions[1]!, [way], 200),
      aggregateRegion(regions[2]!, [], 200),
      aggregateRegion(regions[3]!, [], 200),
    ],
    [way, backwardWay],
    200,
  );

  return [
    {
      name: 'edge projection onto target progress',
      passed: Math.abs(onCorner.progress - 0.7) < 0.05 && onCorner.segmentIndex === 1,
      detail: `progress=${onCorner.progress.toFixed(3)} segment=${onCorner.segmentIndex}`,
    },
    {
      name: 'perpendicular distance',
      passed: Math.abs(beside.perpendicularDistance - 10) < 1e-6 && Math.abs(offset.perpendicularDistance) < 1e-6,
      detail: `offset=${beside.perpendicularDistance.toFixed(3)} on-line=${offset.perpendicularDistance.toFixed(3)}`,
    },
    {
      name: 'heading agreement',
      passed:
        aligned.agreement > 0.99 &&
        aligned.reverse === false &&
        perpendicular.agreement < 0.05 &&
        reverse.reverse === true &&
        reverse.agreement > 0.99,
      detail: `align=${aligned.agreement.toFixed(2)} perp=${perpendicular.agreement.toFixed(2)} rev=${reverse.reverse}`,
    },
    {
      name: 'forward vs backward progress',
      passed:
        (forwardRatio([0.1, 0.2, 0.4]) ?? 0) > 0.99 &&
        (forwardRatio([0.4, 0.2, 0.1]) ?? 1) < 0.01 &&
        (way.forwardRatio ?? 0) > 0.9 &&
        (backwardWay.forwardRatio ?? 1) < 0.1,
      detail: `fwd=${way.forwardRatio?.toFixed(2)} back=${backwardWay.forwardRatio?.toFixed(2)}`,
    },
    {
      name: 'region aggregation',
      passed:
        regions.length === 4 &&
        regions[0]?.id === 'R' &&
        Math.abs((regions[0]?.endProgress ?? 0) - 0.25) < 1e-9 &&
        rFit.usableWayCount >= 1 &&
        rFit.bestPerpendicularDistance < 6,
      detail: `R coverage=${rFit.coverage.toFixed(2)} ways=${rFit.usableWayCount} dist=${rFit.bestPerpendicularDistance.toFixed(1)}`,
    },
    {
      name: 'gap detection',
      passed: gaps.maxGapMeters > 400 && gaps.coverage < 0.6 && gaps.uncoveredBins.length >= 4,
      detail: `coverage=${gaps.coverage.toFixed(2)} maxGap=${gaps.maxGapMeters.toFixed(0)}m bins=${gaps.uncoveredBins.length}`,
    },
    {
      name: 'usable samples reject far edges and keep reverse-parallel streets',
      passed:
        usable.some((sample) => sample.wayId === 'way-1') &&
        usable.some((sample) => sample.wayId === 'reverse-parallel') &&
        usable.every((sample) => sample.wayId !== 'far'),
      detail: `usable=${usable.map((sample) => sample.wayId).join(',')}`,
    },
    {
      name: 'summary rolls up region feasibility',
      passed: summary.targetLengthMeters === 200 && summary.usableWayCount >= 1,
      detail: `coverage=${summary.pedestrianGraphCoverage.toFixed(2)} feasible=${summary.connectedPathFeasibility.toFixed(2)}`,
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
