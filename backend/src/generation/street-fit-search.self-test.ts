import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWordShape } from '@/lib/word-shape';

import {
  buildStreetFitPlacements,
  buildTranslationOffsets,
  placementsWithinBounds,
  projectWordPlacement,
  rankStreetFitPlacements,
  scoreStreetFitPlacement,
  STREET_FIT_SEARCH,
  translatePolyline,
  type StreetGraphWay,
} from './street-fit-search';

type SelfTest = { name: string; passed: boolean; detail: string };

const searchSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'street-fit-search.ts'), 'utf8');

function verticalGrid(step = 20, x0 = 0, x1 = 200, y0 = -50, y1 = 50): StreetGraphWay[] {
  const ways: StreetGraphWay[] = [];
  for (let x = x0, index = 0; x <= x1; x += step, index += 1) {
    ways.push({
      wayId: `vert-${index}`,
      points: [
        { x, y: y0 },
        { x, y: y1 },
      ],
    });
  }
  return ways;
}

function alignedStreet(): StreetGraphWay[] {
  return [
    {
      wayId: 'along',
      points: [
        { x: 0, y: 3 },
        { x: 50, y: 3 },
        { x: 100, y: 3 },
        { x: 150, y: 3 },
        { x: 200, y: 3 },
      ],
    },
  ];
}

function reverseStreet(): StreetGraphWay[] {
  return [
    {
      wayId: 'reverse',
      points: [
        { x: 200, y: 3 },
        { x: 150, y: 3 },
        { x: 100, y: 3 },
        { x: 50, y: 3 },
        { x: 0, y: 3 },
      ],
    },
  ];
}

function gappedStreet(): StreetGraphWay[] {
  return [
    {
      wayId: 'left',
      points: [
        { x: 0, y: 3 },
        { x: 40, y: 3 },
      ],
    },
    {
      wayId: 'right',
      points: [
        { x: 160, y: 3 },
        { x: 200, y: 3 },
      ],
    },
  ];
}

