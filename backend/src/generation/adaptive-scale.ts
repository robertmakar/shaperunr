export const ADAPTIVE_SCALE = {
  min: 0.5,
  max: 3.5,
  maxAttempts: 3,
  minStep: 0.05,
  minRatio: 0.55,
  maxRatio: 2.35,
} as const;

export function nextCandidateScale(input: {
  currentScale: number;
  targetDistanceMeters: number;
  actualDistanceMeters: number;
  minScale?: number;
  maxScale?: number;
}): { scale: number; shouldRetry: boolean; ratio: number } {
  const minScale = input.minScale ?? ADAPTIVE_SCALE.min;
  const maxScale = input.maxScale ?? ADAPTIVE_SCALE.max;
  const actual = input.actualDistanceMeters;

  if (!Number.isFinite(actual) || actual <= 1) {
    return { scale: input.currentScale, shouldRetry: false, ratio: Number.NaN };
  }

  const ratio = input.targetDistanceMeters / actual;
  const damped = clamp(ratio, ADAPTIVE_SCALE.minRatio, ADAPTIVE_SCALE.maxRatio);
  const scale = clamp(input.currentScale * damped, minScale, maxScale);
  const shouldRetry = Math.abs(scale - input.currentScale) >= ADAPTIVE_SCALE.minStep;

  return { scale, shouldRetry, ratio };
}

export function scaleFitsSearchWindow(
  baseWidthMeters: number,
  baseHeightMeters: number,
  scale: number,
): boolean {
  const extent = Math.max(baseWidthMeters, baseHeightMeters) * scale;
  return extent >= 80 && extent <= 12_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
