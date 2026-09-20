import { createElement, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';
import { boundingBoxForCoordinates, osmEmbedBbox, type Coordinate } from '@/lib/geo';

export type MapOverlay = {
  coordinates: Coordinate[];
  strokeColor: string;
  strokeWidth?: number;
  lineDashPattern?: number[];
};

export type RouteMapProps = {
  coordinates: Coordinate[];
  start?: Coordinate;
  end?: Coordinate;
  userLocation?: Coordinate;
  showUserLocation?: boolean;
  followUser?: boolean;
  overlays?: MapOverlay[];
  height?: number;
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function RouteMap({
  coordinates,
  start,
  end,
  overlays = [],
  height,
  interactive = false,
  style,
}: RouteMapProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const startPoint = start ?? coordinates[0];
  const endPoint = end ?? coordinates[coordinates.length - 1];
  const overlay = useMemo(() => {
    const allCoordinates = [...coordinates, ...overlays.flatMap((item) => item.coordinates)];
    return {
      bbox: osmEmbedBbox(allCoordinates),
      drawing: projectOverlay(allCoordinates, coordinates, overlays, startPoint, endPoint, colors),
    };
  }, [colors, coordinates, endPoint, overlays, startPoint]);

  return (
    <View style={[styles.frame, height ? { height } : styles.flex, style]}>
      {createElement('iframe', {
        src: `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(overlay.bbox)}&layer=mapnik`,
        style: {
          width: '100%',
          height: '100%',
          border: 0,
          pointerEvents: interactive ? 'auto' : 'none',
        },
        title: 'Route map',
      })}
      {createElement(
        'svg',
        {
          viewBox: '0 0 100 100',
          preserveAspectRatio: 'none',
          style: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          },
        },
        overlay.drawing.lines.map((line) =>
          line.points.length > 0
            ? createElement('polyline', {
                key: line.key,
                points: line.points,
                fill: 'none',
                stroke: line.color,
                strokeWidth: line.width,
                strokeDasharray: line.dash,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              })
            : null,
        ),
        overlay.drawing.start
          ? createElement('circle', {
              cx: overlay.drawing.start.x,
              cy: overlay.drawing.start.y,
              r: 1.8,
              fill: colors.accent,
              stroke: colors.inverse,
              strokeWidth: 0.6,
            })
          : null,
        overlay.drawing.end
          ? createElement('circle', {
              cx: overlay.drawing.end.x,
              cy: overlay.drawing.end.y,
              r: 1.8,
              fill: colors.inverse,
              stroke: colors.accent,
              strokeWidth: 0.7,
            })
          : null,
      )}
    </View>
  );
}

function projectOverlay(
  allCoordinates: Coordinate[],
  coordinates: Coordinate[],
  overlays: MapOverlay[],
  start: Coordinate | undefined,
  end: Coordinate | undefined,
  colors: ThemeColors,
): {
  lines: Array<{ key: string; points: string; color: string; width: number; dash?: string }>;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
} {
  const box = boundingBoxForCoordinates(allCoordinates);

  if (!box) {
    return { lines: [] };
  }

  const latPad = Math.max((box.maxLatitude - box.minLatitude) * 0.35, 0.003);
  const lonPad = Math.max((box.maxLongitude - box.minLongitude) * 0.35, 0.003);
  const minLat = box.minLatitude - latPad;
  const maxLat = box.maxLatitude + latPad;
  const minLon = box.minLongitude - lonPad;
  const maxLon = box.maxLongitude + lonPad;

  const project = (point: Coordinate) => ({
    x: ((point.longitude - minLon) / (maxLon - minLon)) * 100,
    y: (1 - (point.latitude - minLat) / (maxLat - minLat)) * 100,
  });

  const toPoints = (line: Coordinate[]) =>
    line
      .map((point) => {
        const projected = project(point);
        return `${projected.x},${projected.y}`;
      })
      .join(' ');

  return {
    lines: [
      ...overlays.map((item, index) => ({
        key: `overlay-${index}`,
        points: toPoints(item.coordinates),
        color: item.strokeColor,
        width: (item.strokeWidth ?? 3) / 2,
        dash: item.lineDashPattern ? item.lineDashPattern.join(' ') : undefined,
      })),
      {
        key: 'main',
        points: toPoints(coordinates),
        color: colors.accent,
        width: 2.2,
      },
    ],
    start: start ? project(start) : undefined,
    end: end ? project(end) : undefined,
  };
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    frame: {
      overflow: 'hidden',
      backgroundColor: colors.surface,
      position: 'relative',
    },
    flex: {
      flex: 1,
    },
  });
}
