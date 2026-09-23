/**
 * DEVELOPMENT ONLY. Completion-aware goal selection counterfactual over the
 * FULL Z/O corpus (production-feasible placements, 170m collection).
 *
 * The production search runs once per placement (parity-checked against
 * routeGraphConstrainedShape and the pipeline record). ONLY the final goal
 * ranking changes:
 *   1. among goal states, prefer those whose final letter is physically
 *      complete (existing physical test) AND traversed in the correct
 *      direction (A_correct, z-diagonal-direction-diagnostic);
 *   2. lowest cost within that group;
 *   3. otherwise the production choice (lowest-cost goal).
 * Goal eligibility, cost, beam, cap, collection and feasibility are
 * untouched. No production file is modified; graph-shape.ts is untouched.
 *
 * Run with: npx tsx src/diagnostics/completion-aware-selection.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';

import { runExperimentalPipelineMultiVariant } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, type ShapeGraph } from '../generation/graph-shape';
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
/** The 14 placements from complete-state-loss.run.ts (in-order complete final-letter state exists), with their class there. */
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
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const mean = (v: readonly number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : Number.NaN);

function spearmanLike(xs: ReadonlyArray<{ cost: number; shape: number }>): number {
  if (xs.length < 3) return Number.NaN;
  const rank = (v: number[]) => {
    const o = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
    const r = new Array<number>(v.length);
    o.forEach((e, k) => (r[e.i] = k));
    return r;
  };
  const a = rank(xs.map((x) => x.cost));
  const b = rank(xs.map((x) => x.shape));
  const ma = mean(a);
  const mb = mean(b);
  let n = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    n += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : Number.NaN;
}

function reconstructGraph(graphLines: readonly Vec2[][]): ShapeGraph {
  return buildShapeGraph(graphLines.map((points, index) => ({ id: `line-${index}`, wayId: `line-${index}`, points })));
}

type Snap = {
  stateId: number;
  progress: number;
  cost: number;
  feasible: boolean;
  shapeScore: number;
  targetCoverage: number;
  finalCoverage: number;
  finalPhysical: boolean;
  finalInOrder: boolean;
  wordPhysical: boolean;
  lettersPhysical: boolean[];
  routeTarget: number;
  routeLengthMeters: number;
  heading: number;
  path: Vec2[];
};

