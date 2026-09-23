/** DEVELOPMENT ONLY. Per-request added latency of the completion-aware goal hook: sums routeGraphConstrainedShape time over a full feasibility pool with and without the hook.
 * Run with: npx tsx src/diagnostics/completion-aware-latency.run.ts */
import { performance } from 'node:perf_hooks';
import { runExperimentalPipelineMultiVariant } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape } from '../generation/graph-shape';
import { createCompletionAwareGoalSupport } from '../generation/completion-aware-goal';
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
async function main() {
  for (const [word, start, dist, label] of [['ROBZ', ZAMALEK, 4000, 'Zam/4000'], ['CAIRO', ALEXANDRIA, 2000, 'Alex/2000'], ['IX', ALEXANDRIA, 2000, 'Alex/2000'], ['HELLO', ZAMALEK, 2000, 'Zam/2000']] as const) {
    const report = await runExperimentalPipelineMultiVariant({ word, start, targetDistanceMeters: dist }, ['smooth']);
    let a = 0;
    let b = 0;
    let worst = 0;
    const pool = report.diagnostics.feasibility ?? [];
    for (const r of pool) {
      const graph = buildShapeGraph(r.graphLines.map((points, i) => ({ id: `l${i}`, wayId: `l${i}`, points })));
      let t = performance.now();
      routeGraphConstrainedShape({ target: r.target, graph, kind: 'generic', multiLetter: true });
      a += performance.now() - t;
      t = performance.now();
      routeGraphConstrainedShape({ target: r.target, graph, kind: 'generic', multiLetter: true, completionAware: createCompletionAwareGoalSupport({ word, target: r.target, geometryVariant: 'smooth' }) });
      const d = performance.now() - t;
      b += d;
      worst = Math.max(worst, d);
    }
    console.log(JSON.stringify({ word, label, pool: pool.length, searchMsWithout: Math.round(a), searchMsWith: Math.round(b), addedMs: Math.round(b - a), worstSearchMs: Math.round(worst) }));
  }
}
main();
