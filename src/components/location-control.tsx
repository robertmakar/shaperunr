import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';

export type LocationControlStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

type LocationControlProps = {
  status: LocationControlStatus;
  /** Human-readable place name (e.g. "Park Slope, NY") — never lat/long. Null while resolving or if unavailable. */
  label: string | null;
  onPress: () => void;
};

export function LocationControl({ status, label, onPress }: LocationControlProps) {
  const disabled = status === 'loading';
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>STARTING NEAR</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel(status)}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.control,
          disabled && styles.disabled,
          pressed && !disabled && styles.pressed,
        ]}>
        <LocationMark styles={styles} />
        <View style={styles.copy}>
          <Text style={styles.primary}>{primaryLabel(status)}</Text>
          {status === 'ready' && label ? (
            <Text style={styles.secondary}>{label}</Text>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

function LocationMark({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.mark} pointerEvents="none" accessibilityElementsHidden>
      <View style={styles.markHead} />
      <View style={styles.markHole} />
      <View style={styles.markPoint} />
    </View>
  );
}

function primaryLabel(status: LocationControlStatus): string {
  switch (status) {
    case 'loading':
      return 'Finding you...';
    case 'ready':
      return 'Current location';
    case 'unavailable':
      return 'Location unavailable';
    default:
      return 'Use my location';
  }
}

function accessibilityLabel(status: LocationControlStatus): string {
  switch (status) {
    case 'loading':
      return 'Finding your location';
    case 'ready':
      return 'Refresh current location';
    case 'unavailable':
      return 'Location unavailable. Try again';
    default:
      return 'Use my location';
  }
}

function createStyles(colors: ThemeColors) {
  const MARK_COLOR = colors.textSecondary;

  return StyleSheet.create({
    wrap: {
      marginTop: spacing.lg,
      alignItems: 'center',
    },
    label: {
      ...typography.kicker,
      color: colors.textSecondary,
      marginBottom: spacing.sm,
      textAlign: 'center',
    },
    control: {
      minHeight: 44,
      minWidth: 44,
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'center',
      gap: spacing.sm,
      backgroundColor: 'transparent',
    },
    mark: {
      width: 14,
      height: 20,
      alignItems: 'center',
    },
    markHead: {
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 1.5,
      borderColor: MARK_COLOR,
      backgroundColor: 'transparent',
    },
    markHole: {
      position: 'absolute',
      top: 4,
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: MARK_COLOR,
    },
    markPoint: {
      width: 0,
      height: 0,
      marginTop: -1,
      borderLeftWidth: 4,
      borderRightWidth: 4,
      borderTopWidth: 7,
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent',
      borderTopColor: MARK_COLOR,
    },
    copy: {
      justifyContent: 'center',
      alignItems: 'center',
    },
    primary: {
      ...typography.body,
      color: colors.text,
      textAlign: 'center',
    },
    secondary: {
      ...typography.caption,
      color: colors.textSecondary,
      marginTop: spacing.xs,
      textAlign: 'center',
    },
    pressed: {
      opacity: 0.58,
    },
    disabled: {
      opacity: 0.55,
    },
  });
}
