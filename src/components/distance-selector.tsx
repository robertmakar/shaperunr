import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing, typography } from '@/constants/theme';
import { useDistanceUnit } from '@/hooks/use-distance-unit';
import { convertKmToUnit, distanceUnitLabel, distanceUnitName } from '@/lib/format';

/**
 * The four selectable route distances, always in km — this is what's sent
 * to route generation and must stay unchanged regardless of the display
 * unit. Only the chip label converts for display below.
 */
export const DISTANCES = [2, 4, 6, 8] as const;

type DistanceSelectorProps = {
  value: number;
  onChange: (distance: number) => void;
};

export function DistanceSelector({ value, onChange }: DistanceSelectorProps) {
  const [unit] = useDistanceUnit();

  return (
    <View style={styles.row}>
      {DISTANCES.map((distance) => {
        const selected = distance === value;
        const unitLabel = distanceUnitLabel(unit).toUpperCase();
        const displayValue =
          unit === 'mi' ? convertKmToUnit(distance, unit).toFixed(1) : String(distance);

        return (
          <Pressable
            key={distance}
            accessibilityRole="button"
            accessibilityLabel={`${displayValue} ${distanceUnitName(unit).toLowerCase()}`}
            accessibilityState={{ selected }}
            onPress={() => onChange(distance)}
            style={({ pressed }) => [
              styles.chip,
              selected && styles.chipSelected,
              pressed && !selected && styles.pressed,
            ]}>
            <Text style={[styles.label, selected && styles.labelSelected]}>
              {displayValue} {unitLabel}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  chip: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
  },
  chipSelected: {
    backgroundColor: colors.accent,
  },
  pressed: {
    backgroundColor: colors.surfaceAlt,
  },
  label: {
    ...typography.meta,
    color: colors.textSecondary,
  },
  labelSelected: {
    color: colors.inverse,
  },
});
