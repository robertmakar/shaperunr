/**
 * DEVELOPMENT ONLY. Single-letter product checks at the Alexandria diagnostic GPS.
 */
import { experimentalProductRejectionReasons } from './experimental-product';
import { runExperimentalPipeline } from './graph-constrained-pipeline';

const START = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const LETTERS = ['L', 'O', 'C', 'Z'] as const;

for (const word of LETTERS) {
  const report = await runExperimentalPipeline({
    word,
    start: START,
    targetDistanceMeters: 2000,
  });
  const routed = report.routes.map((route) => {
    const reasons = experimentalProductRejectionReasons(route, { word, targetDistance: 2000 });
    return {
      id: route.id,
      score: route.shapeScore.toFixed(3),
      cov: route.coverage.toFixed(3),
      order: route.scoreBreakdown.order.toFixed(3),
      reasons: reasons.join(',') || 'PASS',
    };
  });
  const accepted = routed.filter((item) => item.reasons === 'PASS').length;
  console.log(
    `${word} graph=${report.diagnostics.graphFeasible} routed=${report.routes.length} product=${accepted} ${routed.map((item) => `${item.id}:${item.score}/${item.cov}/${item.order}:${item.reasons}`).join(' | ') || '(none)'}`,
  );
}
