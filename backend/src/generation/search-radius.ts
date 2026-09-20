/**
 * DEVELOPMENT ONLY. Scale experimental graph collection and placement
 * translation with targetDistance.
 *
 * Proven L at 2000–2500 m used neighborhood 2400 m and placement 800 m.
 * Those floors are kept. Larger targets grow linearly from the 2500 m
 * reference, capped at 2× so 6–8 km cannot explode locate volume.
 */
import { NEIGHBORHOOD_COLLECT } from './graph-shape-router';
import { STREET_FIT_SEARCH } from './street-fit-search';

export const SEARCH_SCALE = {
  referenceTargetMeters: 2500,
  maxScale: 2,
} as const;

export function scaleForTargetDistance(targetDistanceMeters: number): number {
  const target =
    Number.isFinite(targetDistanceMeters) && targetDistanceMeters > 0
      ? targetDistanceMeters
      : SEARCH_SCALE.referenceTargetMeters;
  return Math.min(SEARCH_SCALE.maxScale, Math.max(1, target / SEARCH_SCALE.referenceTargetMeters));
}

/** Neighborhood locate radius around the user. Floor = current 2400 m. */
export function getSearchRadiusForTargetDistance(targetDistanceMeters: number): number {
  return Math.round(NEIGHBORHOOD_COLLECT.radiusMeters * scaleForTargetDistance(targetDistanceMeters));
}

/** Placement translation radius. Floor = current 800 m. Scales with neighborhood. */
export function getPlacementRadiusForTargetDistance(targetDistanceMeters: number): number {
  return Math.round(STREET_FIT_SEARCH.translationRadiusMeters * scaleForTargetDistance(targetDistanceMeters));
}

/** Same 0 / half / full ring pattern as STREET_FIT_SEARCH.translationRingsMeters. */
export function getPlacementRingsForTargetDistance(targetDistanceMeters: number): number[] {
  const radius = getPlacementRadiusForTargetDistance(targetDistanceMeters);
  const mid = Math.round(radius / 2);
  return [0, mid, radius];
}
