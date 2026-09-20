import { useMemo } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { radii, spacing, typography, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  showArrow?: boolean;
  variant?: 'primary' | 'secondary';
  size?: 'large' | 'compact' | 'small';
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
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        size === 'compact' && styles.compact,
        size === 'small' && styles.small,
        secondary && styles.secondary,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}>
      <View style={styles.row}>
        <Text
          style={[
            styles.label,
            size === 'small' && styles.smallLabel,
            secondary && styles.secondaryLabel,
          ]}>
          {label}
        </Text>
        {showArrow ? (
          <Text
            style={[
              styles.arrow,
              size === 'small' && styles.smallArrow,
              secondary && styles.secondaryLabel,
            ]}>
            →
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
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
    /** For subordinate actions (e.g. an alternative route's own CTA) — still a real, comfortably tappable button, just visually quieter than the hero's. */
    small: {
      height: 44,
      paddingHorizontal: spacing.lg,
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
    smallLabel: {
      fontSize: 12,
    },
    secondaryLabel: {
      color: colors.text,
    },
    arrow: {
      color: colors.inverse,
      fontSize: 22,
      marginTop: -2,
    },
    smallArrow: {
      fontSize: 17,
    },
  });
}
