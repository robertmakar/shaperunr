/**
 * DEVELOPMENT ONLY CLI: npx tsx src/generation/graph-shape.run.ts
 */
import { runGraphShapeExperiment, writeGraphShapeSvg } from './graph-shape-experiment';

async function main() {
  const report = await runGraphShapeExperiment();
  const svgPath = writeGraphShapeSvg(report.svg);
  console.log(report.textReport);
  console.log(`elapsed ${report.elapsedMs} ms`);
  console.log(`svg: ${svgPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
