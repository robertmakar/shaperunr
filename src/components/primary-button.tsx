import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, radii, spacing, typography } from '@/constants/theme';

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  showArrow?: boolean;
  variant?: 'primary' | 'secondary';
  size?: 'large' | 'compact';
  style?: StyleProp<ViewStyle>;
};

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  showArrow = true,
  variant = 'primary',
  size = 'large',
  style,
}: PrimaryButtonProps) {
  const secondary = variant === 'secondary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        size === 'compact' && styles.compact,
        secondary && styles.secondary,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}>
      <View style={styles.row}>
        <Text style={[styles.label, secondary && styles.secondaryLabel]}>
          {label}
        </Text>
        {showArrow ? (
          <Text style={[styles.arrow, secondary && styles.secondaryLabel]}>
            →
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 62,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compact: {
    height: 52,
  },
  secondary: {
    backgroundColor: colors.surface,
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
  secondaryLabel: {
    color: colors.text,
  },
  arrow: {
    color: colors.inverse,
    fontSize: 22,
    marginTop: -2,
  },
});