type Row = {
  word: string;
  caseLabel: string;
  placementId: string;
  parity: boolean;
  goalCount: number;
  inkedGoals: number;
  completionGoals: number;
  completionGoalCostSpread: number | null;
  completionGoals_costShape: Array<{ cost: number; shape: number; feasible: boolean }>;
  production: Snap;
  counterfactual: Snap;
  changed: boolean;
  cls: string;
  clearlyWorse: boolean;
};

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

        const snap = (rec: StateRecord): Snap => {
          const res = mirrorResultForState(rec.state, trace.directed, target, kind, loop, mirror.regions, mirror.search);
          const q = routeQuality(word, target, res.pathPoints, res.failure)!;
          const phys = evaluatePhysicalWordTraversal(word, target, res.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
          const fl = phys.letters[phys.letters.length - 1]!;
          const trav = analyzeStrokeTraversal(buildRoutePieces(res.pathPoints, target), target, window);
          return {
            stateId: rec.id,
            progress: rec.state.progress,
            cost: rec.state.cost,
            feasible: isFeasible(res),
            shapeScore: q.shapeScore,
            targetCoverage: res.metrics.targetCoverage,
            finalCoverage: fl.coverage,
            finalPhysical: fl.physicallyCovered,
            finalInOrder: fl.physicallyCovered && trav.category === 'A_correct',
            wordPhysical: phys.wordTraversalPhysical,
            lettersPhysical: phys.letters.map((l) => l.physicallyCovered),
            routeTarget: q.routeTarget,
            routeLengthMeters: polylineLength(res.pathPoints),
            heading: res.metrics.headingAgreement,
            path: res.pathPoints,
          };
        };

        // Production choice: the search's own returned state (== lowest-cost goal, proven in earlier selector parity).
        const prodRec = trace.byState.get(trace.finish!.best!)!;
        const prod = snap(prodRec);
        // Goal pool, cheapest first (ties: earliest record). Completion needs final-letter raw ink >= inkThreshold;
        // measureSubStrokeCoverage on the letter window is the same ink-only occupancy the physical test uses.
        const goals = trace.records.filter((r) => r.isGoal).sort((a, b) => a.state.cost - b.state.cost || a.id - b.id);
        const inked = goals.filter((g) => {
          const p = pathOf(g.state, trace.directed);
          return p.length >= 2 && measureSubStrokeCoverage(p, target, [{ label: 'f', start: window.start, end: window.end }])[0]!.occupancy >= PHYSICAL_TRAVERSAL_DEFAULTS.inkThreshold;
        });
        const completion = inked.map((g) => ({ g, s: g === prodRec ? prod : snap(g) })).filter((x) => x.s.finalInOrder);
        const pick = completion[0];
        const cf = pick ? pick.s : prod;
        const changed = cf.stateId !== prod.stateId;

        let cls = 'F_no_change';
        if (changed) {
          const earlierLost = prod.lettersPhysical.slice(0, -1).some((v, i) => v && !cf.lettersPhysical[i]);
          if (prod.feasible && !cf.feasible) cls = 'D_feasibility_lost';
          else if ((prod.wordPhysical && !cf.wordPhysical) || earlierLost) cls = 'E_word_or_earlier_letter_lost';
          else if (cf.finalInOrder && !prod.finalInOrder) cls = 'A_final_letter_completed';
          else if (cf.shapeScore > prod.shapeScore || cf.finalCoverage > prod.finalCoverage) cls = 'B_quality_up_still_incomplete';
          else cls = 'C_changed_no_completion_gain';
        }
        rows.push({
          word,
          caseLabel,
          placementId: record.placementId,
          parity,
          goalCount: goals.length,
          inkedGoals: inked.length,
          completionGoals: completion.length,
          completionGoalCostSpread: completion.length > 1 ? completion[completion.length - 1]!.s.cost - completion[0]!.s.cost : null,
          completionGoals_costShape: completion.map((x) => ({ cost: x.s.cost, shape: x.s.shapeScore, feasible: x.s.feasible })),
          production: prod,
          counterfactual: cf,
          changed,
          cls,
          clearlyWorse: changed && (prod.shapeScore - cf.shapeScore > 0.03 || prod.targetCoverage - cf.targetCoverage > 0.05),
        });
      }
      console.log(`[case] ${word} ${caseLabel}: ${records.length} placements`);
    }
  }

  // ------------------------------------------------------------------ report
  const z = rows.filter((r) => r.word === 'ROBZ');
  const o = rows.filter((r) => r.word === 'CAIRO');
  console.log('');
  console.log(`=== PARITY === traced search == production routeGraphConstrainedShape == pipeline record: ${rows.filter((r) => r.parity).length}/${rows.length}`);

  const summary = (label: string, rs: Row[]) => {
    const g = (sel: (r: Row) => Snap) => {
      const xs = rs.map(sel);
      return {
        finalPhys: xs.filter((x) => x.finalPhysical).length,
        finalInOrder: xs.filter((x) => x.finalInOrder).length,
        word: xs.filter((x) => x.wordPhysical).length,
        feasible: xs.filter((x) => x.feasible).length,
        prog: mean(xs.map((x) => x.progress)),
        shape: mean(xs.map((x) => x.shapeScore)),
        cov: mean(xs.map((x) => x.targetCoverage)),
        fcov: mean(xs.map((x) => x.finalCoverage)),
        rt: mean(xs.map((x) => x.routeTarget)),
        len: mean(xs.map((x) => x.routeLengthMeters)),
        head: mean(xs.map((x) => x.heading)),
        cost: mean(xs.map((x) => x.cost)),
      };
    };
    const a = g((r) => r.production);
    const b = g((r) => r.counterfactual);
    console.log(`  ${label} (n=${rs.length})`);
    console.log('  | metric | production | completion-aware |');
    console.log('  |---|---|---|');
    const names: Array<[keyof typeof a, string, number]> = [['finalPhys', 'final letter physically complete', 0], ['finalInOrder', 'final letter complete IN ORDER', 0], ['word', 'whole word physical', 0], ['feasible', 'feasible', 0], ['prog', 'progress (mean)', 3], ['shape', 'shapeScore (mean)', 3], ['cov', 'target coverage (mean)', 3], ['fcov', 'final-letter coverage (mean)', 3], ['rt', 'route/target (mean)', 3], ['len', 'route length m (mean)', 0], ['head', 'heading agreement (mean)', 3], ['cost', 'total cost (mean)', 1]];
    for (const [k, n, d] of names) console.log(`  | ${n} | ${f(a[k], d)} | ${f(b[k], d)} |`);
    const cls: Record<string, number> = {};
    for (const r of rs) cls[r.cls] = (cls[r.cls] ?? 0) + 1;
    console.log(`  classes: ${JSON.stringify(cls)}`);
  };
  console.log('');
  console.log('=== FULL CORPUS ===');
  summary('Z (ROBZ)', z);
  summary('O (CAIRO)', o);

  console.log('');
  console.log('=== CHANGED PLACEMENTS ===');
  console.log('| placement | class | prod→cf state | progress | cost (Δ) | shapeScore | target cov | final cov | final in-order | feasible | route/target | length m | heading | in 14? |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows.filter((x) => x.changed)) {
    const p = r.production;
    const c = r.counterfactual;
    const key = `${r.word}|${r.caseLabel}|${r.placementId}`;
    console.log(`| ${r.word === 'ROBZ' ? 'Z' : 'O'} ${r.caseLabel} ${r.placementId} | ${r.cls}${r.clearlyWorse ? ' ⚠worse' : ''} | #${p.stateId}→#${c.stateId} | ${f(p.progress)}→${f(c.progress)} | ${f(p.cost, 0)}→${f(c.cost, 0)} (+${f(c.cost - p.cost, 0)}) | ${f(p.shapeScore)}→${f(c.shapeScore)} | ${f(p.targetCoverage)}→${f(c.targetCoverage)} | ${f(p.finalCoverage)}→${f(c.finalCoverage)} | ${p.finalInOrder}→${c.finalInOrder} | ${p.feasible}→${c.feasible} | ${f(p.routeTarget)}→${f(c.routeTarget)} | ${f(p.routeLengthMeters, 0)}→${f(c.routeLengthMeters, 0)} | ${f(p.heading)}→${f(c.heading)} | ${FOURTEEN[key] ?? '-'} |`);
  }

  console.log('');
  console.log('=== SPECIFIC QUESTIONS ===');
  const fourteen = rows.filter((r) => FOURTEEN[`${r.word}|${r.caseLabel}|${r.placementId}`]);
  const fixed = fourteen.filter((r) => r.counterfactual.finalInOrder);
  console.log(`  1. of the original 14, now returning an in-order complete state: ${fixed.length}/${fourteen.length} (by prior class: ${['A', 'B', 'F'].map((k) => `${k}=${fixed.filter((r) => FOURTEEN[`${r.word}|${r.caseLabel}|${r.placementId}`] === k).length}/${fourteen.filter((r) => FOURTEEN[`${r.word}|${r.caseLabel}|${r.placementId}`] === k).length}`).join(' ')})`);
  console.log(`  2. Z fixed ${fixed.filter((r) => r.word === 'ROBZ').length}/5, O fixed ${fixed.filter((r) => r.word === 'CAIRO').length}/9`);
  const worse = rows.filter((r) => r.clearlyWorse);
  console.log(`  3. changed selections clearly worse overall (shapeScore −0.03 or target coverage −0.05): ${worse.length}${worse.map((r) => ` | ${r.word} ${r.caseLabel} ${r.placementId} shape ${f(r.production.shapeScore)}→${f(r.counterfactual.shapeScore)} tgtCov ${f(r.production.targetCoverage)}→${f(r.counterfactual.targetCoverage)}`).join('')}`);
  const lost = rows.filter((r) => r.production.feasible && !r.counterfactual.feasible);
  console.log(`  4. previously feasible → infeasible: ${lost.length}${lost.map((r) => ` | ${r.word} ${r.caseLabel} ${r.placementId}`).join('')}`);
  console.log(`  5. whole-word physical: production ${rows.filter((r) => r.production.wordPhysical).length} → completion-aware ${rows.filter((r) => r.counterfactual.wordPhysical).length}; earlier-letter physical losses: ${rows.filter((r) => r.production.lettersPhysical.slice(0, -1).some((v, i) => v && !r.counterfactual.lettersPhysical[i])).length}`);
  const multi = rows.filter((r) => r.completionGoals > 1);
  console.log(`  6. placements with ≥1 completion-aware goal: ${rows.filter((r) => r.completionGoals >= 1).length}; with multiple: ${multi.length} (counts ${multi.map((r) => r.completionGoals).join(',')}); cost spread among them (max−min): ${multi.map((r) => f(r.completionGoalCostSpread, 0)).join(',')}`);
  if (multi.length) {
    // Is cost still a useful tie-breaker among completion-aware goals?
    let cheapestIsBest = 0;
    let cheapestFeasible = 0;
    const gaps: number[] = [];
    for (const r of multi) {
      const cs = r.completionGoals_costShape;
      const bestShape = Math.max(...cs.map((c) => c.shape));
      if (cs[0]!.shape >= bestShape - 1e-9) cheapestIsBest += 1;
      if (cs[0]!.feasible) cheapestFeasible += 1;
      gaps.push(bestShape - cs[0]!.shape);
    }
    console.log(`     cheapest completion-aware goal is also the best shapeScore among them: ${cheapestIsBest}/${multi.length}; shapeScore given up by taking the cheapest (mean/max): ${f(mean(gaps))}/${f(Math.max(...gaps))}; cheapest one feasible: ${cheapestFeasible}/${multi.length}`);
    const sp = multi.map((r) => spearmanLike(r.completionGoals_costShape));
    console.log(`     within-group rank correlation cost↔shapeScore (mean over placements with ≥3 completion goals): ${f(mean(sp.filter((v) => !Number.isNaN(v))))} (n=${sp.filter((v) => !Number.isNaN(v)).length}; negative = cheaper tends to be better-shaped)`);
  }
  console.log('');
  console.log(`[completion-aware-selection] done in ${Math.round((Date.now() - started) / 1000)}s`);
  writeFileSync(resolve(DIAGNOSTIC_DIR, 'completion-aware-selection-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows: rows.map((r) => ({ ...r, production: { ...r.production, path: undefined }, counterfactual: { ...r.counterfactual, path: undefined } })) }, null, 2), 'utf8');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
