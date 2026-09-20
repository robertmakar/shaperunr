import { Image } from 'expo-image';
import { StyleSheet } from 'react-native';

import { useThemeColors } from '@/hooks/use-theme';

// shaperunr-runner-mark.svg's viewBox is 1024x1024 — a square mark.
const MARK_ASPECT_RATIO = 1;

type BrandMarkProps = {
  /** Rendered height in px; width follows the mark's native aspect ratio. */
  size?: number;
};

/** The ShapeRunr runner mark — a single continuous line ending in a small node. */
export function BrandMark({ size = 16 }: BrandMarkProps) {
  const colors = useThemeColors();

  return (
    <Image
      source={require('../../assets/brand/shaperunr-runner-mark.svg')}
      style={[styles.mark, { width: size * MARK_ASPECT_RATIO, height: size }]}
      contentFit="contain"
      tintColor={colors.text}
      accessibilityIgnoresInvertColors
    />
  );
}

const styles = StyleSheet.create({
  mark: {
    flexShrink: 0,
  },
});
