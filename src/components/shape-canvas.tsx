import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@/constants/theme';
import { boundingBox2, type Vec2 } from '@/lib/geometry';

export type ShapeCanvasPolyline = {
  points: Vec2[];
  color?: string;
  width?: number;
};

type ShapeCanvasProps = {
  polylines: ShapeCanvasPolyline[];
  height?: number;
  style?: StyleProp<ViewStyle>;
};

export function ShapeCanvas({ polylines, height = 160, style }: ShapeCanvasProps) {
  const [width, setWidth] = useState(0);
  const allPoints = polylines.flatMap((line) => line.points);
  const bounds = boundingBox2(allPoints);
  const segments = bounds && width > 0 ? flattenSegments(polylines, bounds, width, height) : [];

  function handleLayout(event: LayoutChangeEvent) {
    setWidth(event.nativeEvent.layout.width);
  }

  return (
    <View style={[styles.frame, { height }, style]} onLayout={handleLayout}>
      {segments.map((segment) => (
        <View
          key={segment.key}
          style={[
            styles.segment,
            {
              width: segment.length,
              left: segment.left,
              top: segment.top,
              backgroundColor: segment.color,
              height: segment.strokeWidth,
              transform: [{ rotate: `${segment.angle}deg` }],
            },
          ]}
        />
      ))}
    </View>
  );
}

function flattenSegments(
  polylines: ShapeCanvasPolyline[],
  bounds: NonNullable<ReturnType<typeof boundingBox2>>,
  width: number,
  height: number,
) {
  const pad = 12;
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;
  const scale = Math.min(usableW / (bounds.width || 1), usableH / (bounds.height || 1));
  const ox = pad + (usableW - bounds.width * scale) / 2;
  const oy = pad + (usableH - bounds.height * scale) / 2;

  const project = (point: Vec2) => ({
    x: ox + (point.x - bounds.minX) * scale,
    y: oy + (bounds.maxY - point.y) * scale,
  });

  const segments: Array<{
    key: string;
    left: number;
    top: number;
    length: number;
    angle: number;
    color: string;
    strokeWidth: number;
  }> = [];

  polylines.forEach((line, lineIndex) => {
    for (let index = 1; index < line.points.length; index += 1) {
      const startPoint = line.points[index - 1];
      const endPoint = line.points[index];
      if (!startPoint || !endPoint) {
        continue;
      }
      const start = project(startPoint);
      const end = project(endPoint);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.4) {
        continue;
      }
      const strokeWidth = line.width ?? 2;
      segments.push({
        key: `${lineIndex}-${index}`,
        left: (start.x + end.x) / 2 - length / 2,
        top: (start.y + end.y) / 2 - strokeWidth / 2,
        length,
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        color: line.color ?? colors.text,
        strokeWidth,
      });
    }
  });

  return segments;
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: colors.surface,
    overflow: 'hidden',
    position: 'relative',
  },
  segment: {
    position: 'absolute',
    borderRadius: 1,
  },
});
