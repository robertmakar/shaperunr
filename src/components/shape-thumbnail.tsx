import { useMemo } from 'react';

import { ShapeCanvas } from '@/components/shape-canvas';
import { useThemeColors } from '@/hooks/use-theme';
import type { Coordinate } from '@/lib/geo';
import { coordinatesToLocalMeters } from '@/lib/shape-projection';

type ShapeThumbnailProps = {
  coordinates: Coordinate[];
  size?: number;
};

/**
 * A quiet preview of a saved run's actual target shape, drawn from its real
 * stored geometry rather than any letter-glyph approximation. Reuses
 * ShapeCanvas's existing fit-into-box/center/draw-as-segments logic (already
 * proven by the debug shape screens) — this just projects the shape's
 * geographic coordinates into local meters first, using the shape's own
 * first point as the origin, since only its relative geometry (not its
 * absolute position) matters for a thumbnail.
 */
export function ShapeThumbnail({ coordinates, size = 60 }: ShapeThumbnailProps) {
  const colors = useThemeColors();
  const points = useMemo(() => {
    const origin = coordinates[0];
    return origin ? coordinatesToLocalMeters(origin, coordinates) : [];
  }, [coordinates]);

  return (
    <ShapeCanvas
      polylines={[{ points, color: colors.accent, width: 2 }]}
      height={size}
      style={{ width: size, backgroundColor: 'transparent' }}
    />
  );
}
