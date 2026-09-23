/**
 * DEVELOPMENT ONLY. Tests for the shadow DTW-tolerance evaluator.
 *
 * A. Exact parity at 1.0x — the shadow evaluator must reproduce production.
 * B. Monotonic tolerance behavior — a larger multiplier can only raise (or
 *    leave unchanged) dtwFit/order for the same inputs, never lower them.
 * C. Production isolation — computing shadow values does not mutate/affect
 *    a subsequent real analyzeTargetIdentity() call.
 */
import { scoreOrderedPath } from '@/lib/shape-order';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  computeShadowCandidateSummaries,
  computeShadowOrderAtMultiplier,
  DTW_TOLERANCE_MULTIPLIERS,
} from './dtw-tolerance-diagnostic';
import { extractLetterOrderInputs } from './order-score-diagnostic';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

// --- A. exact parity at 1.0x ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const mismatches: string[] = [];
  inputs.forEach((input, index) => {
    const shadowAt1 = computeShadowOrderAtMultiplier(input, 1);
    const prod = identity.letters[index]!;
    if (Math.abs(shadowAt1.order - prod.order) > 1e-9) {
      mismatches.push(`${input.letter} order: shadow=${shadowAt1.order} prod=${prod.order}`);
    }
  });
  tests.push({
    name: 'A. exact parity: shadow order at multiplier=1.0 exactly matches production order for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- A. exact parity of all OrderMatchDetails sub-fields, not just order ---
{
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  // Independently recompute what production's letterIdentities would get by calling scoreOrderedPath directly with the unscaled orderDistanceScale.
  let allFieldsMatch = true;
  const details: string[] = [];
  for (const input of inputs) {
    const direct = scoreOrderedPath(input.letterRoute, input.sampledTarget, input.letterTarget, {
      orderDistanceScale: input.orderDistanceScale,
      coverageThreshold: input.coverageThreshold,
    });
    const shadow = computeShadowOrderAtMultiplier(input, 1);
    const fields: Array<keyof typeof direct> = ['dtwFit', 'warpFit', 'monotonicFit', 'jumpFit', 'revisitFit', 'directionFit', 'progressFit', 'order'];
    for (const field of fields) {
      if (Math.abs((direct[field] as number) - (shadow[field] as number)) > 1e-9) {
        allFieldsMatch = false;
        details.push(`${input.letter}.${field}: direct=${direct[field]} shadow=${shadow[field]}`);
      }
    }
  }
  tests.push({
    name: 'A. exact parity: EVERY OrderMatchDetails field (dtwFit, progressFit, directionFit, etc.) matches a direct real scoreOrderedPath call at multiplier=1.0',
    passed: allFieldsMatch,
    detail: allFieldsMatch ? 'all fields match for all 4 letters' : details.join('; '),
  });
}

// --- A. pass/fail behavior parity: shadow candidate summary at 1.0x matches production traversesMostOfWord exactly ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  const letterShadowOrders = DTW_TOLERANCE_MULTIPLIERS.map((multiplier) => inputs.map((input) => computeShadowOrderAtMultiplier(input, multiplier).order));
  const summaries = computeShadowCandidateSummaries(identity, letterShadowOrders);
  const at1 = summaries.find((s) => s.multiplier === 1)!;
  tests.push({
    name: 'A. exact parity: shadow candidate summary at multiplier=1.0 matches production exactly (completedLetterCount, lettersVisitedInOrder, wordTraversal)',
    passed:
      at1.shadowCompletedLetterCount === identity.lettersVisited &&
      at1.shadowLettersVisitedInOrder === identity.lettersVisitedInOrder &&
      at1.shadowWordTraversal === identity.traversesMostOfWord,
    detail: `shadow: completed=${at1.shadowCompletedLetterCount} inOrder=${at1.shadowLettersVisitedInOrder} traversal=${at1.shadowWordTraversal} | prod: visited=${identity.lettersVisited} inOrder=${identity.lettersVisitedInOrder} traversal=${identity.traversesMostOfWord}`,
  });
}

// --- B. monotonic tolerance behavior ---
function assertMonotonicNonDecreasing(word: string, route: readonly { x: number; y: number }[], target: readonly { x: number; y: number }[]) {
  const inputs = extractLetterOrderInputs(word, target, route, 'smooth');
  for (const input of inputs) {
    const values = DTW_TOLERANCE_MULTIPLIERS.map((multiplier) => computeShadowOrderAtMultiplier(input, multiplier));
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1]!;
      const current = values[index]!;
      if (current.dtwFit + 1e-9 < previous.dtwFit) {
        return { ok: false, detail: `${word}.${input.letter}: dtwFit decreased from multiplier=${DTW_TOLERANCE_MULTIPLIERS[index - 1]} (${previous.dtwFit.toFixed(3)}) to multiplier=${DTW_TOLERANCE_MULTIPLIERS[index]} (${current.dtwFit.toFixed(3)})` };
      }
      if (current.order + 1e-9 < previous.order) {
        return { ok: false, detail: `${word}.${input.letter}: order decreased from multiplier=${DTW_TOLERANCE_MULTIPLIERS[index - 1]} (${previous.order.toFixed(3)}) to multiplier=${DTW_TOLERANCE_MULTIPLIERS[index]} (${current.order.toFixed(3)})` };
      }
    }
  }
  return { ok: true, detail: 'dtwFit and order are non-decreasing across all multipliers for every letter' };
}
{
  const robzResult = assertMonotonicNonDecreasing('ROBZ', robzShape.points, robzShape.points);
  tests.push({ name: 'B. monotonic tolerance (ROBZ, full walk): dtwFit and order never decrease as the multiplier increases', passed: robzResult.ok, detail: robzResult.detail });
}
{
  // A deliberately imperfect route (every letter walked backwards) so dtwFit isn't already saturated at 1.0 for every multiplier.
  const reversedRoute = robzShape.letters.flatMap((letter) => [...letter.points].reverse());
  const reversedResult = assertMonotonicNonDecreasing('ROBZ', reversedRoute, robzShape.points);
  tests.push({ name: 'B. monotonic tolerance (ROBZ, every letter reversed): dtwFit and order never decrease as the multiplier increases', passed: reversedResult.ok, detail: reversedResult.detail });
}
{
  const oShape = buildWalkableWordShape('O', { letterVariant: 'smooth' });
  const detourRoute = oShape.points.map((point, index) => (index % 3 === 0 ? { x: point.x + 0.05, y: point.y - 0.05 } : point));
  const oResult = assertMonotonicNonDecreasing('O', detourRoute, oShape.points);
  tests.push({ name: 'B. monotonic tolerance (O, mild detour): dtwFit and order never decrease as the multiplier increases', passed: oResult.ok, detail: oResult.detail });
}

