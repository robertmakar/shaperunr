import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';

import {
  decomposeContinuity,
  extractLetterRouteSpansAtSampleCount,
  decomposeContinuityAtSampleCount,
} from './continuity-decomposition-diagnostic';
import { extractLetterRouteSpans, computeTransitionRecord, type TransitionRecord } from './inter-letter-continuity-diagnostic';
import { evaluateContinuity, SHADOW_CONTINUITY_DEFAULTS } from './shadow-product-gate-evaluator';
import { buildWalkableWordShape } from '../generation/walkable-target';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

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
const SCALE = 500;
function scalePoints(points: readonly Vec2[]): Vec2[] {
  return points.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
}

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });
const target = scalePoints(robzShape.points);
const perfectRoute = densify(target, 6);

function realContinuity(route: Vec2[], target2: Vec2[]) {
  const { spans, sampledRoute } = extractLetterRouteSpans('ROBZ', target2, route, 'smooth');
  const transitions: TransitionRecord[] = [];
  for (let i = 0; i + 1 < spans.length; i += 1) transitions.push(computeTransitionRecord(spans[i]!, spans[i + 1]!, sampledRoute));
  return evaluateContinuity(transitions, SHADOW_CONTINUITY_DEFAULTS.maxInterLetterRouteRatio);
}

check('decomposeContinuity exactly reproduces the real evaluateContinuity() result — parity, not reimplementation', () => {
  const real = realContinuity(perfectRoute, target);
  const decomposed = decomposeContinuity('ROBZ', target, perfectRoute, 'smooth');
  assert.equal(decomposed.continuityValid, real.continuityValid);
  assert.equal(decomposed.hasDisconnectedTransition, real.hasDisconnectedTransition);
  assert.equal(decomposed.worstRatio, real.maxRatio);
});

check('every break is scoped "between-letters" — continuity has no within-letter concept by construction', () => {
  const decomposed = decomposeContinuity('ROBZ', target, perfectRoute, 'smooth');
  for (const b of decomposed.breaks) assert.equal(b.scope, 'between-letters');
});

function arcConnector(from: Vec2, to: Vec2, arcHeight: number, factor: number): Vec2[] {
  const up = { x: from.x, y: from.y + arcHeight };
  const over = { x: to.x, y: to.y + arcHeight };
  return densify([from, up, over, to], factor);
}
function buildConnectedRoute(letterPointArrays: readonly (readonly Vec2[])[], arcHeight = 200): Vec2[] {
  let route: Vec2[] = [];
  letterPointArrays.forEach((points, i) => {
    const dense = densify(points, 6);
    if (i === 0) {
      route = [...dense];
      return;
    }
    const prevEnd = route[route.length - 1]!;
    const nextStart = dense[0]!;
    route.push(...arcConnector(prevEnd, nextStart, arcHeight, 8).slice(1, -1));
    route.push(...dense);
  });
  return route;
}

check('a disconnected letter (never reached, via a sky-bridge connector that skips it cleanly) produces a genuine-disconnection break and continuityValid=false', () => {
  const [r, , b, z] = robzShape.letters.map((l) => scalePoints(l.points));
  // Route only covers R, B, Z — O never reached at all (arced connector stays well clear of O's territory, same validated construction as the adversarial battery's Scenario B) — should genuinely disconnect the R->O and O->B transitions.
  const route = buildConnectedRoute([r!, b!, z!]);
  const decomposed = decomposeContinuity('ROBZ', target, route, 'smooth');
  assert.equal(decomposed.continuityValid, false);
  assert.ok(decomposed.breaks.some((b2) => b2.kind === 'genuine-disconnection'));
});

check('extractLetterRouteSpansAtSampleCount at sampleCount=80 exactly matches the real extractLetterRouteSpans (parity at the production sample count)', () => {
  const real = extractLetterRouteSpans('ROBZ', target, perfectRoute, 'smooth');
  const mirrored = extractLetterRouteSpansAtSampleCount('ROBZ', target, perfectRoute, 'smooth', 80);
  assert.equal(mirrored.sampledRoute.length, real.sampledRoute.length);
  assert.deepEqual(mirrored.spans.map((s) => s.letter), real.spans.map((s) => s.letter));
  assert.deepEqual(mirrored.spans.map((s) => s.assignedOriginalIndices.length), real.spans.map((s) => s.assignedOriginalIndices.length));
});

check('decomposeContinuityAtSampleCount(80) matches decomposeContinuity()\'s continuityValid/worstRatio exactly', () => {
  const full = decomposeContinuity('ROBZ', target, perfectRoute, 'smooth');
  const atCount = decomposeContinuityAtSampleCount('ROBZ', target, perfectRoute, 'smooth', 80);
  assert.equal(atCount.continuityValid, full.continuityValid);
  assert.equal(atCount.worstRatio, full.worstRatio);
});

check('read-only: route/target arrays are byte-identical before and after decomposeContinuity', () => {
  const routeCopy = perfectRoute.map((p) => ({ ...p }));
  const targetCopy = target.map((p) => ({ ...p }));
  decomposeContinuity('ROBZ', targetCopy, routeCopy, 'smooth');
  assert.deepEqual(routeCopy, perfectRoute);
  assert.deepEqual(targetCopy, target);
});

console.log(`continuity-decomposition-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
