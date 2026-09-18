import type { Coordinate } from '@/lib/geo';
import { coordinatesToLocalMeters, offsetCoordinate } from '@/lib/shape-projection';

/**
 * Bounded candidate search.
 *
 * Old space: 8 × 45° headings, start-anchored only, geometric scale 1.0,
 * then up to 3 serial adaptive retries.
 *
 * New space: 16 × 22.5° headings, start-anchored plus a short left/right
 * shift of the drawing, geometric scale 0.9 (streets/connectors usually add
 * length), then up to 2 adaptive retries.
 *
 * Placement still begins the run at the user: the word may sit up to
 * PLACEMENT_ACROSS_METERS away, and Valhalla connects start → shape start.
 */
export const CANDIDATE_SEARCH = {
  rotationStepDegrees: 22.5,
  rotationCount: 16,
  initialScale: 0.9,
  maxAttempts: 2,
  placementAcrossMeters: 140,
  maxSpecs: 48,
} as const;

export type CandidatePlacementKind = 'start-anchored' | 'offset';

export type CandidateSpec = {
  id: string;
  rotationDegrees: number;
  scale: number;
  placement: CandidatePlacementKind;
  offsetAcrossMeters: number;
};

export function buildCandidateSpecs(): CandidateSpec[] {
  const rotations = rotationHeadings();
  const placements = placementOffsets();
  const specs: CandidateSpec[] = [];

  for (const rotationDegrees of rotations) {
    for (const offsetAcrossMeters of placements) {
      specs.push({
        id: `valhalla-${specs.length}`,
        rotationDegrees,
        scale: CANDIDATE_SEARCH.initialScale,
        placement: offsetAcrossMeters === 0 ? 'start-anchored' : 'offset',
        offsetAcrossMeters,
      });
    }
  }

  return specs.slice(0, CANDIDATE_SEARCH.maxSpecs);
}

export function rotationHeadings(): number[] {
  return Array.from(
    { length: CANDIDATE_SEARCH.rotationCount },
    (_, index) => roundDegrees(index * CANDIDATE_SEARCH.rotationStepDegrees),
  );
}

export function placementOffsets(): number[] {
  const across = CANDIDATE_SEARCH.placementAcrossMeters;
  return [0, across, -across];
}

/** Drawing-up offset, rotated into east/north meters. */
export function offsetInRotatedFrame(
  offsetAcrossMeters: number,
  rotationDegrees: number,
): { eastMeters: number; northMeters: number } {
  const radians = (rotationDegrees * Math.PI) / 180;
  return {
    eastMeters: -offsetAcrossMeters * Math.sin(radians),
    northMeters: offsetAcrossMeters * Math.cos(radians),
  };
}

export function placeShapeCoordinates(
  coordinates: Coordinate[],
  start: Coordinate,
  spec: Pick<CandidateSpec, 'rotationDegrees' | 'offsetAcrossMeters'>,
): Coordinate[] {
  const anchored = anchorToStart(coordinates, start);
  if (spec.offsetAcrossMeters === 0) {
    return anchored;
  }
  const offset = offsetInRotatedFrame(spec.offsetAcrossMeters, spec.rotationDegrees);
  return anchored.map((point) => offsetCoordinate(point, offset.eastMeters, offset.northMeters));
}

export function anchorToStart(coordinates: Coordinate[], start: Coordinate): Coordinate[] {
  const first = coordinates[0];
  if (!first) {
    return coordinates;
  }
  const local = coordinatesToLocalMeters(start, [first])[0];
  if (!local) {
    return coordinates;
  }
  return coordinates.map((point) => offsetCoordinate(point, -local.x, -local.y));
}

function roundDegrees(value: number): number {
  return Math.round(value * 10) / 10;
}
