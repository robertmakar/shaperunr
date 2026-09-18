import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, typography } from '@/constants/theme';

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  showArrow?: boolean;
};

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  showArrow = true,
}: PrimaryButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}>
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        {showArrow ? <Text style={styles.arrow}>→</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 62,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  disabled: {
    opacity: 0.3,
  },
  pressed: {
    opacity: 0.82,
  },
  label: {
    ...typography.cta,
    color: colors.inverse,
  },
  arrow: {
    color: colors.inverse,
    fontSize: 22,
    marginTop: -2,
  },
});
