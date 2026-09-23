/**
 * DEVELOPMENT ONLY. Tests for the shadow product-gate evaluator
 * (shadow-product-gate-evaluator.ts).
 *
 * A. Shared-condition parity: for shapeScore/coverage/order/backtrack/
 *    largestGap/lengthRatio/connected, Shadow A and Shadow B produce the
 *    EXACT SAME reasons as the real, unmodified
 *    experimentalProductRejectionReasons() on the same real GeneratedRoute
 *    (excluding wordTraversal/targetSpan, which are the intentional
 *    substitutions).
 * B. Shadow A keeps the real targetSpan check (EXPERIMENTAL_PRODUCT.minTargetSpan, unchanged).
 * C. Shadow B never emits 'targetSpan' as a reason (dropped by design).
 * D. Single-letter words: neither shadow gate adds physicalWordTraversal/continuity reasons.
 * E. evaluateContinuity: disconnected transition -> invalid; ratio above
 *    threshold -> invalid; ratio at/below threshold -> valid.
 * F. Multi-letter word with physical PASS + continuity PASS -> neither
 *    shadow-specific reason appears; with physical FAIL -> reason appears
 *    in both A and B; with continuity FAIL only -> reason appears in B only.
 * G. read-only / no production mutation (EXPERIMENTAL_PRODUCT constants object identity unchanged).
 */
import type { Coordinate } from '@/lib/geo';
import { offsetCoordinate } from '@/lib/shape-projection';
import { scorePolylines, shapeScoreBreakdown } from '../scoring/shape-match';
import { analyzeTargetIdentity } from '../generation/target-identity';
import { experimentalProductRejectionReasons, EXPERIMENTAL_PRODUCT } from '../generation/experimental-product';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { evaluateShadowGateA, evaluateShadowGateB, evaluateContinuity } from './shadow-product-gate-evaluator';
import type { PhysicalWordTraversalResult } from './physical-word-traversal-evaluator';
import type { TransitionRecord } from './inter-letter-continuity-diagnostic';
import type { GeneratedRoute } from '../types';
import type { Vec2 } from '@/lib/geometry';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

function densify(points: readonly Vec2[], factor: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let s = 0; s < factor; s += 1) {
      const t = s / factor;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}
const goodRoute = densify(robzShape.points, 3);

function buildRealRoute(target: Vec2[], route: Vec2[], word: string): GeneratedRoute {
  const anchor: Coordinate = { latitude: 30.0, longitude: 31.0 };
  const toGeo = (p: Vec2) => offsetCoordinate(anchor, p.x, p.y);
  const shapeGeo = route.map(toGeo);
  const targetGeo = target.map(toGeo);
  const scored = scorePolylines(route, target);
  const identity = analyzeTargetIdentity({ route, target, word, geometryVariant: 'smooth' });
  return {
    id: 'test-route',
    source: 'valhalla',
    developmentOnly: true,
    coordinates: shapeGeo,
    targetCoordinates: targetGeo,
    shapeCoordinates: shapeGeo,
    connectorCoordinates: [],
    distanceMeters: 0,
    shapeScore: scored.score,
    coverage: scored.coverage,
    scoreBreakdown: shapeScoreBreakdown(scored),
    metadata: {
      rotationDegrees: 0,
      scale: 1,
      placement: 'start-anchored',
      offsetAcrossMeters: 0,
      method: 'graph_constrained',
      connectedFromStart: true,
      connected: true,
      backtrackRatio: scored.details.backtrackRatio,
      score: scored,
      startSnapDistanceMeters: 0,
      lengthError: 0,
      distanceError: 0,
      detourRatio: 0,
      largestGap: identity.largestTargetGap,
      geometryVariant: 'smooth',
    },
  };
}

const fakePassingPhysical: PhysicalWordTraversalResult = {
  wordTraversalPhysical: true,
  allLettersCovered: true,
  lettersInBroadOrder: true,
  letters: [],
  thresholds: { ink: 0.6, coverage: 0.4, sequenceTolerance: 0.02 },
  coveredLetterCount: 4,
  letterCount: 4,
  coverageFraction: 1,
  firstMissingLetter: null,
  firstOrderViolation: null,
};
const fakeFailingPhysical: PhysicalWordTraversalResult = { ...fakePassingPhysical, wordTraversalPhysical: false, allLettersCovered: false, firstMissingLetter: 'Z' };

