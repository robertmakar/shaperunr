/**
 * DEVELOPMENT ONLY. Tests for the evaluator-synthesis diagnostic
 * (evaluator-synthesis-diagnostic.ts).
 *
 * A. classifyPhysicalBucket boundary correctness.
 * B. computeRequiredComponents algebra: plugging the required value back
 *    into the REAL, unmodified 0.5D+0.3P+0.2G formula reproduces the
 *    target exactly.
 * C. classifyRequiredBucket boundary correctness.
 * D. evaluateOrderWeightVariant: A_current exactly reproduces the real
 *    order formula; weights in each variant sum to 1.
 * E. medianGlobalProgress correctness on a known synthetic case.
 * F. evaluateBroadOrder: monotonic medians pass, a reversed sequence
 *    fails, a missing letter (null median) fails and is flagged.
 * G. read-only / production isolation.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import {
  classifyPhysicalBucket,
  computeRequiredComponents,
  classifyRequiredBucket,
  evaluateOrderWeightVariant,
  ORDER_WEIGHT_VARIANTS,
  medianGlobalProgress,
  evaluateBroadOrder,
  extractLetterOrderInputs,
} from './evaluator-synthesis-diagnostic';
import type { Vec2 } from '@/lib/geometry';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

// --- A. classifyPhysicalBucket ---
{
  const cases: Array<[number, number, string]> = [
    [0.95, 0.6, 'A_ink90_cov50'],
    [0.85, 0.6, 'B_ink80_cov50'],
    [0.75, 0.45, 'C_ink70_cov40'],
    [0.5, 0.3, 'below_C'],
  ];
  let allMatch = true;
  const details: string[] = [];
  for (const [rawInk, coverage, expected] of cases) {
    const actual = classifyPhysicalBucket(rawInk, coverage);
    if (actual !== expected) {
      allMatch = false;
      details.push(`rawInk=${rawInk} coverage=${coverage}: expected=${expected} actual=${actual}`);
    }
  }
  tests.push({ name: 'A. classifyPhysicalBucket boundary correctness', passed: allMatch, detail: allMatch ? 'all cases match' : details.join('; ') });

  // boundary: rawInk=0.9 coverage=0.4 -> fails bucket A (coverage<0.5) and fails bucket B (coverage<0.5) but qualifies for C (rawInk>=0.7 AND coverage>=0.4)
  const boundary = classifyPhysicalBucket(0.9, 0.4);
  tests.push({ name: 'A2. classifyPhysicalBucket: rawInk=0.9 coverage=0.4 falls through A/B (coverage<0.5) into bucket C', passed: boundary === 'C_ink70_cov40', detail: `actual=${boundary}` });
}

// --- B. computeRequiredComponents algebra ---
{
  const dtwFit = 0.02, progressFit = 0.58, directionFit = 0.29;
  const required = computeRequiredComponents(dtwFit, progressFit, directionFit, 0.45);
  const reconstructedD = 0.5 * required.dRequired + 0.3 * progressFit + 0.2 * directionFit;
  const reconstructedP = 0.5 * dtwFit + 0.3 * required.pRequired + 0.2 * directionFit;
  const reconstructedG = 0.5 * dtwFit + 0.3 * progressFit + 0.2 * required.gRequired;
  tests.push({
    name: 'B. computeRequiredComponents: plugging each required value back into the real 0.5D+0.3P+0.2G formula exactly reproduces the target (0.45)',
    passed: Math.abs(reconstructedD - 0.45) < 1e-9 && Math.abs(reconstructedP - 0.45) < 1e-9 && Math.abs(reconstructedG - 0.45) < 1e-9,
    detail: `reconstructedD=${reconstructedD.toFixed(6)} reconstructedP=${reconstructedP.toFixed(6)} reconstructedG=${reconstructedG.toFixed(6)}`,
  });
}

// --- C. classifyRequiredBucket ---
{
  const cases: Array<[number, string]> = [[-0.1, 'le0'], [0, 'le0'], [0.1, 'r0_25'], [0.25, 'r0_25'], [0.3, 'r25_50'], [0.6, 'r50_75'], [0.9, 'r75_100'], [1.5, 'gt1']];
  let allMatch = true;
  const details: string[] = [];
  for (const [value, expected] of cases) {
    const actual = classifyRequiredBucket(value);
    if (actual !== expected) {
      allMatch = false;
      details.push(`value=${value}: expected=${expected} actual=${actual}`);
    }
  }
  tests.push({ name: 'C. classifyRequiredBucket boundary correctness', passed: allMatch, detail: allMatch ? 'all cases match' : details.join('; ') });
}

// --- D. evaluateOrderWeightVariant ---
{
  const dtwFit = 0.1, progressFit = 0.6, directionFit = 0.3;
  const current = evaluateOrderWeightVariant(dtwFit, progressFit, directionFit, 'A_current');
  const expected = 0.5 * dtwFit + 0.3 * progressFit + 0.2 * directionFit;
  tests.push({ name: 'D1. evaluateOrderWeightVariant A_current exactly reproduces the real 0.5D+0.3P+0.2G formula', passed: Math.abs(current - expected) < 1e-9, detail: `current=${current} expected=${expected}` });

  let allSumToOne = true;
  const details: string[] = [];
  for (const [key, w] of Object.entries(ORDER_WEIGHT_VARIANTS)) {
    const sum = w.d + w.p + w.g;
    if (Math.abs(sum - 1) > 1e-9) {
      allSumToOne = false;
      details.push(`${key}: sum=${sum}`);
    }
  }
  tests.push({ name: 'D2. every ORDER_WEIGHT_VARIANTS weight triple sums to exactly 1', passed: allSumToOne, detail: allSumToOne ? 'all variants sum to 1' : details.join('; ') });
}

// --- E. medianGlobalProgress ---
{
  const target: Vec2[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const letterRoute: Vec2[] = [{ x: 40, y: 0 }, { x: 50, y: 0 }, { x: 60, y: 0 }];
  const result = medianGlobalProgress(letterRoute, target);
  tests.push({ name: 'E1. medianGlobalProgress of points at x=40,50,60 on a 0-100 target is 0.5', passed: result !== null && Math.abs(result - 0.5) < 1e-6, detail: `result=${result}` });
  const empty = medianGlobalProgress([], target);
  tests.push({ name: 'E2. medianGlobalProgress of an empty letterRoute is null', passed: empty === null, detail: `result=${empty}` });
}

// --- F. evaluateBroadOrder ---
{
  const increasing = evaluateBroadOrder([0.1, 0.3, 0.5, 0.8]);
  const reversed = evaluateBroadOrder([0.1, 0.5, 0.3, 0.8]);
  const withMissing = evaluateBroadOrder([0.1, null, 0.5, 0.8]);
  tests.push({ name: 'F1. evaluateBroadOrder: strictly increasing medians -> inOrder=true', passed: increasing.inOrder && !increasing.hasMissing, detail: JSON.stringify(increasing) });
  tests.push({ name: 'F2. evaluateBroadOrder: a reversed pair -> inOrder=false', passed: !reversed.inOrder && !reversed.hasMissing, detail: JSON.stringify(reversed) });
  tests.push({ name: 'F3. evaluateBroadOrder: a missing letter (null median) -> inOrder=false, hasMissing=true', passed: !withMissing.inOrder && withMissing.hasMissing, detail: JSON.stringify(withMissing) });
}

// --- G. read-only / production isolation ---
{
  const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
  const targetSnapshot = JSON.stringify(robzShape.points);
  extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  tests.push({
    name: 'G1. read-only: target array is byte-identical before and after the diagnostic runs',
    passed: JSON.stringify(robzShape.points) === targetSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'G2. production isolation: running the diagnostic does not change a subsequent real analyzeTargetIdentity() result',
    passed: JSON.stringify(identityBefore) === JSON.stringify(identityAfter),
    detail: `before.traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
