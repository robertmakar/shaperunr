import assert from 'node:assert/strict';

import type { Vec2 } from '@/lib/geometry';

import { computeWholeRouteOrder } from './whole-route-order-diagnostic';
import { computeRecalibratedOrderModels, CURRENT_JUMP_ALLOW, perLetterCountAllowanceFor, targetGeometryAllowanceFor } from './recalibrated-order-diagnostic';
import { buildWalkableWordShape } from '../generation/walkable-target';
import { extractBoundariesFor } from './jump-allowance-calibration-diagnostic';

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

const detourRoute = perfectRoute.map((p, i) => ({ x: p.x + Math.sin(i * 0.7) * 15, y: p.y + Math.cos(i * 0.5) * 15 }));
const reversedRoute = [...perfectRoute].reverse();

check('A_current EXACTLY reproduces computeWholeRouteOrder() (the real scorePolylines() reproduction) — parity, not an approximation', () => {
  const real = computeWholeRouteOrder(perfectRoute, target);
  const models = computeRecalibratedOrderModels(perfectRoute, target, 'ROBZ', 'smooth');
  assert.equal(models.A_current.order, real.order);
  assert.equal(models.A_current.dtwFit, real.dtwFit);
  assert.equal(models.A_current.directionFit, real.directionFit);
  assert.equal(models.A_current.monotonicFit, real.monotonicFit);
  assert.equal(models.A_current.jumpFit, real.jumpFit);
  assert.equal(models.A_current.revisitFit, real.revisitFit);
});

check('A_current on the detour route also exactly reproduces computeWholeRouteOrder()', () => {
  const real = computeWholeRouteOrder(detourRoute, target);
  const models = computeRecalibratedOrderModels(detourRoute, target, 'ROBZ', 'smooth');
  assert.equal(models.A_current.order, real.order);
});

check('B_perLetterCount and C_targetGeometry never produce LOWER jumpFit than A_current for the same route (relaxation only widens allowance, matching the prior task\'s proven Model C property)', () => {
  const models = computeRecalibratedOrderModels(perfectRoute, target, 'ROBZ', 'smooth');
  assert.ok(models.B_perLetterCount.jumpFit >= models.A_current.jumpFit);
  assert.ok(models.C_targetGeometry.jumpFit >= models.A_current.jumpFit);
});

check('B_half/C_half allowances sit strictly between A_current and their full-relaxation counterparts (when the full model actually relaxes beyond current)', () => {
  const boundaries = extractBoundariesFor('ROBZ', 'smooth');
  const bFull = perLetterCountAllowanceFor(boundaries.length);
  const cFull = targetGeometryAllowanceFor(boundaries);
  const models = computeRecalibratedOrderModels(perfectRoute, target, 'ROBZ', 'smooth');
  if (bFull > CURRENT_JUMP_ALLOW) {
    assert.ok(models.B_half.allowance > CURRENT_JUMP_ALLOW && models.B_half.allowance < bFull);
  }
  if (cFull > CURRENT_JUMP_ALLOW) {
    assert.ok(models.C_half.allowance > CURRENT_JUMP_ALLOW && models.C_half.allowance < cFull);
  }
});

check('B_half jumpFit is >= A_current and <= B_perLetterCount (monotonic interpolation, since allowance only widens the tolerance band)', () => {
  const models = computeRecalibratedOrderModels(perfectRoute, target, 'ROBZ', 'smooth');
  assert.ok(models.B_half.jumpFit >= models.A_current.jumpFit - 1e-9);
  assert.ok(models.B_half.jumpFit <= models.B_perLetterCount.jumpFit + 1e-9);
});

check('a genuinely reversed route is NOT rescued by any relaxation model — order stays low across every model because monotonicFit/dtwFit/directionFit are untouched by jumpAllow', () => {
  const models = computeRecalibratedOrderModels(reversedRoute, target, 'ROBZ', 'smooth');
  for (const key of Object.keys(models) as (keyof typeof models)[]) {
    assert.ok(models[key].order < 0.3, `${key} order=${models[key].order} should stay low for a reversed route`);
  }
});

check('read-only: route/target arrays are byte-identical before and after computeRecalibratedOrderModels', () => {
  const routeCopy = perfectRoute.map((p) => ({ ...p }));
  const targetCopy = target.map((p) => ({ ...p }));
  computeRecalibratedOrderModels(routeCopy, targetCopy, 'ROBZ', 'smooth');
  assert.deepEqual(routeCopy, perfectRoute);
  assert.deepEqual(targetCopy, target);
});

console.log(`recalibrated-order-diagnostic.self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
