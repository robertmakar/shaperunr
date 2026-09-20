import type { ExperimentalGenerateRoutesError, ExperimentalGenerateRoutesResponse } from '@/lib/experimental-routes-client';

/**
 * Home now starts the real search request itself, while the inline "finding"
 * presentation plays on the Home screen — see index.tsx. By the time it
 * navigates to /experimental-routes, the response already exists, so this
 * carries it across the navigation boundary instead of making Results issue
 * a second, redundant request for the same search.
 *
 * A plain module-level value (mirrors experimental-route-session.ts) is
 * enough: it only needs to survive the single push, matched by word +
 * distance and consumed at most once.
 */
export type ExperimentalRoutesPrefetchResult =
  | { ok: true; data: ExperimentalGenerateRoutesResponse }
  | ExperimentalGenerateRoutesError;

export type ExperimentalRoutesPrefetch = {
  word: string;
  targetDistanceMeters: number;
  result: ExperimentalRoutesPrefetchResult;
};

let prefetch: ExperimentalRoutesPrefetch | null = null;

export function setExperimentalRoutesPrefetch(next: ExperimentalRoutesPrefetch): void {
  prefetch = next;
}

/** Reads and clears a matching prefetch in one step; returns null (and leaves any non-matching entry alone) otherwise. */
export function takeExperimentalRoutesPrefetch(
  word: string,
  targetDistanceMeters: number,
): ExperimentalRoutesPrefetchResult | null {
  if (!prefetch || prefetch.word !== word || prefetch.targetDistanceMeters !== targetDistanceMeters) {
    return null;
  }
  const result = prefetch.result;
  prefetch = null;
  return result;
}
