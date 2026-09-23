/**
 * DEVELOPMENT ONLY. TWO-SIDED ROUTE GUARD + FINAL-LETTER GUARD experiment.
 *
 * Does NOT rerun the search: the band candidates are a pure function of
 * the (unchanged) search + goal pool, and goal-guard-diagnostic-results.json
 * already stores, per candidate, the exact BASELINE_COST snapshot and the
 * exact BAND_01 / BAND_03 candidate snapshots (shape, targetCoverage,
 * backtracking, route/target, feasibility, continuity, per-letter physical
 * coverage / coverage / raw ink) produced by that run, together with its
 * parity proof against production. This script:
 *   1. re-verifies the stored parity flags (same search / states / goal pool
 *      / production baseline state) for every candidate;
 *   2. re-evaluates the OLD guard on the stored snapshots and checks it
 *      reproduces the stored verdicts exactly (proves the snapshots are
 *      complete and the guard inputs unchanged);
 *   3. applies the NEW two-sided + final-letter guard to the SAME snapshots.
 * graph-shape.ts is never touched.
 *
 * Run with: npx tsx src/diagnostics/goal-guard-two-sided.run.ts
 * (requires goal-guard-diagnostic-results.json from goal-guard-diagnostic.run.ts)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateSelectionGuard, evaluateTwoSidedGuard, finalLetterImproved, TWO_SIDED_LIMITS, GUARD_LIMITS, type GuardQuality, type GuardResult, type TwoSidedGuardResult } from './goal-selection-diagnostic';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const INPUT = resolve(DIAGNOSTIC_DIR, 'goal-guard-diagnostic-results.json');

type Letter = { letter: string; rawInk: number; coverage: number; physicallyCovered: boolean };
type Snap = {
  stateId: string;
  progress: number;
  cost: number;
  shapeScore: number;
  targetCoverage: number;
  backtracking: number;
  routeTarget: number;
  feasible: boolean;
  continuityValid: boolean;
  letters: Letter[];
  finalLetter: { reachesEnd: boolean; physicallyCovered: boolean; coverage: number; rawInk: number; zStrokeInk?: { top: number; diagonal: number; bottom: number } } | null;
  routeFinalProgress: number | null;
};
type StoredTreatment = { treatment: string; selected: Snap; sameAsBaseline: boolean; bandCandidate?: Snap; bandCandidateDiffers?: boolean; guard?: GuardResult | null };
type Stored = { word: string; caseLabel: string; placementId: string; parity: Record<string, boolean>; statesExplored: number; goalCount: number; baseline: Snap; treatments: StoredTreatment[] };

const mean = (v: readonly number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : Number.NaN);
const f = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const gq = (s: Snap): GuardQuality => ({ shapeScore: s.shapeScore, targetCoverage: s.targetCoverage, backtracking: s.backtracking, routeTarget: s.routeTarget, feasible: s.feasible, wordTraversalPhysical: false, continuityValid: s.continuityValid, letters: s.letters });
const fin = (s: Snap) => s.letters[s.letters.length - 1]!;
const improved = (b: Snap, c: Snap) => finalLetterImproved(gq(b), gq(c));
const worsened = (b: Snap, c: Snap) => (fin(b).physicallyCovered && !fin(c).physicallyCovered) || fin(b).coverage - fin(c).coverage > 0.05 || fin(c).rawInk < fin(b).rawInk - 1e-9;

type Row = {
  c: Stored;
  band01: Snap;
  band01Differs: boolean;
  band03: Snap;
  band03Differs: boolean;
  old01: GuardResult | null;
  old03: GuardResult | null;
  new01: TwoSidedGuardResult | null;
  new03: TwoSidedGuardResult | null;
};

type Selected = { snap: Snap; changed: boolean };
function pick(r: Row, t: string): Selected {
  switch (t) {
    case 'BASELINE_COST':
      return { snap: r.c.baseline, changed: false };
    case 'OLD_GUARDED_BAND_01':
      return r.band01Differs && r.old01!.accepted ? { snap: r.band01, changed: true } : { snap: r.c.baseline, changed: false };
    case 'OLD_GUARDED_BAND_03':
      return r.band03Differs && r.old03!.accepted ? { snap: r.band03, changed: true } : { snap: r.c.baseline, changed: false };
    case 'TWO_SIDED_GUARDED_BAND_01':
      return r.band01Differs && r.new01!.accepted ? { snap: r.band01, changed: true } : { snap: r.c.baseline, changed: false };
    case 'TWO_SIDED_GUARDED_BAND_03 (secondary)':
      return r.band03Differs && r.new03!.accepted ? { snap: r.band03, changed: true } : { snap: r.c.baseline, changed: false };
    case 'UNGUARDED_BAND_01':
      return { snap: r.band01, changed: r.band01Differs };
    default:
      throw new Error(t);
  }
}
const TREATMENTS = ['BASELINE_COST', 'OLD_GUARDED_BAND_01', 'TWO_SIDED_GUARDED_BAND_01', 'UNGUARDED_BAND_01', 'OLD_GUARDED_BAND_03', 'TWO_SIDED_GUARDED_BAND_03 (secondary)'];

type OutcomeClass = 'CLEAN_GAIN' | 'GAIN_BLOCKED_BY_GUARD' | 'REGRESSION_PREVENTED' | 'REGRESSION_NOT_CAUGHT' | 'NEUTRAL_SELECTION' | 'IDENTICAL';
/** Classification of the NEW BAND_01 selector, per candidate. */
function classify(r: Row, guard: TwoSidedGuardResult | GuardResult | null, differs: boolean, cand: Snap): OutcomeClass {
  if (!differs) return 'IDENTICAL';
  const imp = improved(r.c.baseline, cand);
  const worse = worsened(r.c.baseline, cand);
  if (guard!.accepted) {
    if (worse) return 'REGRESSION_NOT_CAUGHT';
    return imp ? 'CLEAN_GAIN' : 'NEUTRAL_SELECTION';
  }
  return imp && !worse ? 'GAIN_BLOCKED_BY_GUARD' : 'REGRESSION_PREVENTED';
}

