/**
 * DEVELOPMENT ONLY CLI: npm run graph-shape-test --prefix backend
 *
 * Optional flags:
 *   --letters=O,Z,L
 *   --lat=30.0444
 *   --lng=31.2357
 *   --distance=4000
 *   --rotation=0
 *   --scale=1
 *   --second   (Zamalek / different street fabric)
 */
import {
  GRAPH_SHAPE_DEFAULT_START,
  GRAPH_SHAPE_SECOND_START,
  runGraphShapeExperiment,
  writeGraphShapeSvg,
  type GraphShapeExperimentInput,
} from './graph-shape-experiment';
import type { ShapeKind } from './graph-shape';

function parseArgs(argv: string[]): GraphShapeExperimentInput {
  const input: GraphShapeExperimentInput = {};
  let useSecond = false;
  for (const arg of argv) {
    if (arg === '--second') {
      useSecond = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2] ?? '';
    if (key === 'letters' || key === 'letter') {
      input.letters = value
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter((item): item is ShapeKind => item === 'O' || item === 'Z' || item === 'L');
    } else if (key === 'lat' || key === 'latitude') {
      input.start = { ...(input.start ?? GRAPH_SHAPE_DEFAULT_START), latitude: Number(value) };
    } else if (key === 'lng' || key === 'lon' || key === 'longitude') {
      input.start = { ...(input.start ?? GRAPH_SHAPE_DEFAULT_START), longitude: Number(value) };
    } else if (key === 'distance' || key === 'targetDistance') {
      input.targetDistanceMeters = Number(value);
    } else if (key === 'rotation') {
      input.rotationDegrees = Number(value);
    } else if (key === 'scale') {
      input.scale = Number(value);
    }
  }
  if (useSecond && !input.start) {
    input.start = GRAPH_SHAPE_SECOND_START;
  }
  return input;
}

async function main() {
  const argv = process.argv.slice(2);
  const input = parseArgs(argv);
  const report = await runGraphShapeExperiment(input);
  const filename = argv.includes('--second') ? 'graph-shape-test-second.svg' : 'graph-shape-test.svg';
  const svgPath = writeGraphShapeSvg(report.svg, filename);
  console.log(report.textReport);
  console.log(`elapsed ${report.elapsedMs} ms`);
  console.log(`Valhalla calls ${report.valhallaCalls}`);
  console.log(`svg: ${svgPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
