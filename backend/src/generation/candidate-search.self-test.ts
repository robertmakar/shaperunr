import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { distanceMeters } from '@/lib/shape-projection';

import {
  buildCandidateSpecs,
  CANDIDATE_SEARCH,
  offsetInRotatedFrame,
  placeShapeCoordinates,
  rotationHeadings,
} from './candidate-search';

type SelfTest = { name: string; passed: boolean; detail: string };

function run(): SelfTest[] {
  const specs = buildCandidateSpecs();
  const headings = rotationHeadings();
  const ids = new Set(specs.map((spec) => spec.id));
  const start = DEVELOPMENT_FALLBACK_LOCATION;
  const seed = [
    start,
    { latitude: start.latitude + 0.001, longitude: start.longitude + 0.002 },
  ];

  const anchored = placeShapeCoordinates(seed, start, {
    rotationDegrees: 0,
    offsetAcrossMeters: 0,
  });
  const north = placeShapeCoordinates(seed, start, {
    rotationDegrees: 0,
    offsetAcrossMeters: 140,
  });
  const west = placeShapeCoordinates(seed, start, {
    rotationDegrees: 90,
    offsetAcrossMeters: 140,
  });
  const frame0 = offsetInRotatedFrame(140, 0);
  const frame90 = offsetInRotatedFrame(140, 90);

  const uniqueRotations = new Set(specs.map((spec) => spec.rotationDegrees));
  const uniquePlacements = new Set(specs.map((spec) => spec.offsetAcrossMeters));
  const uniquePairs = new Set(specs.map((spec) => `${spec.rotationDegrees}:${spec.offsetAcrossMeters}`));

  return [
    {
      name: 'search space is 16 headings × 3 placements',
      passed:
        headings.length === 16 &&
        headings[0] === 0 &&
        headings[1] === 22.5 &&
        headings[15] === 337.5 &&
        specs.length === 48 &&
        uniqueRotations.size === 16 &&
        uniquePlacements.size === 3 &&
        uniquePairs.size === 48,
      detail: `specs=${specs.length} rotations=${uniqueRotations.size} placements=${[...uniquePlacements].join(',')}`,
    },
    {
      name: 'specs stay inside the Valhalla budget cap',
      passed: specs.length <= CANDIDATE_SEARCH.maxSpecs && specs.length === ids.size,
      detail: `specs=${specs.length} uniqueIds=${ids.size} cap=${CANDIDATE_SEARCH.maxSpecs}`,
    },
    {
      name: 'initial scale is slightly under the requested distance',
      passed: specs.every((spec) => spec.scale === 0.9) && CANDIDATE_SEARCH.maxAttempts === 2,
      detail: `scale=${specs[0]?.scale} attempts=${CANDIDATE_SEARCH.maxAttempts}`,
    },
    {
      name: 'start-anchored first point is the user location',
      passed: Boolean(
        anchored[0] &&
          Math.abs(anchored[0].latitude - start.latitude) < 1e-9 &&
          Math.abs(anchored[0].longitude - start.longitude) < 1e-9,
      ),
      detail: `${anchored[0]?.latitude}, ${anchored[0]?.longitude}`,
    },
    {
      name: 'offset placement is a short lateral shift, then still near the start',
      passed:
        Boolean(north[0] && west[0]) &&
        Math.abs(distanceMeters(start, north[0]!) - 140) < 3 &&
        Math.abs(distanceMeters(start, west[0]!) - 140) < 3 &&
        Math.abs(frame0.eastMeters) < 1e-6 &&
        Math.abs(frame0.northMeters - 140) < 1e-6 &&
        Math.abs(frame90.eastMeters + 140) < 1e-6 &&
        Math.abs(frame90.northMeters) < 1e-6,
      detail: `north=${north[0] ? distanceMeters(start, north[0]).toFixed(1) : 'na'}m west=${west[0] ? distanceMeters(start, west[0]).toFixed(1) : 'na'}m`,
    },
    {
      name: 'ids are deterministic valhalla-0..n',
      passed: specs[0]?.id === 'valhalla-0' && specs[47]?.id === 'valhalla-47',
      detail: `${specs[0]?.id} .. ${specs[47]?.id}`,
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