const directTransitions: TransitionRecord[] = [
  { fromLetter: 'R', toLetter: 'O', fromLastProgress: 0.1, toFirstProgress: 0.2, routeDistance: 1, straightLineDistance: 1, routeToStraightRatio: 1, targetProgressGap: 0.1, numberOfRoutePointsBetween: 0 },
  { fromLetter: 'O', toLetter: 'B', fromLastProgress: 0.3, toFirstProgress: 0.4, routeDistance: 2, straightLineDistance: 2, routeToStraightRatio: 1, targetProgressGap: 0.1, numberOfRoutePointsBetween: 0 },
];
const disconnectedTransitions: TransitionRecord[] = [
  { fromLetter: 'R', toLetter: 'O', fromLastProgress: null, toFirstProgress: 0.2, routeDistance: null, straightLineDistance: null, routeToStraightRatio: null, targetProgressGap: null, numberOfRoutePointsBetween: null },
];
const extremeRatioTransitions: TransitionRecord[] = [
  { fromLetter: 'R', toLetter: 'O', fromLastProgress: 0.1, toFirstProgress: 0.2, routeDistance: 100, straightLineDistance: 1, routeToStraightRatio: 100, targetProgressGap: 0.1, numberOfRoutePointsBetween: 10 },
];

function baseInput(overrides: Partial<Parameters<typeof evaluateShadowGateA>[0]> = {}): Parameters<typeof evaluateShadowGateA>[0] {
  return {
    word: 'ROBZ',
    connected: true,
    shapeScore: 0.9,
    coverage: 0.9,
    order: 0.9,
    backtrack: 0.05,
    largestGap: 0.05,
    targetSpan: 0.9,
    lengthRatio: 0.9,
    currentWordTraversal: false,
    physical: fakePassingPhysical,
    transitions: directTransitions,
    ...overrides,
  };
}

// --- A. shared-condition parity against the real production function ---
{
  const realRoute = buildRealRoute(robzShape.points, goodRoute, 'ROBZ');
  const realReasons = new Set(experimentalProductRejectionReasons(realRoute, { word: 'ROBZ' }));
  const scored = scorePolylines(goodRoute, robzShape.points);
  const identity = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  const input = baseInput({
    connected: true,
    shapeScore: scored.score,
    coverage: scored.coverage,
    order: scored.breakdown.order,
    backtrack: scored.details.backtrackRatio,
    largestGap: identity.largestTargetGap,
    targetSpan: identity.targetSpan,
    lengthRatio: identity.lengthRatioProjected,
  });
  const shadowA = evaluateShadowGateA(input);
  const shadowB = evaluateShadowGateB(input);
  const sharedRules = ['connected', 'shapeScore', 'coverage', 'order', 'backtrack', 'largestGap', 'lengthRatio'] as const;
  let allMatchA = true;
  let allMatchB = true;
  const details: string[] = [];
  for (const rule of sharedRules) {
    const realHas = realReasons.has(rule);
    const aHas = shadowA.reasons.includes(rule);
    const bHas = shadowB.reasons.includes(rule);
    if (realHas !== aHas) { allMatchA = false; details.push(`A ${rule}: real=${realHas} shadow=${aHas}`); }
    if (realHas !== bHas) { allMatchB = false; details.push(`B ${rule}: real=${realHas} shadow=${bHas}`); }
  }
  tests.push({ name: 'A1. Shadow Gate A: every shared condition exactly matches the real experimentalProductRejectionReasons()', passed: allMatchA, detail: allMatchA ? 'all shared rules match' : details.join('; ') });
  tests.push({ name: 'A2. Shadow Gate B: every shared condition exactly matches the real experimentalProductRejectionReasons()', passed: allMatchB, detail: allMatchB ? 'all shared rules match' : details.join('; ') });
}

// --- B. Shadow A keeps the real targetSpan check ---
{
  const belowMinSpan = baseInput({ targetSpan: EXPERIMENTAL_PRODUCT.minTargetSpan - 0.01 });
  const aboveMinSpan = baseInput({ targetSpan: EXPERIMENTAL_PRODUCT.minTargetSpan + 0.01 });
  const resultBelow = evaluateShadowGateA(belowMinSpan);
  const resultAbove = evaluateShadowGateA(aboveMinSpan);
  tests.push({
    name: 'B. Shadow Gate A rejects on targetSpan below EXPERIMENTAL_PRODUCT.minTargetSpan (unchanged), accepts above it',
    passed: resultBelow.reasons.includes('targetSpan') && !resultAbove.reasons.includes('targetSpan'),
    detail: `below.reasons=${JSON.stringify(resultBelow.reasons)} above.reasons=${JSON.stringify(resultAbove.reasons)}`,
  });
}

