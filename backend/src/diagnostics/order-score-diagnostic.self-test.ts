/**
 * DEVELOPMENT ONLY. Tests for the order-score diagnostic decomposition.
 * The most important test in this file is the parity check: this module's
 * own `forward.order` for a letter must exactly equal what production's
 * analyzeTargetIdentity() computes for that same letter, proving the
 * mirrored input-selection logic is faithful and the real scoreOrderedPath()
 * is doing all the actual scoring (nothing reimplemented/approximated).
 */
import type { Vec2 } from '@/lib/geometry';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { buildWalkableWordShape } from '../generation/walkable-target';
import {
  classifyDirection,
  computeLetterOrderDecomposition,
  evaluateShadowCoverageAndCoherence,
  extractLetterOrderInputs,
} from './order-score-diagnostic';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

function decompose(route: readonly Vec2[], target: readonly Vec2[] = robzShape.points) {
  const inputs = extractLetterOrderInputs('ROBZ', target, route, 'smooth');
  return inputs.map((input) => computeLetterOrderDecomposition(input));
}

// --- Critical parity check: this module's forward.order must exactly match production's real per-letter order ---
{
  const identity = analyzeTargetIdentity({ route: robzShape.points, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const decompositions = decompose(robzShape.points);
  const mismatches = identity.letters.map((letterIdentity, index) => {
    const decomposition = decompositions[index];
    return { letter: letterIdentity.letter, prod: letterIdentity.order, diag: decomposition?.forward.order ?? NaN };
  }).filter((entry) => Math.abs(entry.prod - entry.diag) > 1e-9);
  tests.push({
    name: 'PARITY: this module\'s forward.order exactly matches TargetIdentity.letters[i].order for every letter (mirrored input-selection is faithful, real scoreOrderedPath does all the scoring)',
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? 'all 4 letters match exactly' : JSON.stringify(mismatches),
  });
}

// --- 1. a simple monotonic stroke (letter I, walked forward) ---
{
  const iShape = buildWalkableWordShape('I', { letterVariant: 'smooth' });
  const [decomposition] = decompose(iShape.points, iShape.points);
  tests.push({
    name: '1. simple monotonic stroke (I) walked forward: direction=same, high forward order',
    passed: decomposition!.direction === 'same' && decomposition!.forward.order >= 0.7,
    detail: `direction=${decomposition!.direction} forward.order=${decomposition!.forward.order.toFixed(3)} monotonicFit=${decomposition!.forward.monotonicFit.toFixed(3)}`,
  });
}

// --- 2. the same stroke traversed in reverse ---
{
  const iShape = buildWalkableWordShape('I', { letterVariant: 'smooth' });
  const reversed = [...iShape.points].reverse();
  const [decomposition] = decompose(reversed, iShape.points);
  tests.push({
    name: '2. same stroke (I) traversed in reverse: direction=reverse, forward order is depressed relative to reverse order',
    passed: decomposition!.direction === 'reverse' && decomposition!.forward.order < decomposition!.reverse.order,
    detail: `direction=${decomposition!.direction} forward.order=${decomposition!.forward.order.toFixed(3)} reverse.order=${decomposition!.reverse.order.toFixed(3)}`,
  });
  tests.push({
    name: '2. same stroke reversed: shadowBidirectionalOrder recovers a high score even though forward order alone is low',
    passed: decomposition!.shadowBidirectionalOrder >= 0.7 && decomposition!.shadowBidirectionalOrder > decomposition!.forward.order,
    detail: `shadowBidirectionalOrder=${decomposition!.shadowBidirectionalOrder.toFixed(3)} forward.order=${decomposition!.forward.order.toFixed(3)}`,
  });
}

// --- 3. a route with a reversal (goes forward then backtracks partway) ---
{
  const iShape = buildWalkableWordShape('I', { letterVariant: 'smooth' });
  const points = iShape.points;
  const mid = Math.floor(points.length / 2);
  const withReversal: Vec2[] = [...points, ...[...points].slice(0, mid + 1).reverse()];
  const [decomposition] = decompose(withReversal, points);
  tests.push({
    name: '3. route with a reversal (forward pass then partial backtrack): direction is not cleanly "same" (monotonicFit pulled down from a clean forward walk)',
    passed: decomposition!.direction !== 'reverse' && decomposition!.forward.monotonicFit < 0.99,
    detail: `direction=${decomposition!.direction} monotonicFit=${decomposition!.forward.monotonicFit.toFixed(3)} revisitFit=${decomposition!.forward.revisitFit.toFixed(3)}`,
  });
}

// --- 4. a route that jumps randomly around the target ---
{
  const iShape = buildWalkableWordShape('I', { letterVariant: 'smooth' });
  const points = iShape.points;
  const shuffled: Vec2[] = [points[0]!, points[points.length - 1]!, points[Math.floor(points.length / 2)]!, points[1]!, points[points.length - 2]!, points[0]!];
  const [decomposition] = decompose(shuffled, points);
  tests.push({
    name: '4. route that jumps randomly around the target: shadowCoherentProgressFit stays well below a clean monotonic walk\'s score in either direction (bidirectional does not simply pass everything)',
    passed: decomposition!.shadowCoherentProgressFit < 0.85,
    detail: `shadowCoherentProgressFit=${decomposition!.shadowCoherentProgressFit.toFixed(3)} forward.progressFit=${decomposition!.forward.progressFit.toFixed(3)} reverse.progressFit=${decomposition!.reverse.progressFit.toFixed(3)}`,
  });
}

// --- 5. a closed/loop-like target (O), walked in its canonical direction ---
{
  const oShape = buildWalkableWordShape('O', { letterVariant: 'smooth' });
  const [decomposition] = decompose(oShape.points, oShape.points);
  tests.push({
    name: '5. closed loop (O) walked in canonical direction: direction=same, high forward order',
    passed: decomposition!.direction === 'same' && decomposition!.forward.order >= 0.6,
    detail: `direction=${decomposition!.direction} forward.order=${decomposition!.forward.order.toFixed(3)}`,
  });
}

// --- 6. a route that covers the SAME loop in reverse rotational direction ---
{
  const oShape = buildWalkableWordShape('O', { letterVariant: 'smooth' });
  const reversedLoop = [...oShape.points].reverse();
  const [decomposition] = decompose(reversedLoop, oShape.points);
  tests.push({
    name: '6. closed loop (O) covered in reverse rotational direction: direction=reverse, forward order depressed even though the SAME ink is physically covered',
    passed: decomposition!.direction === 'reverse' && decomposition!.forward.order < decomposition!.shadowBidirectionalOrder,
    detail: `direction=${decomposition!.direction} forward.order=${decomposition!.forward.order.toFixed(3)} shadowBidirectionalOrder=${decomposition!.shadowBidirectionalOrder.toFixed(3)}`,
  });
}

// --- 7. a route with high physical coverage but poor projected order ---
{
  // Every letter's own points, reversed — same construction as the previous
  // task's shadow-traversal self-test: physically visits every point (full
  // coverage) but in the opposite direction from the target's own stroke.
  const reversedRoute: Vec2[] = robzShape.letters.flatMap((letter) => [...letter.points].reverse());
  const decompositions = decompose(reversedRoute);
  const lowOrderDespiteFullRange = decompositions.filter((decomposition) => {
    const range = Math.max(...decomposition.routeProgressSequence, 0) - Math.min(...decomposition.routeProgressSequence, 1);
    return decomposition.forward.order < 0.5 && Math.abs(range) > 0.3;
  });
  tests.push({
    name: '7. every letter walked backwards (route spans the full letter but in reverse): forward order is low despite the route\'s progress sequence spanning most of the letter',
    passed: lowOrderDespiteFullRange.length > 0,
    detail: decompositions.map((d) => `${d.letter} order=${d.forward.order.toFixed(2)} seq=[${d.routeProgressSequence.map((p) => p.toFixed(2)).join(',')}]`).join(' | '),
  });
}

// --- 8. a route with poor coverage but locally coherent progression ---
{
  const iShape = buildWalkableWordShape('I', { letterVariant: 'smooth' });
  const points = iShape.points;
  const firstHalf = points.slice(0, Math.max(2, Math.ceil(points.length / 2)));
  const [decomposition] = decompose(firstHalf, points);
  tests.push({
    name: '8. only the first half of a letter walked, but strictly forward: direction=same and monotonicFit stays high despite incomplete coverage',
    passed: decomposition!.direction === 'same' && decomposition!.forward.monotonicFit >= 0.8,
    detail: `direction=${decomposition!.direction} monotonicFit=${decomposition!.forward.monotonicFit.toFixed(3)} progressRange=[${Math.min(...decomposition!.routeProgressSequence).toFixed(2)},${Math.max(...decomposition!.routeProgressSequence).toFixed(2)}]`,
  });
}

// --- classifyDirection boundary behavior ---
{
  tests.push({
    name: 'classifyDirection: >=0.7 is "same", <=0.3 is "reverse", between is "mixed", <2 points is "insufficient"',
    passed:
      classifyDirection(0.9, 5) === 'same' &&
      classifyDirection(0.1, 5) === 'reverse' &&
      classifyDirection(0.5, 5) === 'mixed' &&
      classifyDirection(0.9, 1) === 'insufficient',
    detail: `${classifyDirection(0.9, 5)} ${classifyDirection(0.1, 5)} ${classifyDirection(0.5, 5)} ${classifyDirection(0.9, 1)}`,
  });
}

// --- evaluateShadowCoverageAndCoherence is a simple AND of its two diagnostic inputs ---
{
  tests.push({
    name: 'evaluateShadowCoverageAndCoherence: true only when BOTH raw ink occupancy and coherent progress clear their thresholds',
    passed:
      evaluateShadowCoverageAndCoherence(0.8, 0.8) === true &&
      evaluateShadowCoverageAndCoherence(0.2, 0.8) === false &&
      evaluateShadowCoverageAndCoherence(0.8, 0.1) === false,
    detail: `high/high=${evaluateShadowCoverageAndCoherence(0.8, 0.8)} low/high=${evaluateShadowCoverageAndCoherence(0.2, 0.8)} high/low=${evaluateShadowCoverageAndCoherence(0.8, 0.1)}`,
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
