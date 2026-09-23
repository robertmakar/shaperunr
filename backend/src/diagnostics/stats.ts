/**
 * DEVELOPMENT ONLY. Reusable numeric-distribution summary for diagnostics.
 * No route-generation behavior depends on this — read-only aggregation.
 */

export type NumberDistribution = {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
};

const EMPTY_DISTRIBUTION: NumberDistribution = {
  count: 0,
  min: null,
  max: null,
  mean: null,
  median: null,
  p25: null,
  p75: null,
};

/** Ignores non-finite values (NaN/±Infinity) rather than letting them poison min/max/mean. */
export function summarizeNumbers(values: readonly number[]): NumberDistribution {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { ...EMPTY_DISTRIBUTION };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    mean: sum / sorted.length,
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
  };
}

/** Linear-interpolation percentile over an already-sorted array (the common "R-7" method). */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 1) {
    return sorted[0] as number;
  }
  const index = fraction * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] as number;
  if (lower === upper) {
    return lowerValue;
  }
  const upperValue = sorted[upper] as number;
  const weight = index - lower;
  return lowerValue * (1 - weight) + upperValue * weight;
}
