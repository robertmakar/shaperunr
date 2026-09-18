import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing, typography } from '@/constants/theme';

export const DISTANCES = [2, 4, 6, 8] as const;

type DistanceSelectorProps = {
  value: number;
  onChange: (distance: number) => void;
};

export function DistanceSelector({ value, onChange }: DistanceSelectorProps) {
  return (
    <View style={styles.row}>
      {DISTANCES.map((distance) => {
        const selected = distance === value;

        return (
          <Pressable
            key={distance}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(distance)}
            style={({ pressed }) => [
              styles.chip,
              selected && styles.chipSelected,
              pressed && !selected && styles.pressed,
            ]}>
            <Text style={[styles.label, selected && styles.labelSelected]}>{distance} km</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.two,
  },
  chip: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 11,
  },
  chipSelected: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  pressed: {
    opacity: 0.7,
  },
  label: {
    ...typography.meta,
    color: '#555555',
  },
  labelSelected: {
    color: colors.inverse,
  },
});