function run(): SelfTest[] {
  const eastTarget = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ];
  const letters = [{ id: 'I', length: 200 }];
  const aligned = scoreStreetFitPlacement(eastTarget, letters, alignedStreet());
  const crossing = scoreStreetFitPlacement(eastTarget, letters, verticalGrid());
  const mixed = scoreStreetFitPlacement(eastTarget, letters, [...alignedStreet(), ...verticalGrid()]);
  const reverse = scoreStreetFitPlacement(eastTarget, letters, reverseStreet());
  const gapped = scoreStreetFitPlacement(eastTarget, letters, gappedStreet());

  const placements = buildStreetFitPlacements();
  const translations = buildTranslationOffsets();
  const uniqueRotations = new Set(placements.map((item) => item.rotationDegrees));
  const uniqueScales = new Set(placements.map((item) => item.scale));
  const distances = placements.map((item) => item.distanceFromStartMeters);

  const word = buildWordShape('I');
  const moved = projectWordPlacement(word, 400, {
    rotationDegrees: 0,
    scale: 1,
    eastMeters: 120,
    northMeters: -40,
  });
  const origin = projectWordPlacement(word, 400, {
    rotationDegrees: 0,
    scale: 1,
    eastMeters: 0,
    northMeters: 0,
  });

  const rankedA = rankStreetFitPlacements({
    word: 'I',
    targetDistanceMeters: 400,
    graph: alignedStreet(),
    placements: buildStreetFitPlacements({
      rotationCount: 4,
      scales: [1],
      translationRingsMeters: [0, 400],
      headingsPerRing: 4,
    }),
  });
  const rankedB = rankStreetFitPlacements({
    word: 'I',
    targetDistanceMeters: 400,
    graph: alignedStreet(),
    placements: buildStreetFitPlacements({
      rotationCount: 4,
      scales: [1],
      translationRingsMeters: [0, 400],
      headingsPerRing: 4,
    }),
  });

  const translated = translatePolyline(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    5,
    3,
  );

  return [
    {
      name: 'placement translation shifts the drawing in local meters',
      passed:
        Math.abs((moved.target[0]?.x ?? 0) - ((origin.target[0]?.x ?? 0) + 120)) < 1 &&
        Math.abs((moved.target[0]?.y ?? 0) - ((origin.target[0]?.y ?? 0) - 40)) < 1 &&
        translated[0]?.x === 5 &&
        translated[0]?.y === 3 &&
        translated[1]?.x === 15,
      detail: `dx=${((moved.target[0]?.x ?? 0) - (origin.target[0]?.x ?? 0)).toFixed(1)} dy=${((moved.target[0]?.y ?? 0) - (origin.target[0]?.y ?? 0)).toFixed(1)}`,
    },
    {
      name: 'rotation/scale generation covers 22.5° and 0.6–1.4',
      passed:
        uniqueRotations.size === 16 &&
        uniqueRotations.has(0) &&
        uniqueRotations.has(22.5) &&
        uniqueRotations.has(337.5) &&
        uniqueScales.size === STREET_FIT_SEARCH.scales.length &&
        Math.min(...uniqueScales) === 0.6 &&
        Math.max(...uniqueScales) === 1.4,
      detail: `rotations=${uniqueRotations.size} scales=${[...uniqueScales].sort((a, b) => a - b).join(',')}`,
    },
    {
      name: 'candidate search bounds stay inside the translation radius',
      passed:
        placementsWithinBounds(placements) &&
        Math.max(...distances) <= STREET_FIT_SEARCH.translationRadiusMeters + 1e-6 &&
        translations.some((offset) => offset.eastMeters === 0 && offset.northMeters === 0) &&
        translations.length === 1 + 8 + 8 &&
        placements.length === 16 * 5 * 17 &&
        placements.length <= STREET_FIT_SEARCH.maxPlacements,
      detail: `n=${placements.length} translations=${translations.length} maxDist=${Math.max(...distances).toFixed(0)}`,
    },
    {
      name: 'dense crossing grid scores worse than aligned streets',
      passed: aligned.score > crossing.score + 0.15 && aligned.score > mixed.score,
      detail: `aligned=${aligned.score.toFixed(3)} mixed=${mixed.score.toFixed(3)} crossing=${crossing.score.toFixed(3)}`,
    },
    {
      name: 'street-fit ranking puts aligned geometry first',
      passed: aligned.usableEdgeCount >= 1 && aligned.coverage > crossing.coverage && aligned.purity > mixed.purity,
      detail: `alignedCov=${aligned.coverage.toFixed(2)} crossCov=${crossing.coverage.toFixed(2)} purity ${aligned.purity.toFixed(2)}>${mixed.purity.toFixed(2)}`,
    },
    {
      name: 'forward-progress preference',
      passed: aligned.forwardProgress > reverse.forwardProgress + 0.4 && aligned.score > reverse.score,
      detail: `fwd=${aligned.forwardProgress.toFixed(2)} rev=${reverse.forwardProgress.toFixed(2)}`,
    },
    {
      name: 'max-gap penalty',
      passed: gapped.maxGapMeters > aligned.maxGapMeters && gapped.score < aligned.score,
      detail: `alignedGap=${aligned.maxGapMeters.toFixed(0)} gappedGap=${gapped.maxGapMeters.toFixed(0)}`,
    },
    {
      name: 'connectedness prefers a continuous aligned street',
      passed: aligned.connectedPathFeasible && !gapped.connectedPathFeasible && !crossing.connectedPathFeasible,
      detail: `aligned=${aligned.connectedPathFeasible} gapped=${gapped.connectedPathFeasible} crossing=${crossing.connectedPathFeasible}`,
    },
    {
      name: 'deterministic search for a fixed input',
      passed:
        rankedA.length === rankedB.length &&
        rankedA.length > 0 &&
        rankedA.every((item, index) => item.placement.id === rankedB[index]?.placement.id && item.score === rankedB[index]?.score),
      detail: `n=${rankedA.length} first=${rankedA[0]?.placement.id}`,
    },
    {
      name: 'prefilter scores a synthetic graph with no Valhalla module',
      passed: aligned.score > 0 && crossing.score >= 0 && rankedA[0] != null && !searchSource.includes('valhalla') && !searchSource.includes('routeVia'),
      detail: 'rankStreetFitPlacements is CPU-only',
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
