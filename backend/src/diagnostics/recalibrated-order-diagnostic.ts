/**
 * DEVELOPMENT ONLY. Recalibrated whole-route order under semantic
 * guardrails — diagnostic only, never called from the live route-
 * generation/scoring/gate path, never wired into experimental-product.ts.
 *
 * Per Step 9 of this task, scoreOrderedPath() itself is NOT modified —
 * this file is a thin diagnostic WRAPPER that reuses:
 *   - computeWholeRouteOrder() (whole-route-order-diagnostic.ts, itself a
 *     parity-verified reproduction of the real scorePolylines() call) to
 *     obtain the REAL dtwFit and directionFit — neither of which depends
 *     on jumpAllow, so they are reused UNCHANGED for every model;
 *   - progressConsistencyWithJumpModel / combineProgressFit / combineOrder
 *     (jump-allowance-calibration-diagnostic.ts, unmodified) to recompute
 *     ONLY the jumpAllow-dependent part (monotonicFit/jumpFit/revisitFit
 *     -> progressFit) under each calibration model, then recombine into a
 *     full recalibrated `order` via the SAME 0.5/0.3/0.2 weights
 *     scoreOrderedPath() itself uses.
 *
 * Models reused EXACTLY from the prior task, not redesigned:
 *   A_current         — jumpAllow = 4/(n-1), the real production value.
 *   B_perLetterCount  — Model B: max(current, 1/numberOfLetters).
 *   C_targetGeometry  — Model C: max(current, maxConnectorGap + 0.05).
 * Two intermediate points are added (Step 1's "small number of
 * intermediate calibration points"), each simply LERPing the per-step
 * allowance halfway between A and B, or A and C — no new formula, just
 * interpolation of the already-existing derived values:
 *   B_half — allowance halfway between A_current and B_perLetterCount.
 *   C_half — allowance halfway between A_current and C_targetGeometry.
 */
import type { LetterShapeVariant } from '@/lib/letter-shapes';
import type { Vec2 } from '@/lib/geometry';

import { computeWholeRouteOrder, extractWholeRouteProgressSequence, WHOLE_ROUTE_ORDER_SAMPLE_COUNT } from './whole-route-order-diagnostic';
import { extractBoundariesFor, progressConsistencyWithJumpModel, combineProgressFit, combineOrder } from './jump-allowance-calibration-diagnostic';
import type { LetterBoundary } from './multi-letter-trace';

export const CURRENT_JUMP_ALLOW = 4 / (WHOLE_ROUTE_ORDER_SAMPLE_COUNT - 1);

export type RecalibrationModelKey = 'A_current' | 'B_perLetterCount' | 'C_targetGeometry' | 'B_half' | 'C_half';

export const RECALIBRATION_MODEL_KEYS: RecalibrationModelKey[] = ['A_current', 'B_perLetterCount', 'C_targetGeometry', 'B_half', 'C_half'];

export type RecalibratedOrderResult = {
  dtwFit: number;
  directionFit: number;
  monotonicFit: number;
  jumpFit: number;
  revisitFit: number;
  progressFit: number;
  order: number;
  skipAmount: number;
  /** The constant per-step allowance this model actually used for this candidate — informational, not itself part of order. */
  allowance: number;
};

/** EXACT reproduction of jump-allowance-calibration-diagnostic.ts's Model B derivation — duplicated here (not imported, since the source only returns final results, not the intermediate allowance value) purely so B_half/C_half can interpolate it. Not a redesign. */
export function perLetterCountAllowanceFor(numberOfLetters: number): number {
  const raw = numberOfLetters > 1 ? 1 / numberOfLetters : CURRENT_JUMP_ALLOW;
  return Math.max(CURRENT_JUMP_ALLOW, raw);
}

/** EXACT reproduction of jump-allowance-calibration-diagnostic.ts's Model C derivation — see perLetterCountAllowanceFor's comment; same rationale. */
export function targetGeometryAllowanceFor(boundaries: readonly LetterBoundary[]): number {
  let maxConnectorGap = 0;
  for (let i = 0; i + 1 < boundaries.length; i += 1) {
    const gap = boundaries[i + 1]!.projectedStartProgress - boundaries[i]!.projectedEndProgress;
    maxConnectorGap = Math.max(maxConnectorGap, gap);
  }
  return Math.max(CURRENT_JUMP_ALLOW, maxConnectorGap + 0.05);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function computeRecalibratedOrderModels(
  route: readonly Vec2[],
  target: readonly Vec2[],
  word: string,
  geometryVariant: LetterShapeVariant,
): Record<RecalibrationModelKey, RecalibratedOrderResult> {
  const real = computeWholeRouteOrder(route, target);
  const boundaries = extractBoundariesFor(word, geometryVariant);
  const samples = extractWholeRouteProgressSequence(route, target);
  const progress = samples.map((s) => s.progress);

  const bAllowance = perLetterCountAllowanceFor(boundaries.length);
  const cAllowance = targetGeometryAllowanceFor(boundaries);

  const allowanceByModel: Record<RecalibrationModelKey, number> = {
    A_current: CURRENT_JUMP_ALLOW,
    B_perLetterCount: bAllowance,
    C_targetGeometry: cAllowance,
    B_half: lerp(CURRENT_JUMP_ALLOW, bAllowance, 0.5),
    C_half: lerp(CURRENT_JUMP_ALLOW, cAllowance, 0.5),
  };

  const out = {} as Record<RecalibrationModelKey, RecalibratedOrderResult>;
  for (const key of RECALIBRATION_MODEL_KEYS) {
    const allowance = allowanceByModel[key];
    const pc = progressConsistencyWithJumpModel(progress, () => allowance);
    const progressFit = combineProgressFit(pc.monotonicFit, pc.jumpFit, pc.revisitFit);
    const order = combineOrder(real.dtwFit, progressFit, real.directionFit);
    out[key] = {
      dtwFit: real.dtwFit,
      directionFit: real.directionFit,
      monotonicFit: pc.monotonicFit,
      jumpFit: pc.jumpFit,
      revisitFit: pc.revisitFit,
      progressFit,
      order,
      skipAmount: pc.skipAmount,
      allowance,
    };
  }
  return out;
}
