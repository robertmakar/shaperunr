/**
 * DEVELOPMENT ONLY CLI: npm run shape-discovery --prefix backend
 */
import { runShapeDiscovery, writeShapeDiscoverySvg } from './shape-discovery';

async function main() {
  const report = await runShapeDiscovery();
  const svgPath = writeShapeDiscoverySvg(report.svg);
  console.log(report.textReport);
  console.log(`elapsed ${report.elapsedMs} ms`);
  console.log(`Valhalla locate ${report.valhallaLocateCalls}  route ${report.valhallaRouteCalls}`);
  console.log(`svg: ${svgPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
