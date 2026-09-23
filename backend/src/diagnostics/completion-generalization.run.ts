/**
 * DEVELOPMENT ONLY. Generalization test of counterfactual C (completion-aware
 * goal selection + completion-aware eligibility + final-beam goal checking)
 * over EVERY supported letter as the word-final letter.
 *
 * Corpus: two-letter words "I" + X for every X in getSupportedLetters()
 * (I is a single straight stroke, so the final letter X dominates; words
 * must be multi-letter so the search uses the generic multi-letter kind that
 * the Z/O corpus used). Cases: Alexandria/2000 and Zamalek/2000 (the Z/O
 * corpus locations). One 170m neighborhood collection per location is
 * collected once and injected (injection parity was proven in
 * collection-radius-counterfactual.run.ts). At most MAX_PER_CASE feasible
 * placements per word and case, in pipeline order.
 *
 * Search, cost, beam, cap, collection, placements and feasibility are the
 * production ones; C only changes the goal pool / selection post-search
 * (goal logic cannot affect expansion — re-verified per placement).
 * No production file is modified; graph-shape.ts is untouched.
 *
 * Run with: npx tsx src/diagnostics/completion-generalization.run.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { polylineLength, type Vec2 } from '@/lib/geometry';
import { getSupportedLetters } from '@/lib/letter-shapes';

import { runExperimentalPipelineMultiVariant } from '../generation/graph-constrained-pipeline';
import { buildShapeGraph, routeGraphConstrainedShape, isClosedTarget, GRAPH_SHAPE, type ShapeGraph } from '../generation/graph-shape';
import { collectNeighborhoodShapeGraph, shapeKindFromWord } from '../generation/graph-shape-router';
import { snapSearchOrigin, searchOriginFromSnap } from '../generation/snap-search-origin';
import { getSearchRadiusForTargetDistance } from '../generation/search-radius';
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
  { locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
];
const PREFIX = 'I';
const MAX_PER_CASE = 10;
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
  source: 'production_goal' | 'A_rule' | 'B_final_beam' | 'fallback';
  progress: number;
  searchCoverage: number;
  cost: number;
  feasible: boolean;
  shapeScore: number;
  targetCoverage: number;
  finalCoverage: number;
  finalRawInk: number;
  finalPhysical: boolean;
  finalCategory: string;
  finalInOrder: boolean;
  wordPhysical: boolean;
  lettersPhysical: boolean[];
  routeTarget: number;
  routeLengthMeters: number;
  heading: number;
};
type Row = { letter: string; word: string; caseLabel: string; placementId: string; parity: boolean; independent: boolean; prod: Snap; c: Snap; changed: boolean; cls: string; aRuleCandidates: number; aRuleCandidateProgress: number[] };

function classify(p: Snap, c: Snap, changed: boolean): string {
  if (!changed) return 'F_no_meaningful_change';
  if (p.feasible && !c.feasible) return 'D_feasibility_regression';
  if (p.lettersPhysical.slice(0, -1).some((v, i) => v && !c.lettersPhysical[i]) || (p.wordPhysical && !c.wordPhysical)) return 'E_earlier_letter_loss';
  if (c.finalInOrder && !p.finalInOrder) return 'A_new_in_order_completion';
  if (c.finalPhysical && !p.finalPhysical) return 'B_physical_completion_only';
  if (c.shapeScore > p.shapeScore || c.finalCoverage > p.finalCoverage) return 'C_quality_without_completion';
  return 'F_no_meaningful_change';
}

async function main() {
  const started = Date.now();
  const letters = getSupportedLetters();
  const rows: Row[] = [];
  for (const tc of CASES) {
    const caseLabel = `${tc.locationName}/${tc.targetDistanceMeters}`;
    const originSnap = await snapSearchOrigin(tc.start);
    const collection = await collectNeighborhoodShapeGraph(searchOriginFromSnap(originSnap), { radiusMeters: getSearchRadiusForTargetDistance(tc.targetDistanceMeters) });
    for (const letter of letters) {
      const word = `${PREFIX}${letter}`;
      const boundaries = letterBoundariesFromWordShape(buildWalkableWordShape(word, { letterVariant: 'smooth' })).boundaries;
      const finalB = boundaries[boundaries.length - 1]!;
      const window = { label: finalB.letter, start: finalB.projectedStartProgress, end: finalB.projectedEndProgress };
      const report = await runExperimentalPipelineMultiVariant({ word, start: tc.start, targetDistanceMeters: tc.targetDistanceMeters }, ['smooth'], { collection, searchOriginSnap: originSnap });
      const records = (report.diagnostics.feasibility ?? []).filter((r) => r.feasible && r.pathPoints.length >= 2).slice(0, MAX_PER_CASE);
      for (const record of records) {
        const target = record.target;
        const graph = reconstructGraph(record.graphLines);
        const kind = shapeKindFromWord(word);
        const loop = isClosedTarget(target);
        const production = routeGraphConstrainedShape({ target, graph, kind, multiLetter: true });
        const { observer, trace } = createBeamTracer();
        const mirror = routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer });
        const parity = JSON.stringify(mirror.pathPoints) === JSON.stringify(production.pathPoints) && JSON.stringify(production.pathPoints) === JSON.stringify(record.pathPoints) && mirror.search.statesExplored === production.search.statesExplored;
        const { observer: o2, trace: t2 } = createBeamTracer();
        routeGraphConstrainedShapeMirror({ target, graph, kind, multiLetter: true, observer: o2, goalCheck: () => false });
        const independent = t2.finish!.expansions === trace.finish!.expansions && t2.records.length === trace.records.length;

        const cache = new Map<number, Omit<Snap, 'source'>>();
        const snap = (rec: StateRecord, source: Snap['source']): Snap => {
          let s = cache.get(rec.id);
          if (!s) {
            const res = mirrorResultForState(rec.state, trace.directed, target, kind, loop, mirror.regions, mirror.search);
            const q = routeQuality(word, target, res.pathPoints, res.failure)!;
            const phys = evaluatePhysicalWordTraversal(word, target, res.pathPoints, 'smooth', PHYSICAL_TRAVERSAL_DEFAULTS);
            const fl = phys.letters[phys.letters.length - 1]!;
            const trav = analyzeStrokeTraversal(buildRoutePieces(res.pathPoints, target), target, window);
            s = {
              stateId: rec.id,
              progress: rec.state.progress,
              searchCoverage: bitCount(rec.state.covered) / GRAPH_SHAPE.progressBins,
              cost: rec.state.cost,
              feasible: isFeasible(res),
              shapeScore: q.shapeScore,
              targetCoverage: res.metrics.targetCoverage,
              finalCoverage: fl.coverage,
              finalRawInk: fl.rawInkCoverage,
              finalPhysical: fl.physicallyCovered,
              finalCategory: trav.category,
              finalInOrder: fl.physicallyCovered && trav.category === 'A_correct',
              wordPhysical: phys.wordTraversalPhysical,
              lettersPhysical: phys.letters.map((l) => l.physicallyCovered),
              routeTarget: q.routeTarget,
              routeLengthMeters: polylineLength(res.pathPoints),
              heading: res.metrics.headingAgreement,
            };
            cache.set(rec.id, s);
          }
          return { ...s, source };
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
        const completeInOrder = (r: StateRecord) => inked(r) && snap(r, 'fallback').finalInOrder;
        const realGoal = (r: StateRecord) => cov(r) >= GRAPH_SHAPE.goalCoverage && r.state.progress >= GRAPH_SHAPE.goalProgress;

        const prodGoals = trace.records.filter((r) => r.isGoal);
        const expanded = trace.records.filter((r) => (r.fate === 'survived' || r.fate === 'start') && r.expanded && !r.isGoal);
        const finalBeam = trace.unexpandedAtCap.map((id) => trace.records[id]!);
        const aRule = [...expanded, ...finalBeam].filter((r) => !realGoal(r) && cov(r) >= GRAPH_SHAPE.goalCoverage && completeInOrder(r));
        const bRule = finalBeam.filter(realGoal);
        const source = new Map<number, Snap['source']>();
        for (const r of prodGoals) source.set(r.id, 'production_goal');
        for (const r of bRule) if (!source.has(r.id)) source.set(r.id, 'B_final_beam');
        for (const r of aRule) if (!source.has(r.id)) source.set(r.id, 'A_rule');
        const pool = [...new Set([...prodGoals, ...bRule, ...aRule])].sort((a, b) => a.state.cost - b.state.cost || a.id - b.id);
        const prodRec = trace.byState.get(trace.finish!.best!)!;
        let pick: Snap | null = null;
        for (const r of pool) {
          if (completeInOrder(r)) {
            pick = snap(r, source.get(r.id)!);
            break;
          }
        }
        if (!pick) pick = snap(pool[0] ?? prodRec, pool[0] ? source.get(pool[0].id)! : 'fallback');
        const prod = snap(prodRec, 'production_goal');
        const changed = pick.stateId !== prod.stateId;
        rows.push({ letter, word, caseLabel, placementId: record.placementId, parity, independent, prod, c: pick, changed, cls: classify(prod, pick, changed), aRuleCandidates: aRule.length, aRuleCandidateProgress: aRule.map((r) => r.state.progress) });
      }
      console.log(`[${caseLabel}] ${word}: ${records.length} placements (${Math.round((Date.now() - started) / 1000)}s)`);
    }
  }

  // ------------------------------------------------------------------ report
  console.log('');
  console.log(`=== PARITY === traced == production == pipeline record: ${rows.filter((r) => r.parity).length}/${rows.length}; goal logic independent of expansion: ${rows.filter((r) => r.independent).length}/${rows.length}`);

  const byLetter = new Map<string, Row[]>();
  for (const r of rows) (byLetter.get(r.letter) ?? byLetter.set(r.letter, []).get(r.letter)!).push(r);
  console.log('');
  console.log('=== PER LETTER (final letter X in word "I"+X; PROD → C) ===');
  console.log('| X | n | in-order complete | physically complete | whole word | feasible | shapeScore | target cov | final cov | route/target | length m | heading | cost | changed | A | B | C | D | E | A-rule picks (progress) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [letter, rs] of [...byLetter.entries()].sort()) {
    const c = (sel: (s: Snap) => boolean) => `${rs.filter((r) => sel(r.prod)).length}→${rs.filter((r) => sel(r.c)).length}`;
    const m = (sel: (s: Snap) => number, d = 3) => `${f(mean(rs.map((r) => sel(r.prod))), d)}→${f(mean(rs.map((r) => sel(r.c))), d)}`;
    const k = (cls: string) => rs.filter((r) => r.cls.startsWith(cls)).length;
    const aPicks = rs.filter((r) => r.c.source === 'A_rule');
    console.log(`| ${letter} | ${rs.length} | ${c((s) => s.finalInOrder)} | ${c((s) => s.finalPhysical)} | ${c((s) => s.wordPhysical)} | ${c((s) => s.feasible)} | ${m((s) => s.shapeScore)} | ${m((s) => s.targetCoverage)} | ${m((s) => s.finalCoverage)} | ${m((s) => s.routeTarget)} | ${m((s) => s.routeLengthMeters, 0)} | ${m((s) => s.heading)} | ${m((s) => s.cost, 0)} | ${rs.filter((r) => r.changed).length} | ${k('A_')} | ${k('B_')} | ${k('C_')} | ${k('D_')} | ${k('E_')} | ${aPicks.length}${aPicks.length ? ` (${aPicks.map((r) => f(r.c.progress, 2)).join(',')})` : ''} |`);
  }

  console.log('');
  console.log('=== TOTALS ===');
  const tot = (sel: (s: Snap) => boolean) => `${rows.filter((r) => sel(r.prod)).length} → ${rows.filter((r) => sel(r.c)).length}`;
  console.log(`  placements ${rows.length} over ${byLetter.size} letters; in-order complete ${tot((s) => s.finalInOrder)}; physically complete ${tot((s) => s.finalPhysical)}; whole word ${tot((s) => s.wordPhysical)}; feasible ${tot((s) => s.feasible)}`);
  const cls: Record<string, number> = {};
  for (const r of rows) cls[r.cls] = (cls[r.cls] ?? 0) + 1;
  console.log(`  classes: ${JSON.stringify(cls)}`);
  console.log(`  means PROD→C: shapeScore ${f(mean(rows.map((r) => r.prod.shapeScore)))}→${f(mean(rows.map((r) => r.c.shapeScore)))} targetCov ${f(mean(rows.map((r) => r.prod.targetCoverage)))}→${f(mean(rows.map((r) => r.c.targetCoverage)))} finalCov ${f(mean(rows.map((r) => r.prod.finalCoverage)))}→${f(mean(rows.map((r) => r.c.finalCoverage)))}`);
  const sources: Record<string, number> = {};
  for (const r of rows.filter((x) => x.changed)) sources[r.c.source] = (sources[r.c.source] ?? 0) + 1;
  console.log(`  changed selections by source: ${JSON.stringify(sources)}`);

  console.log('');
  console.log('=== REGRESSIONS (D/E) ===');
  for (const r of rows.filter((x) => x.cls.startsWith('D_') || x.cls.startsWith('E_'))) {
    console.log(`  ${r.word} ${r.caseLabel} ${r.placementId}: ${r.cls} source=${r.c.source} shape ${f(r.prod.shapeScore)}→${f(r.c.shapeScore)} tgtCov ${f(r.prod.targetCoverage)}→${f(r.c.targetCoverage)} feasible ${r.prod.feasible}→${r.c.feasible} letters ${r.prod.lettersPhysical.map((x) => (x ? '✓' : '·')).join('')}→${r.c.lettersPhysical.map((x) => (x ? '✓' : '·')).join('')}`);
  }

  console.log('');
  console.log('=== IS search coverage ≥ 0.62 SUFFICIENT FOR THE A RULE? (all A-rule candidates admitted, then those selected) ===');
  const allA = rows.flatMap((r) => r.aRuleCandidateProgress.map((p) => ({ letter: r.letter, p })));
  console.log(`  A-rule candidates admitted: ${allA.length} across ${new Set(allA.map((x) => x.letter)).size} letters; their search progress: min ${f(Math.min(...allA.map((x) => x.p)))} median ${f(allA.map((x) => x.p).sort((a, b) => a - b)[Math.floor(allA.length / 2)])} (every one is, by construction, a physically complete + A_correct final letter)`);
  const aSel = rows.filter((r) => r.c.source === 'A_rule');
  console.log(`  A-rule states SELECTED: ${aSel.length}`);
  for (const r of aSel) {
    const poor = [r.c.shapeScore < r.prod.shapeScore - 0.03 ? 'shape−' : '', r.c.targetCoverage < r.prod.targetCoverage - 0.05 ? 'tgtCov−' : '', !r.c.feasible ? 'INFEASIBLE' : '', r.prod.lettersPhysical.slice(0, -1).some((v, i) => v && !r.c.lettersPhysical[i]) ? 'EARLIER-LETTER-LOSS' : '', r.c.progress < 0.5 ? 'progress<0.5' : ''].filter(Boolean).join(',');
    console.log(`    ${r.word} ${r.caseLabel} ${r.placementId}: progress ${f(r.c.progress)} searchCov ${f(r.c.searchCoverage, 2)} final ${r.letter} cov ${f(r.c.finalCoverage)} ink ${f(r.c.finalRawInk, 2)} ${r.c.finalCategory} | shape ${f(r.prod.shapeScore)}→${f(r.c.shapeScore)} tgtCov ${f(r.prod.targetCoverage)}→${f(r.c.targetCoverage)} feasible ${r.c.feasible} letters ${r.c.lettersPhysical.map((x) => (x ? '✓' : '·')).join('')} ${poor ? `⚠ ${poor}` : 'ok'}`);
  }

  writeFileSync(resolve(DIAGNOSTIC_DIR, 'completion-generalization-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), prefix: PREFIX, cases: CASES.map((c) => `${c.locationName}/${c.targetDistanceMeters}`), maxPerCase: MAX_PER_CASE, rows }, null, 2), 'utf8');
  console.log('');
  console.log(`[completion-generalization] done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
