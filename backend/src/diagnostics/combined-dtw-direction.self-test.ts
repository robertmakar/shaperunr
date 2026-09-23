/**
 * DEVELOPMENT ONLY. Tests for the final combined DTW+direction shadow
 * experiment.
 *
 * A. production parity at DTW=1x, direction=90deg.
 * B. DTW shadow parity: 2x affects only dtwFit and downstream order.
 * C. direction shadow parity: 135deg affects only directionFit and downstream order.
 * D. combined arithmetic: orderD follows 0.5*dtwFit2x + 0.3*progressFit + 0.2*directionFit135.
 * E. production isolation.
 */
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  classifyRemainingFailure,
  computeCombinedConditionResults,
  computeLetterCombinedRecord,
} from './combined-dtw-direction';
import { extractLetterOrderInputs } from './order-score-diagnostic';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

function buildRecords(route: readonly { x: number; y: number }[], target: readonly { x: number; y: number }[] = robzShape.points) {
  const identity = analyzeTargetIdentity({ route, target, word: 'ROBZ', geometryVariant: 'smooth' });
  const inputs = extractLetterOrderInputs('ROBZ', target, route, 'smooth');
  const letters = inputs.map((input, index) => computeLetterCombinedRecord(input, identity.letters[index]!.coverage, 0.8));
  const conditions = computeCombinedConditionResults(identity, letters);
  return { identity, letters, conditions };
}

// --- A. production parity ---
{
  const { identity, letters } = buildRecords(robzShape.points);
  const mismatches: string[] = [];
  letters.forEach((letter, index) => {
    const prod = identity.letters[index]!;
    if (Math.abs(letter.orderA - prod.order) > 1e-9) {
      mismatches.push(`${letter.letter}: orderA=${letter.orderA} prod=${prod.order}`);
    }
    if (letter.meaningfullyVisited.A_production !== prod.meaningfullyVisited) {
      mismatches.push(`${letter.letter}: meaningfullyVisited(A)=${letter.meaningfullyVisited.A_production} prod=${prod.meaningfullyVisited}`);
    }
  });
  tests.push({
    name: 'A. production parity: orderA and meaningfullyVisited(A) exactly match production for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
  const { conditions } = buildRecords(robzShape.points);
  const a = conditions.find((c) => c.condition === 'A_production')!;
  tests.push({
    name: 'A. production parity: condition A_production candidate summary exactly matches production traversesMostOfWord/lettersVisited/lettersVisitedInOrder',
    passed: a.completedLetterCount === identity.lettersVisited && a.lettersVisitedInOrder === identity.lettersVisitedInOrder && a.wordTraversal === identity.traversesMostOfWord,
    detail: `shadow: completed=${a.completedLetterCount} inOrder=${a.lettersVisitedInOrder} traversal=${a.wordTraversal} | prod: visited=${identity.lettersVisited} inOrder=${identity.lettersVisitedInOrder} traversal=${identity.traversesMostOfWord}`,
  });
}

// --- B. DTW shadow parity: 2x affects only dtwFit/orderB, not progressFit or directionFit90 ---
{
  const { letters } = buildRecords(robzShape.points);
  const mismatches: string[] = [];
  for (const letter of letters) {
    // orderB must use the SAME progressFit and directionFit90 as production (orderA) — only dtwFit differs.
    const expectedOrderB = 0.5 * letter.dtwFit2x + 0.3 * letter.progressFit + 0.2 * letter.directionFit90;
    if (Math.abs(expectedOrderB - letter.orderB) > 1e-9) {
      mismatches.push(`${letter.letter}: expected=${expectedOrderB} actual=${letter.orderB}`);
    }
  }
  tests.push({
    name: 'B. DTW shadow parity: orderB = 0.5*dtwFit2x + 0.3*progressFit(production) + 0.2*directionFit90(production) exactly, for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- C. direction shadow parity: 135deg affects only directionFit/orderC, not dtwFit or progressFit ---
{
  const { letters } = buildRecords(robzShape.points);
  const mismatches: string[] = [];
  for (const letter of letters) {
    const expectedOrderC = 0.5 * letter.dtwFit1x + 0.3 * letter.progressFit + 0.2 * letter.directionFit135;
    if (Math.abs(expectedOrderC - letter.orderC) > 1e-9) {
      mismatches.push(`${letter.letter}: expected=${expectedOrderC} actual=${letter.orderC}`);
    }
  }
  tests.push({
    name: 'C. direction shadow parity: orderC = 0.5*dtwFit1x(production) + 0.3*progressFit(production) + 0.2*directionFit135 exactly, for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- D. combined arithmetic ---
{
  const { letters } = buildRecords(robzShape.points);
  const mismatches: string[] = [];
  for (const letter of letters) {
    const expectedOrderD = 0.5 * letter.dtwFit2x + 0.3 * letter.progressFit + 0.2 * letter.directionFit135;
    if (Math.abs(expectedOrderD - letter.orderD) > 1e-9) {
      mismatches.push(`${letter.letter}: expected=${expectedOrderD} actual=${letter.orderD}`);
    }
  }
  tests.push({
    name: 'D. combined arithmetic: orderD = 0.5*dtwFit2x + 0.3*progressFit + 0.2*directionFit135 exactly, for every letter',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : mismatches.join('; '),
  });
}

// --- monotonicity sanity: orderD >= orderA always (both shadow inputs only ever help, never hurt, since dtwFit/directionFit are individually non-decreasing under relaxation per prior self-tests) ---
{
  const { letters } = buildRecords(robzShape.points);
  const failing = letters.filter((letter) => letter.orderD + 1e-9 < letter.orderA);
  tests.push({
    name: 'sanity: orderD is never lower than orderA (relaxing DTW+direction together never hurts a letter\'s order, consistent with each shadow individually being monotonic)',
    passed: failing.length === 0,
    detail: failing.length === 0 ? 'orderD >= orderA for all 4 letters' : failing.map((l) => `${l.letter}: A=${l.orderA} D=${l.orderD}`).join('; '),
  });
}

// --- classifyRemainingFailure: a letter with insufficient route data classifies as never_reached ---
{
  const inputs = extractLetterOrderInputs('ROBZ', robzShape.points, [], 'smooth');
  if (inputs.length > 0) {
    const record = computeLetterCombinedRecord(inputs[0]!, 0.5, 0);
    const classification = classifyRemainingFailure(record);
    tests.push({
      name: 'classifyRemainingFailure: a letter with zero route data classifies as never_reached',
      passed: classification === 'never_reached',
      detail: `classification=${classification}`,
    });
  }
}

// --- classifyRemainingFailure: a fully passing letter classifies as passing ---
{
  const { letters } = buildRecords(robzShape.points);
  const passingLetter = letters.find((l) => l.meaningfullyVisited.D_combined);
  if (passingLetter) {
    tests.push({
      name: 'classifyRemainingFailure: a letter passing under D classifies as passing',
      passed: classifyRemainingFailure(passingLetter) === 'passing',
      detail: `classification=${classifyRemainingFailure(passingLetter)}`,
    });
  }
}

// --- E. production isolation ---
{
  const identityBefore = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  buildRecords(robzShape.points);
  const identityAfter = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'E. production isolation: running the full combined DTW+direction evaluation does not change a subsequent real analyzeTargetIdentity() result',
    passed:
      identityBefore.spanOccupancy === identityAfter.spanOccupancy &&
      identityBefore.targetSpan === identityAfter.targetSpan &&
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