function main() {
  const stored = JSON.parse(readFileSync(INPUT, 'utf8')) as { generatedAt: string; candidates: Stored[] };
  const rows: Row[] = stored.candidates.map((c) => {
    const t01 = c.treatments.find((t) => t.treatment === 'GUARDED_BAND_01')!;
    const t03 = c.treatments.find((t) => t.treatment === 'GUARDED_BAND_03')!;
    const band01 = t01.bandCandidate!;
    const band03 = t03.bandCandidate!;
    return {
      c,
      band01,
      band01Differs: Boolean(t01.bandCandidateDiffers),
      band03,
      band03Differs: Boolean(t03.bandCandidateDiffers),
      old01: t01.guard ?? null,
      old03: t03.guard ?? null,
      new01: t01.bandCandidateDiffers ? evaluateTwoSidedGuard(gq(c.baseline), gq(band01)) : null,
      new03: t03.bandCandidateDiffers ? evaluateTwoSidedGuard(gq(c.baseline), gq(band03)) : null,
    };
  });
  const z = rows.filter((r) => r.c.word === 'ROBZ');
  const o = rows.filter((r) => r.c.word === 'CAIRO');

  console.log(`=== INPUT / PARITY === ${INPUT} (generated ${stored.generatedAt})`);
  const parityKeys = Object.keys(rows[0]!.c.parity);
  console.log(`  stored parity: ${parityKeys.map((k) => `${k}=${rows.filter((r) => r.c.parity[k]).length}/${rows.length}`).join(' ')}`);
  let oldMismatch = 0;
  for (const r of rows) {
    for (const [differs, snap, stored_] of [[r.band01Differs, r.band01, r.old01], [r.band03Differs, r.band03, r.old03]] as const) {
      if (!differs) continue;
      const re = evaluateSelectionGuard(gq(r.c.baseline), gq(snap));
      if (JSON.stringify(re) !== JSON.stringify(stored_)) oldMismatch += 1;
    }
  }
  console.log(`  old guard re-evaluated on stored snapshots reproduces stored verdicts: ${oldMismatch === 0 ? 'YES (0 mismatches)' : `NO (${oldMismatch} mismatches)`}`);
  console.log(`  corpus Z=${z.length} O=${o.length} R=${z.length} C=${o.length} I=${o.length}; new guard limits: shape≥-${GUARD_LIMITS.shapeDrop} tgtCov≥-${GUARD_LIMITS.targetCoverageDrop} backtr≤+${GUARD_LIMITS.backtrackRise} |ratio-1|≤×${TWO_SIDED_LIMITS.distanceFactor} (zero→≤${TWO_SIDED_LIMITS.zeroDistanceTolerance}) finalCov≥-${TWO_SIDED_LIMITS.finalCoverageDrop} finalRawInk no decrease, candidate continuity must be valid`);

  console.log('');
  console.log('=== MAIN TABLE ===');
  console.log('| Treatment | Z complete | O complete | Z end | O end | Z coverage | O coverage | Z progress | O progress | Z shape | O shape | Z feasible | O feasible | Z changed | O changed |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of TREATMENTS) {
    const col = (rs: Row[]) => {
      const s = rs.map((r) => pick(r, t));
      return {
        complete: s.filter((x) => fin(x.snap).physicallyCovered).length,
        end: s.filter((x) => x.snap.finalLetter?.reachesEnd).length,
        cov: mean(s.map((x) => fin(x.snap).coverage)),
        prog: mean(s.map((x) => x.snap.routeFinalProgress ?? 0)),
        shape: mean(s.map((x) => x.snap.shapeScore)),
        feasible: s.filter((x) => x.snap.feasible).length,
        changed: s.filter((x) => x.changed).length,
      };
    };
    const a = col(z);
    const b = col(o);
    console.log(`| ${t} | ${a.complete}/${z.length} | ${b.complete}/${o.length} | ${a.end} | ${b.end} | ${f(a.cov)} | ${f(b.cov)} | ${f(a.prog)} | ${f(b.prog)} | ${f(a.shape)} | ${f(b.shape)} | ${a.feasible} | ${b.feasible} | ${a.changed} | ${b.changed} |`);
  }

  console.log('');
  console.log('=== OUTCOME CLASSIFICATION (candidates where BAND_01 differs from baseline) ===');
  for (const [label, rs] of [['Z', z], ['O', o], ['ALL', rows]] as const) {
    for (const [name, get] of [['OLD_GUARDED_BAND_01', (r: Row) => r.old01], ['TWO_SIDED_GUARDED_BAND_01', (r: Row) => r.new01]] as const) {
      const counts: Record<OutcomeClass, number> = { CLEAN_GAIN: 0, GAIN_BLOCKED_BY_GUARD: 0, REGRESSION_PREVENTED: 0, REGRESSION_NOT_CAUGHT: 0, NEUTRAL_SELECTION: 0, IDENTICAL: 0 };
      for (const r of rs) counts[classify(r, get(r), r.band01Differs, r.band01)] += 1;
      console.log(`  ${label.padEnd(3)} ${name.padEnd(26)} ${JSON.stringify(counts)}`);
    }
  }

  console.log('');
  console.log('=== GUARD COMPARISON (BAND_01, all 78; tested = band differs from baseline) ===');
  const tested = rows.filter((r) => r.band01Differs);
  console.log(`  tested=${tested.length}/${rows.length}; old accepted=${tested.filter((r) => r.old01!.accepted).length} new accepted=${tested.filter((r) => r.new01!.accepted).length}`);
  console.log('  guard                        rejects  %tested  sole-blocker  blocked-final-gain(sole)  prevented-regression');
  const report = (label: string, get: (r: Row) => GuardResult | TwoSidedGuardResult, key: string) => {
    const fails = tested.filter((r) => !(get(r) as unknown as Record<string, boolean>)[key]);
    const sole = fails.filter((r) => get(r).rejectionReasons.length === 1);
    const blocked = fails.filter((r) => improved(r.c.baseline, r.band01) && !worsened(r.c.baseline, r.band01));
    const blockedSole = blocked.filter((r) => get(r).rejectionReasons.length === 1);
    const prevented = fails.filter((r) => !improved(r.c.baseline, r.band01) || worsened(r.c.baseline, r.band01));
    console.log(`  ${label.padEnd(28)} ${String(fails.length).padStart(5)}    ${f((100 * fails.length) / tested.length, 0).padStart(4)}%   ${String(sole.length).padStart(6)}         ${String(blocked.length).padStart(4)} (${blockedSole.length})                ${String(prevented.length).padStart(4)}`);
  };
  for (const k of ['feasibilityGuard', 'shapeGuard', 'coverageGuard', 'backtrackGuard', 'lengthRatioGuard', 'letterCoverageGuard', 'continuityGuard']) report(`OLD ${k}`, (r) => r.old01!, k);
  for (const k of ['feasibilityGuard', 'shapeGuard', 'coverageGuard', 'backtrackGuard', 'twoSidedRouteTargetGuard', 'letterCoverageGuard', 'finalLetterCoverageGuard', 'finalLetterRawInkGuard', 'continuityGuard']) report(`NEW ${k}`, (r) => r.new01!, k);
  const oldRtBlockedGains = tested.filter((r) => !r.old01!.lengthRatioGuard && improved(r.c.baseline, r.band01) && !worsened(r.c.baseline, r.band01));
  console.log(`  previously route/target-blocked final-letter gains: ${oldRtBlockedGains.length}; now pass the two-sided guard: ${oldRtBlockedGains.filter((r) => r.new01!.twoSidedRouteTargetGuard).length}; now fully ACCEPTED: ${oldRtBlockedGains.filter((r) => r.new01!.accepted).length}`);
  for (const r of oldRtBlockedGains) console.log(`    ${r.c.word} ${r.c.caseLabel} ${r.c.placementId}: ratio ${f(r.c.baseline.routeTarget)}→${f(r.band01.routeTarget)} two-sided=${r.new01!.twoSidedRouteTargetGuard} new=${r.new01!.accepted ? 'ACCEPTED' : `REJECTED(${r.new01!.rejectionReasons.join('+')})`}`);
  // Continuity-rule sensitivity (the specified rule vs the previous valid->invalid rule).
  const contOnly = tested.filter((r) => !r.new01!.accepted && r.new01!.rejectionReasons.every((x) => x === 'continuity'));
  console.log(`  rejected ONLY by the (new, stricter) continuity rule: ${contOnly.length}; of those the baseline was ALSO continuity-invalid: ${contOnly.filter((r) => !r.c.baseline.continuityValid).length}`);
  for (const r of contOnly) console.log(`    ${r.c.word} ${r.c.caseLabel} ${r.c.placementId}: baseline continuity=${r.c.baseline.continuityValid} final cov ${f(fin(r.c.baseline).coverage)}→${f(fin(r.band01).coverage)} phys ${fin(r.c.baseline).physicallyCovered}→${fin(r.band01).physicallyCovered} shape ${f(r.c.baseline.shapeScore)}→${f(r.band01.shapeScore)}`);

  console.log('');
  console.log('=== REMAINING BLOCKED GAINS (new BAND_01) ===');
  for (const r of tested.filter((x) => classify(x, x.new01, true, x.band01) === 'GAIN_BLOCKED_BY_GUARD')) {
    console.log(`  ${r.c.word} ${r.c.caseLabel} ${r.c.placementId}: reasons=${r.new01!.rejectionReasons.join('+')} final cov ${f(fin(r.c.baseline).coverage)}→${f(fin(r.band01).coverage)} rawInk ${f(fin(r.c.baseline).rawInk, 2)}→${f(fin(r.band01).rawInk, 2)} phys ${fin(r.c.baseline).physicallyCovered}→${fin(r.band01).physicallyCovered} shape ${f(r.c.baseline.shapeScore)}→${f(r.band01.shapeScore)} tgtCov ${f(r.c.baseline.targetCoverage)}→${f(r.band01.targetCoverage)} feasible=${r.band01.feasible} lettersLost=${r.c.baseline.letters.filter((l, i) => l.physicallyCovered && !r.band01.letters[i]!.physicallyCovered).map((l) => l.letter).join('') || '-'}`);
  }
  console.log('=== REGRESSIONS NOT CAUGHT (new BAND_01) ===');
  const notCaught = tested.filter((x) => classify(x, x.new01, true, x.band01) === 'REGRESSION_NOT_CAUGHT');
  console.log(`  ${notCaught.length}${notCaught.map((r) => ` | ${r.c.word} ${r.c.caseLabel} ${r.c.placementId}`).join('')}`);
  const oldNotCaught = tested.filter((x) => classify(x, x.old01, true, x.band01) === 'REGRESSION_NOT_CAUGHT');
  console.log(`  (old BAND_01 guard: ${oldNotCaught.length}${oldNotCaught.map((r) => ` | ${r.c.word} ${r.c.caseLabel} ${r.c.placementId}`).join('')})`);

  console.log('');
  console.log('=== DEEP DIVES (BAND_01 candidate vs baseline) ===');
  const DEEP = [
    ['ROBZ #1 (hard negative)', 'ROBZ', 'Zamalek/4000', 'sf-r315-s0.6-e-905.1-n905.1'],
    ['ROBZ #2 (positive control)', 'ROBZ', 'Alexandria/2000', 'sf-r315-s0.8-e0-n-400'],
    ['O #1', 'CAIRO', 'Alexandria/2000', 'sf-r22.5-s1.0-e282.8-n-282.8'],
    ['O #2', 'CAIRO', 'Zamalek/4000', 'sf-r315-s0.6-e0-n0'],
    ['O #3', 'CAIRO', 'Alexandria/2000', 'sf-r0-s1.0-e-282.8-n-282.8'],
  ];
  const line = (s: Snap) => {
    const z = s.finalLetter?.zStrokeInk;
    return `${s.stateId.padEnd(20)} prog=${f(s.progress)} cost=${f(s.cost, 1)} final cov=${f(fin(s).coverage)} rawInk=${f(fin(s).rawInk, 2)} phys=${fin(s).physicallyCovered ? 'Y' : 'n'}${z ? ` Z(t/d/b)=${f(z.top, 2)}/${f(z.diagonal, 2)}/${f(z.bottom, 2)}` : ''} shape=${f(s.shapeScore)} tgtCov=${f(s.targetCoverage)} backtr=${f(s.backtracking)} ratio=${f(s.routeTarget)} feasible=${s.feasible} continuity=${s.continuityValid} letters=${s.letters.map((l) => `${l.letter}${l.physicallyCovered ? '✓' : '·'}`).join('')}`;
  };
  for (const [label, word, caseLabel, id] of DEEP) {
    const r = rows.find((x) => x.c.word === word && x.c.caseLabel === caseLabel && x.c.placementId === id);
    console.log(`--- ${label}: ${word} ${caseLabel} ${id} ---`);
    if (!r) continue;
    console.log(`  baseline   ${line(r.c.baseline)}`);
    if (!r.band01Differs) {
      console.log('  BAND_01 selects the baseline state itself → baseline (nothing to guard)');
      continue;
    }
    console.log(`  BAND_01    ${line(r.band01)}`);
    console.log(`  OLD guard: ${r.old01!.accepted ? 'ACCEPTED' : `REJECTED (${r.old01!.rejectionReasons.join('+')})`}`);
    console.log(`  NEW guard: ${Object.entries(r.new01!).filter(([k]) => k.endsWith('Guard')).map(([k, v]) => `${k.replace('Guard', '')}=${v ? 'ok' : 'FAIL'}`).join(' ')} → ${r.new01!.accepted ? 'ACCEPTED' : `REJECTED (${r.new01!.rejectionReasons.join('+')}) → baseline`}`);
  }

  console.log('');
  console.log('=== R/C/I CONTROLS (TWO_SIDED_GUARDED_BAND_01) ===');
  for (const [letter, word, index] of [['R', 'ROBZ', 0], ['C', 'CAIRO', 0], ['I', 'CAIRO', 2]] as const) {
    const rs = rows.filter((r) => r.c.word === word);
    const sel = rs.map((r) => pick(r, 'TWO_SIDED_GUARDED_BAND_01').snap);
    const lost = rs.filter((r, i) => r.c.baseline.letters[index]!.physicallyCovered && !sel[i]!.letters[index]!.physicallyCovered).length;
    console.log(`  ${letter}: physically covered ${rs.filter((r) => r.c.baseline.letters[index]!.physicallyCovered).length} → ${sel.filter((s) => s.letters[index]!.physicallyCovered).length} (lost ${lost}) | feasible ${rs.filter((r) => r.c.baseline.feasible).length} → ${sel.filter((s) => s.feasible).length} | shape ${f(mean(rs.map((r) => r.c.baseline.shapeScore)))} → ${f(mean(sel.map((s) => s.shapeScore)))} | tgtCov ${f(mean(rs.map((r) => r.c.baseline.targetCoverage)))} → ${f(mean(sel.map((s) => s.targetCoverage)))}`);
  }

  const out = resolve(DIAGNOSTIC_DIR, 'goal-guard-two-sided-results.json');
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), input: INPUT, inputGeneratedAt: stored.generatedAt, limits: { ...GUARD_LIMITS, ...TWO_SIDED_LIMITS }, candidates: rows.map((r) => ({ word: r.c.word, caseLabel: r.c.caseLabel, placementId: r.c.placementId, baseline: r.c.baseline, band01: r.band01, band01Differs: r.band01Differs, oldGuard01: r.old01, newGuard01: r.new01, newGuard03: r.new03, outcomeNew01: classify(r, r.new01, r.band01Differs, r.band01), outcomeOld01: classify(r, r.old01, r.band01Differs, r.band01) })) }, null, 2), 'utf8');
  console.log('');
  console.log(`[goal-guard-two-sided] json: ${out}`);
}

main();
