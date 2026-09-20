/**
 * DEVELOPMENT ONLY CLI: npm run generate-experimental --prefix backend
 *
 * Runs the four controlled real tests unless --word is provided.
 */
import {
  runExperimentalPipeline,
  writeExperimentalSvg,
  type ExperimentalPipelineReport,
} from './graph-constrained-pipeline';

const CASES = [
  { name: 'L-zamalek', word: 'L', latitude: 30.0619, longitude: 31.2195, targetDistance: 2500 },
  { name: 'Z-north-cairo', word: 'Z', latitude: 30.08033, longitude: 31.2357, targetDistance: 2500 },
  { name: 'O-zamalek', word: 'O', latitude: 30.0619, longitude: 31.2195, targetDistance: 1500 },
  { name: 'ROBZ-downtown', word: 'ROBZ', latitude: 30.0444, longitude: 31.2357, targetDistance: 4000 },
] as const;

function parseArgs(argv: string[]) {
  const found: Record<string, string> = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match?.[1]) {
      found[match[1]] = match[2] ?? '';
    }
  }
  if (found.word) {
    return [
      {
        name: 'custom',
        word: found.word,
        latitude: Number(found.lat ?? found.latitude ?? 30.0444),
        longitude: Number(found.lng ?? found.longitude ?? 31.2357),
        targetDistance: Number(found.distance ?? found.targetDistance ?? 2500),
      },
    ];
  }
  return [...CASES];
}

async function main() {
  const cases = parseArgs(process.argv.slice(2));
  const reports: Array<{ name: string; report: ExperimentalPipelineReport }> = [];
  for (const item of cases) {
    const report = await runExperimentalPipeline({
      word: item.word,
      start: { latitude: item.latitude, longitude: item.longitude },
      targetDistanceMeters: item.targetDistance,
    });
    reports.push({ name: item.name, report });
    console.log(`\n======== ${item.name} ========`);
    console.log(report.textReport);
    writeExperimentalSvg(report.svg, `generate-experimental-${item.name}.svg`);
  }
  const svgPath = writeExperimentalSvg(reports[reports.length - 1]?.report.svg ?? reports[0]!.report.svg);
  console.log(`\nsvg: ${svgPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
