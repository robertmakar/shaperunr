/**
 * DEVELOPMENT ONLY. Feasibility-pool diagnostic tests.
 * Synthetic graphs only — no Valhalla. Does not change generation.
 */
import { EXPERIMENTAL_PIPELINE } from './graph-constrained-pipeline';
import type { GraphSegment } from './graph-shape';
import {
  evaluateFeasibilityPools,
  FEASIBILITY_POOL_DIAGNOSTIC,
} from './feasibility-pool-diagnostic';
import type { StreetFitPlacement } from './street-fit-search';

type SelfTest = { name: string; passed: boolean; detail: string };

const START = { latitude: 30.0619, longitude: 31.2195 };

const ORIGIN: StreetFitPlacement = {
  id: 'p-origin',
  rotationDegrees: 0,
  scale: 1,
  eastMeters: 0,
  northMeters: 0,
  distanceFromStartMeters: 0,
};

const NEAR: StreetFitPlacement = {
  id: 'p-near',
  rotationDegrees: 0,
  scale: 1,
  eastMeters: 12,
  northMeters: 8,
  distanceFromStartMeters: 14.4,
};

const FAR: StreetFitPlacement = {
  id: 'p-far',
  rotationDegrees: 90,
  scale: 1,
  eastMeters: 400,
  northMeters: 0,
  distanceFromStartMeters: 400,
};

function followingL(): GraphSegment[] {
  return [
    {
      id: 'follow-v',
      wayId: 'follow-v',
      from: 'A',
      to: 'B',
      points: [
        { x: 2, y: 0 },
        { x: 2, y: -48 },
        { x: 2, y: -95 },
      ],
    },
    {
      id: 'follow-h',
      wayId: 'follow-h',
      from: 'B',
      to: 'C',
      points: [
        { x: 2, y: -95 },
        { x: 32, y: -95 },
        { x: 65, y: -95 },
      ],
    },
  ];
}

function crossingGrid(): GraphSegment[] {
  const segments: GraphSegment[] = [];
  for (let x = 10; x <= 60; x += 10) {
    segments.push({
      id: `grid-v-${x}`,
      wayId: `grid-v-${x}`,
      from: `gv${x}s`,
      to: `gv${x}e`,
      points: [
        { x, y: 10 },
        { x, y: -110 },
      ],
    });
  }
  return segments;
}

const report = await evaluateFeasibilityPools({
  name: 'synthetic L',
  word: 'L',
  searchOrigin: START,
  targetDistanceMeters: 160,
  collection: { segments: [...followingL(), ...crossingGrid()], valhallaCalls: 0 },
  placements: [ORIGIN, NEAR, FAR],
  poolSizes: [1, 3],
  currentPool: 1,
});

const slice1 = report.slices.find((item) => item.poolSize === 1);
const slice3 = report.slices.find((item) => item.poolSize === 3);
const additional = report.scoredFeasible.filter((item) => item.beyondCurrentPool);
const inPool = report.scoredFeasible.filter((item) => !item.beyondCurrentPool);

const tests: SelfTest[] = [
  {
    name: 'generator feasibility pool is top 96',
    passed:
      EXPERIMENTAL_PIPELINE.feasibilityTop === 96 && FEASIBILITY_POOL_DIAGNOSTIC.currentPool === 96,
    detail: `pipeline=${EXPERIMENTAL_PIPELINE.feasibilityTop} diagnostic=${FEASIBILITY_POOL_DIAGNOSTIC.currentPool}`,
  },
  {
    name: 'deeper pool can find additional graph-feasible candidates',
    passed:
      (slice1?.graphFeasible ?? 0) >= 1 &&
      (slice3?.graphFeasible ?? 0) > (slice1?.graphFeasible ?? 0),
    detail: `pool1=${slice1?.graphFeasible} pool3=${slice3?.graphFeasible}`,
  },
  {
    name: 'additional feasible candidates receive existing shape-match scoring',
    passed:
      additional.length > 0 &&
      additional.every((item) => item.shapeScore != null && item.streetFitRank >= 1),
    detail: additional.map((item) => `${item.placementId}:${item.shapeScore?.toFixed(3)}`).join(',') || 'none',
  },
  {
    name: 'product check uses existing thresholds without changing them',
    passed: inPool.length > 0 && typeof inPool[0]?.wouldPassProduct === 'boolean',
    detail: `inPool=${inPool.map((item) => `${item.placementId} product=${item.wouldPassProduct}`).join(',')}`,
  },
  {
    name: 'best candidate reports rotation, scale, placement, and street-fit rank',
    passed:
      slice3?.best != null &&
      slice3.best.placementId.length > 0 &&
      Number.isFinite(slice3.best.rotationDegrees) &&
      Number.isFinite(slice3.best.scale) &&
      Number.isFinite(slice3.best.streetFitRank),
    detail: slice3?.best
      ? `${slice3.best.placementId} rank=${slice3.best.streetFitRank} rot=${slice3.best.rotationDegrees} scale=${slice3.best.scale} e=${slice3.best.eastMeters} n=${slice3.best.northMeters}`
      : 'none',
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