// --- C. Shadow B never emits targetSpan ---
{
  const belowMinSpan = baseInput({ targetSpan: 0.01 });
  const result = evaluateShadowGateB(belowMinSpan);
  tests.push({
    name: 'C. Shadow Gate B never includes "targetSpan" as a reason, even at targetSpan=0.01 (dropped by design)',
    passed: !result.reasons.includes('targetSpan' as never),
    detail: `reasons=${JSON.stringify(result.reasons)}`,
  });
}

// --- D. single-letter words: no physicalWordTraversal/continuity reasons ---
{
  const singleLetterFailingPhysical = baseInput({ word: 'L', physical: fakeFailingPhysical, transitions: disconnectedTransitions });
  const resultA = evaluateShadowGateA(singleLetterFailingPhysical);
  const resultB = evaluateShadowGateB(singleLetterFailingPhysical);
  tests.push({
    name: 'D. single-letter word (L): neither shadow gate adds physicalWordTraversal or continuity reasons, even with a "failing" physical/continuity input (matches production skipping wordTraversal for single letters)',
    passed: !resultA.reasons.includes('physicalWordTraversal') && !resultB.reasons.includes('physicalWordTraversal') && !resultB.reasons.includes('continuity'),
    detail: `A.reasons=${JSON.stringify(resultA.reasons)} B.reasons=${JSON.stringify(resultB.reasons)}`,
  });
}

// --- E. evaluateContinuity ---
{
  const direct = evaluateContinuity(directTransitions, 15);
  const disconnected = evaluateContinuity(disconnectedTransitions, 15);
  const extreme = evaluateContinuity(extremeRatioTransitions, 15);
  const extremeButLenient = evaluateContinuity(extremeRatioTransitions, 150);
  tests.push({ name: 'E1. evaluateContinuity: all-direct transitions (ratio=1) are valid', passed: direct.continuityValid, detail: JSON.stringify(direct) });
  tests.push({ name: 'E2. evaluateContinuity: a disconnected (null) transition is invalid', passed: !disconnected.continuityValid && disconnected.hasDisconnectedTransition, detail: JSON.stringify(disconnected) });
  tests.push({ name: 'E3. evaluateContinuity: a ratio (100) above the threshold (15) is invalid', passed: !extreme.continuityValid && extreme.maxRatio === 100, detail: JSON.stringify(extreme) });
  tests.push({ name: 'E4. evaluateContinuity: the SAME ratio (100) is valid under a more lenient threshold (150)', passed: extremeButLenient.continuityValid, detail: JSON.stringify(extremeButLenient) });
}

// --- F. multi-letter physical/continuity interplay ---
{
  const physicalFail = evaluateShadowGateB(baseInput({ physical: fakeFailingPhysical }));
  const physicalFailA = evaluateShadowGateA(baseInput({ physical: fakeFailingPhysical }));
  const continuityFailOnly = evaluateShadowGateB(baseInput({ transitions: extremeRatioTransitions }));
  const continuityFailOnlyA = evaluateShadowGateA(baseInput({ transitions: extremeRatioTransitions }));
  tests.push({ name: 'F1. physical FAIL -> physicalWordTraversal reason appears in Shadow B', passed: physicalFail.reasons.includes('physicalWordTraversal'), detail: JSON.stringify(physicalFail.reasons) });
  tests.push({ name: 'F2. physical FAIL -> physicalWordTraversal reason appears in Shadow A too', passed: physicalFailA.reasons.includes('physicalWordTraversal'), detail: JSON.stringify(physicalFailA.reasons) });
  tests.push({ name: 'F3. continuity FAIL only (physical passes) -> "continuity" reason appears in Shadow B, "physicalWordTraversal" does not', passed: continuityFailOnly.reasons.includes('continuity') && !continuityFailOnly.reasons.includes('physicalWordTraversal'), detail: JSON.stringify(continuityFailOnly.reasons) });
  tests.push({ name: 'F4. Shadow A has no concept of continuity at all — its reasons never include "continuity" regardless of transitions', passed: !continuityFailOnlyA.reasons.includes('continuity' as never), detail: JSON.stringify(continuityFailOnlyA.reasons) });
}

// --- G. no production mutation ---
{
  const before = JSON.stringify(EXPERIMENTAL_PRODUCT);
  evaluateShadowGateA(baseInput());
  evaluateShadowGateB(baseInput());
  tests.push({
    name: 'G. EXPERIMENTAL_PRODUCT constants are byte-identical before and after running both shadow gates',
    passed: JSON.stringify(EXPERIMENTAL_PRODUCT) === before,
    detail: 'no mutation detected',
  });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
