/**
 * DEVELOPMENT ONLY. Completion-aware goal ELIGIBILITY (A) and goal checking at
 * beam entry (B), on top of the completion-aware selector, over the full
 * 78-placement Z/O corpus (170m collection). Read-only counterfactual.
 *
 * Goal status never influences expansion in graph-shape.ts's beamSearch (it
 * only updates bestGoal), so every variant is evaluated EXACTLY on one traced
 * production search per placement by changing only which states form the goal
 * pool. This independence is re-verified per placement by re-running the
 * search with a never-true goal check and comparing expansions and the final
 * beam.
 *
 *   CA  production goal pool (goal-checked when a beam is expanded, REAL_ISGOAL)
 *   A   CA ∪ expanded beam states whose final letter is physically complete AND
 *       in order, with search coverage >= goalCoverage — progress >= 0.88 NOT
 *       required for them (the global threshold is unchanged for everyone else)
 *   B   CA ∪ states of the final beam that the cap left unexpanded and that
 *       pass REAL_ISGOAL (i.e. goal-check at beam entry, not at expansion)
 *   C   A ∪ B (the A rule also applied to those final-beam states)
 * Selection in every variant: in-order-complete goals first, cheapest; else
 * cheapest goal. No production file is modified; graph-shape.ts is untouched.
 *
 * Run with: npx tsx src/diagnostics/completion-eligibility.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { shapeKindFromWord } from '../generation/graph-shape-router';
import { isFeasible } from '../generation/shape-discovery';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { letterBoundariesFromWordShape } from './multi-letter-trace';
import { routeGraphConstrainedShapeMirror, mirrorResultForState } from './graph-shape-goal-mirror';
import { routeQuality } from './goal-threshold-diagnostic';
import { analyzeStrokeTraversal, buildRoutePieces } from './z-diagonal-direction-diagnostic';
import { measureSubStrokeCoverage } from './z-checkpoint-repair-experiment';
import { createBeamTracer, pathOf, type StateRecord } from './beam-survival-diagnostic';
import { evaluatePhysicalWordTraversal, PHYSICAL_TRAVERSAL_DEFAULTS } from './physical-word-traversal-evaluator';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const CASES = [
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
];
const FOURTEEN: Record<string, string> = {
  'ROBZ|Alexandria/2000|sf-r0-s1.0-e282.8-n-282.8': 'A',
  'ROBZ|Alexandria/2000|sf-r22.5-s1.0-e-565.7-n-565.7': 'B',
  'ROBZ|Alexandria/2000|sf-r315-s0.8-e0-n-400': 'B',
  'ROBZ|Alexandria/4000|sf-r157.5-s0.6-e-452.5-n-452.5': 'B',
  'ROBZ|Zamalek/2000|sf-r67.5-s0.8-e-565.7-n565.7': 'B',
  'CAIRO|Alexandria/2000|sf-r22.5-s0.8-e-282.8-n282.8': 'B',
  'CAIRO|Alexandria/2000|sf-r22.5-s1.0-e0-n-400': 'B',
  'CAIRO|Alexandria/2000|sf-r112.5-s1.0-e565.7-n565.7': 'A',
  'CAIRO|Alexandria/2000|sf-r90-s1.0-e0-n-400': 'A',
  'CAIRO|Alexandria/2000|sf-r45-s1.2-e565.7-n565.7': 'F',
  'CAIRO|Alexandria/2000|sf-r67.5-s1.2-e400-n0': 'B',
  'CAIRO|Zamalek/2000|sf-r90-s0.6-e-565.7-n565.7': 'B',
  'CAIRO|Zamalek/2000|sf-r337.5-s0.8-e800-n0': 'B',
  'CAIRO|Zamalek/2000|sf-r315-s0.8-e800-n0': 'B',
};
const VARIANTS = ['PROD', 'CA', 'A', 'B', 'C'] as const;
type Variant = (typeof VARIANTS)[number];
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const mean = (v: readonly number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : Number.NaN);

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}
function bitCount(v: number): number {
  let c = 0;
  let b = v >>> 0;
  while (b) {
    c += b & 1;
    b >>>= 1;
  }
  return c;
}

type Snap = {
  stateId: number;
  progress: number;
  searchCoverage: number;
  cost: number;
  feasible: boolean;
  shapeScore: number;
  targetCoverage: number;
  finalCoverage: number;
  finalPhysical: boolean;
  finalCategory: string;
  finalInOrder: boolean;
  wordPhysical: boolean;
  lettersPhysical: boolean[];
  routeTarget: number;
  routeLengthMeters: number;
  heading: number;
  pool: string;
};

type Row = { key: string; word: string; caseLabel: string; placementId: string; parity: boolean; expansionIndependent: boolean; poolSizes: Record<Variant, number>; picks: Record<Variant, Snap> };

async function main() {
  const started = Date.now();
  const rows: Row[] = [];
  for (const word of ['ROBZ', 'CAIRO']) {
    const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
    const finalB = boundaries[boundaries.length - 1]!;
    const window = { label: finalB.letter, start: finalB.projectedStartProgress, end: finalB.projectedEndProgress };
    for (const tc of CASES) {
      const caseLabel = `${tc.locationName}/${tc.targetDistanceMeters}`;
      const report = await runExperimentalPipelineMultiVariant({ word, start: tc.start, targetDistanceMeters: tc.targetDistanceMeters }, ['smooth']);
      const records = (report.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2);
      for (const record of records) {
        const target = record.target;
        const graph = reconstructGraph(record.graphLines);
        const kind = shapeKindFromWord(word);
        const loop = isClosedTarget(target);
        const production = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
        const { observer, trace } = createBeamTracer();
        const mirror = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
        const parity = JSON.stringify(mirror.pathPoints) === JSON.stringify(production.pathPoints) && JSON.stringify(production.pathPoints) === JSON.stringify(record.pathPoints) && mirror.search.statesExplored === production.search.statesExplored;
        // Expansion independence: a never-true goal check must produce the same expansions and the same final beam.
        const { observer: o2, trace: t2 } = createBeamTracer();
        routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer: o2, goalCheck: () => false });
        const lastBeam = (t: typeof trace) => t.records.filter((r) => r.fate === 'survived' && !r.expanded).map((r) => r.state.edgeIds.join(',')).sort().join('|');
        const expansionIndependent = t2.finish!.expansions === trace.finish!.expansions && t2.records.length === trace.records.length && lastBeam(t2) === lastBeam(trace);

        const cache = new Map<number, Snap>();
        const snap = (rec: StateRecord, pool: string): Snap => {
          const hit = cache.get(rec.id);
          if (hit) return { ...hit, pool };
          const res = mirrorResultForState(rec.state, trace.directed, target, kind, loop, mirror.regions, mirror.search);
          const q = routeQuality(word, target, res.pathPoints, res.failure)!;
          const phys = evaluatePhysicalWordTraversal(word, target, res.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
          const fl = phys.letters[phys.letters.length - 1]!;
          const trav = analyzeStrokeTraversal(buildRoutePieces(res.pathPoints, target), target, window);
          const s: Snap = {
            stateId: rec.id,
            progress: rec.state.progress,
            searchCoverage: bitCount(rec.state.covered) / GRAPH_SHAPE.progressBins,
            cost: rec.state.cost,
            feasible: isFeasible(res),
            shapeScore: q.shapeScore,
            targetCoverage: res.metrics.targetCoverage,
            finalCoverage: fl.coverage,
            finalPhysical: fl.physicallyCovered,
            finalCategory: trav.category,
            finalInOrder: fl.physicallyCovered && trav.category === 'A_correct',
            wordPhysical: phys.wordTraversalPhysical,
            lettersPhysical: phys.letters.map((l) => l.physicallyCovered),
            routeTarget: q.routeTarget,
            routeLengthMeters: polylineLength(res.pathPoints),
            heading: res.metrics.headingAgreement,
            pool,
          };
          cache.set(rec.id, s);
          return s;
        };
        const inkOk = new Map<number, boolean>();
        const inked = (r: StateRecord) => {
          let v = inkOk.get(r.id);
          if (v === undefined) {
            const p = pathOf(r.state, trace.directed);
            v = p.length >= 2 && measureSubStrokeCoverage(p, target, [{ label: 'f', start: window.start, end: window.end }])[0]!.occupancy >= PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold;
            inkOk.set(r.id, v);
          }
          return v;
        };
        const cov = (r: StateRecord) => bitCount(r.state.covered) / GRAPH_SHAPE.progressBins;
        const realGoal = (r: StateRecord) => cov(r) >= GRAPH_SHAPE.goalCoverage && r.state.progress >= GRAPH_SHAPE.goalProgress;
        const completeInOrder = (r: StateRecord) => inked(r) && snap(r, '').finalInOrder;

        const prodGoals = trace.records.filter((r) => r.isGoal);
        const expanded = trace.records.filter((r) => (r.fate === 'survived' || r.fate === 'start') && r.expanded && !r.isGoal);
        const finalBeam = trace.unexpandedAtCap.map((id) => trace.records[id]!);
        // A: expanded (goal-checked) non-goal beam states, coverage ok, final letter complete in order — progress requirement dropped for them only.
        const aExtra = expanded.filter((r) => cov(r) >= GRAPH_SHAPE.goalCoverage && completeInOrder(r));
        // B: final-beam states the cap left unexpanded that pass the unchanged REAL_ISGOAL.
        const bExtra = finalBeam.filter(realGoal);
        // C: A ∪ B, plus the A rule applied to unexpanded final-beam states.
        const cExtra = [...new Set([...aExtra, ...bExtra, ...finalBeam.filter((r) => cov(r) >= GRAPH_SHAPE.goalCoverage && completeInOrder(r))])];
        const pools: Record<Exclude<Variant, 'PROD'>, StateRecord[]> = { CA: prodGoals, A: [...prodGoals, ...aExtra], B: [...prodGoals, ...bExtra], C: [...prodGoals, ...cExtra] };

        const prodRec = trace.byState.get(trace.finish!.best!)!;
        const select = (pool: StateRecord[], label: string): Snap => {
          const sorted = [...pool].sort((a, b) => a.state.cost - b.state.cost || a.id - b.id);
          for (const r of sorted) if (completeInOrder(r)) return snap(r, label);
          return snap(sorted[0] ?? prodRec, label);
        };
        const picks = {
          PROD: snap(prodRec, 'PROD'),
          CA: select(pools.CA, 'CA'),
          A: select(pools.A, 'A'),
          B: select(pools.B, 'B'),
          C: select(pools.C, 'C'),
        } as Record<Variant, Snap>;
        rows.push({ key: `${word}|${caseLabel}|${record.placementId}`, word, caseLabel, placementId: record.placementId, parity, expansionIndependent, poolSizes: { PROD: prodGoals.length, CA: pools.CA.length, A: pools.A.length, B: pools.B.length, C: pools.C.length }, picks });
      }
      console.log(`[case] ${word} ${caseLabel}: ${records.length} placements`);
    }
  }

  // ------------------------------------------------------------------ report
  console.log('');
  console.log(`=== PARITY === traced == production == pipeline record: ${rows.filter((r) => r.parity).length}/${rows.length}; goal logic independent of expansion (never-true goal check → same expansions, same records, same final beam): ${rows.filter((r) => r.expansionIndependent).length}/${rows.length}`);

  for (const [label, rs] of [['Z (ROBZ)', rows.filter((r) => r.word === 'ROBZ')], ['O (CAIRO)', rows.filter((r) => r.word === 'CAIRO')], ['ALL', rows]] as const) {
    console.log('');
    console.log(`=== ${label} (n=${rs.length}) ===`);
    console.log('| metric | PROD | CA | A | B | C |');
    console.log('|---|---|---|---|---|---|');
    const cnt = (sel: (s: Snap) => boolean) => VARIANTS.map((v) => rs.filter((r) => sel(r.picks[v])).length).join(' | ');
    const avg = (sel: (s: Snap) => number, d = 3) => VARIANTS.map((v) => f(mean(rs.map((r) => sel(r.picks[v]))), d)).join(' | ');
    console.log(`| final letter physically complete | ${cnt((s) => s.finalPhysical)} |`);
    console.log(`| final letter complete in order | ${cnt((s) => s.finalInOrder)} |`);
    console.log(`| whole word physical | ${cnt((s) => s.wordPhysical)} |`);
    console.log(`| feasible | ${cnt((s) => s.feasible)} |`);
    console.log(`| shapeScore | ${avg((s) => s.shapeScore)} |`);
    console.log(`| target coverage | ${avg((s) => s.targetCoverage)} |`);
    console.log(`| final-letter coverage | ${avg((s) => s.finalCoverage)} |`);
    console.log(`| route/target | ${avg((s) => s.routeTarget)} |`);
    console.log(`| route length m | ${avg((s) => s.routeLengthMeters, 0)} |`);
    console.log(`| heading agreement | ${avg((s) => s.heading)} |`);
    console.log(`| progress | ${avg((s) => s.progress)} |`);
    console.log(`| cost | ${avg((s) => s.cost, 1)} |`);
    console.log(`| goal pool size (mean) | ${VARIANTS.map((v) => f(mean(rs.map((r) => r.poolSizes[v])), 1)).join(' | ')} |`);
    for (const v of ['CA', 'A', 'B', 'C'] as const) {
      const changedVsProd = rs.filter((r) => r.picks[v].stateId !== r.picks.PROD.stateId);
      const changedVsCA = rs.filter((r) => r.picks[v].stateId !== r.picks.CA.stateId);
      const feasLost = rs.filter((r) => r.picks.PROD.feasible && !r.picks[v].feasible);
      const earlierLost = rs.filter((r) => r.picks.PROD.lettersPhysical.slice(0, -1).some((x, i) => x && !r.picks[v].lettersPhysical[i]));
      const wordLost = rs.filter((r) => r.picks.PROD.wordPhysical && !r.picks[v].wordPhysical);
      const worse = changedVsProd.filter((r) => r.picks.PROD.shapeScore - r.picks[v].shapeScore > 0.03 || r.picks.PROD.targetCoverage - r.picks[v].targetCoverage > 0.05);
      const nonCompletionChange = changedVsProd.filter((r) => !r.picks[v].finalInOrder);
      console.log(`  ${v}: changed vs PROD ${changedVsProd.length} (of which not a completion ${nonCompletionChange.length}); changed vs CA ${changedVsCA.length}; feasibility lost ${feasLost.length}${feasLost.map((r) => ` [${r.key}]`).join('')}; earlier-letter physical lost ${earlierLost.length}; whole-word lost ${wordLost.length}; clearly worse (shape −.03 / tgtCov −.05) ${worse.length}${worse.map((r) => ` [${r.key}]`).join('')}`);
    }
  }

  console.log('');
  console.log('=== ORIGINAL 14 ===');
  console.log('| placement | prior class | CA | A | B | C |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows.filter((x) => FOURTEEN[x.key])) {
    const m = (v: Variant) => (r.picks[v].finalInOrder ? `✅ #${r.picks[v].stateId}` : `– #${r.picks[v].stateId}`);
    console.log(`| ${r.word === 'ROBZ' ? 'Z' : 'O'} ${r.caseLabel} ${r.placementId} | ${FOURTEEN[r.key]} | ${m('CA')} | ${m('A')} | ${m('B')} | ${m('C')} |`);
  }

  console.log('');
  console.log('=== THE 3 A CASES + THE F CASE (detail) ===');
  for (const r of rows.filter((x) => ['A', 'F'].includes(FOURTEEN[x.key] ?? ''))) {
    console.log(`--- ${r.key} (prior ${FOURTEEN[r.key]}) pool sizes ${JSON.stringify(r.poolSizes)}`);
    for (const v of VARIANTS) {
      const s = r.picks[v];
      console.log(`    ${v.padEnd(4)} #${s.stateId} progress=${f(s.progress)} searchCov=${f(s.searchCoverage, 2)} final: phys=${s.finalPhysical} dir=${s.finalCategory} inOrder=${s.finalInOrder} | eligible under old rule=${s.searchCoverage >= GRAPH_SHAPE.goalCoverage && s.progress >= GRAPH_SHAPE.goalProgress} | cost=${f(s.cost, 1)} shape=${f(s.shapeScore)} tgtCov=${f(s.targetCoverage)} finalCov=${f(s.finalCoverage)} route/tgt=${f(s.routeTarget)} len=${f(s.routeLengthMeters, 0)}m heading=${f(s.heading)} feasible=${s.feasible} letters=${s.lettersPhysical.map((x) => (x ? '✓' : '·')).join('')}`);
    }
  }

  writeFileSync(resolve(DIAGNOSTIC_DIR, 'completion-eligibility-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), 'utf8');
  console.log('');
  console.log(`[completion-eligibility] done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
