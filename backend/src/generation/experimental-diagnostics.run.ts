/**
 * DEVELOPMENT ONLY one-shot: print viability diagnostics for phone-like vs controlled cases.
 * Does not change generation.
 */
import {
  buildExperimentalViabilityDiagnostics,
  formatExperimentalViabilityDiagnostics,
} from './experimental-diagnostics';
import { runExperimentalPipeline } from './graph-constrained-pipeline';

const CASES = [
  { name: 'control L Zamalek 2500', word: 'L', latitude: 30.0619, longitude: 31.2195, targetDistance: 2500 },
  { name: 'control O Zamalek 1500', word: 'O', latitude: 30.0619, longitude: 31.2195, targetDistance: 1500 },
  { name: 'phone-default L downtown 4000', word: 'L', latitude: 30.0444, longitude: 31.2357, targetDistance: 4000 },
  { name: 'phone-default O downtown 4000', word: 'O', latitude: 30.0444, longitude: 31.2357, targetDistance: 4000 },
  { name: 'phone-default L Zamalek 4000', word: 'L', latitude: 30.0619, longitude: 31.2195, targetDistance: 4000 },
  { name: 'phone-default O Zamalek 4000', word: 'O', latitude: 30.0619, longitude: 31.2195, targetDistance: 4000 },
  { name: 'home-2km L Zamalek 2000', word: 'L', latitude: 30.0619, longitude: 31.2195, targetDistance: 2000 },
] as const;

for (const item of CASES) {
  const report = await runExperimentalPipeline({
    word: item.word,
    start: { latitude: item.latitude, longitude: item.longitude },
    targetDistanceMeters: item.targetDistance,
  });
  const diagnostics = buildExperimentalViabilityDiagnostics(
    {
      word: item.word,
      latitude: item.latitude,
      longitude: item.longitude,
      targetDistance: item.targetDistance,
    },
    report,
  );
  console.log(`\n######## ${item.name} status=${report.status} productRoutes=${diagnostics.stages.productAccepted} ########`);
  console.log(formatExperimentalViabilityDiagnostics(diagnostics));
}
