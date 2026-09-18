/**
 * DEVELOPMENT ONLY CLI: npx tsx src/diagnostics/street-fit.run.ts
 */
import { runStreetFitDiagnostic, writeStreetFitSvg } from './street-fit-survey';

async function main() {
  const report = await runStreetFitDiagnostic();
  const svgPath = writeStreetFitSvg(report.svg);
  console.log(report.textReport);
  console.log('');
  console.log(`verdict: ${report.verdict}`);
  console.log(`svg: ${svgPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
