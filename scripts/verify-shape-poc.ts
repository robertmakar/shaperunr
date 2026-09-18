import { DEVELOPMENT_FALLBACK_LOCATION } from '@/constants/location';
import { resamplePolyline } from '@/lib/geometry';
import { flattenLetterStrokes, getLetterShape } from '@/lib/letter-shapes';
import { generateCandidateRoutes } from '@/lib/route-generator';
import { asciiPreview, runShapePocSelfTests } from '@/lib/shape-poc-self-test';
import {
  coordinatesToLocalMeters,
  dimensionsForTargetLength,
  offsetCoordinate,
  polylineLengthMeters,
  projectShapeToGeographic,
} from '@/lib/shape-projection';
import { createDevelopmentStreetGrid, routeThroughWaypoints } from '@/lib/street-network';
import { buildWordShape } from '@/lib/word-shape';

const tests = runShapePocSelfTests();
for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}

for (const char of ['A', 'O', 'R', 'B', 'Z']) {
  const shape = getLetterShape(char);
  console.log(`\n${char}\n${asciiPreview(shape ? flattenLetterStrokes(shape) : [])}`);
}

const word = buildWordShape('ROBZ');
console.log(`\nROBZ\n${asciiPreview(word.points, 48, 10)}`);

const size = dimensionsForTargetLength(word, 4000);
const projected = projectShapeToGeographic(word.points, {
  center: DEVELOPMENT_FALLBACK_LOCATION,
  widthMeters: size.widthMeters,
  heightMeters: size.heightMeters,
});
const origin = projected.coordinates[0];
const waypoints = origin
  ? resamplePolyline(coordinatesToLocalMeters(origin, projected.coordinates), 72).map((point) =>
      offsetCoordinate(origin, point.x, point.y),
    )
  : [];
const graph = createDevelopmentStreetGrid({
  center: DEVELOPMENT_FALLBACK_LOCATION,
  eastExtentMeters: 900,
  northExtentMeters: 900,
  spacingMeters: 35,
});
const routed = routeThroughWaypoints(graph, waypoints);
console.log(
  `\n0° mock snap: waypoints ${waypoints.length}, waypoint path ${polylineLengthMeters(waypoints).toFixed(0)} m, routed ${polylineLengthMeters(routed).toFixed(0)} m (${routed.length} pts)`,
);

const generated = generateCandidateRoutes({
  word: 'ROBZ',
  startCoordinate: DEVELOPMENT_FALLBACK_LOCATION,
  targetDistanceMeters: 4000,
  maxCandidates: 3,
});

console.log(`\n${generated.warning}`);
console.log(`target length ${generated.targetLengthMeters.toFixed(1)} m`);
for (const candidate of generated.candidates) {
  console.log(
    `${candidate.label} score=${candidate.score.score.toFixed(3)} coverage=${candidate.score.coverage.toFixed(3)} distErr=${candidate.score.distanceError.toFixed(1)} len=${candidate.lengthMeters.toFixed(0)}`,
  );
}

const failed = tests.filter((test) => !test.passed);
if (failed.length > 0) {
  process.exitCode = 1;
}