// --- B. at 0.5x, dtwFit should be <= dtwFit at 1.0x for a route with nonzero DTW distance (tolerance actually does something) ---
{
  const reversedRoute = robzShape.letters.flatMap((letter) => [...letter.points].reverse());
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, reversedRoute, 'smooth');
  const bInput = inputs[2]!; // 'B'
  const at05 = computeShadowOrderAtMultiplier(bInput, 0.5);
  const at1 = computeShadowOrderAtMultiplier(bInput, 1);
  const at3 = computeShadowOrderAtMultiplier(bInput, 3);
  tests.push({
    name: 'B. increasing the multiplier from 0.5x to 3x strictly increases (or preserves) dtwFit for a representative imperfect letter',
    passed: at05.dtwFit <= at1.dtwFit + 1e-9 && at1.dtwFit <= at3.dtwFit + 1e-9,
    detail: `dtwFit: 0.5x=${at05.dtwFit.toFixed(3)} 1x=${at1.dtwFit.toFixed(3)} 3x=${at3.dtwFit.toFixed(3)}`,
  });
}

// --- C. production isolation: computing shadow values does not mutate a subsequent real analyzeTargetIdentity() call ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, robzShape.points, 'smooth');
  for (const input of inputs) {
    for (const multiplier of DTW_TOLERANCE_MULTIPLIERS) {
      computeShadowOrderAtMultiplier(input, multiplier);
    }
  }
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'C. production isolation: running the full shadow multiplier sweep does not change a subsequent real analyzeTargetIdentity() result (no shared mutable state)',
    passed:
      identityBefore.spanOccupancy === identityAfter.spanOccupancy &&
      identityBefore.targetSpan === identityAfter.targetSpan &&
      identityBefore.wordTraversal === identityAfter.wordTraversal &&
      identityBefore.traversesMostOfWord === identityAfter.traversesMostOfWord &&
      identityBefore.letters.every((letter, index) => letter.order === identityAfter.letters[index]!.order),
    detail: `before traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
