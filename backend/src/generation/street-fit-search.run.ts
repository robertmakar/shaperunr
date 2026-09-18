/**
 * DEVELOPMENT ONLY CLI: npx tsx src/generation/street-fit-search.run.ts
 */
import { writeStreetFitSearchSvg, runStreetFitSearchExperiment } from './street-fit-pipeline';

async function main() {
  const report = await runStreetFitSearchExperiment({
    word: 'ROBZ',
    start: { latitude: 30.0444, longitude: 31.2357 },
    targetDistanceMeters: 4000,
  });
  const svgPath = writeStreetFitSearchSvg(report.svg);
  console.log(report.textReport);
  console.log('');
  console.log(`elapsed ${report.elapsedMs} ms`);
  console.log(`graph collect Valhalla locate chunks ${report.graphCollectValhallaCalls}`);
  console.log(`svg: ${svgPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
