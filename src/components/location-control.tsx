import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';
import { formatCoordinatePair } from '@/lib/format';
import type { Coordinate } from '@/lib/geo';

export type LocationControlStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

type LocationControlProps = {
  status: LocationControlStatus;
  coordinate: Coordinate | null;
  onPress: () => void;
};

export function LocationControl({ status, coordinate, onPress }: LocationControlProps) {
  const disabled = status === 'loading';

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>STARTING NEAR</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel(status)}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => pressed && !disabled && styles.pressed}>
        <Text style={[styles.primary, status === 'idle' && styles.action]}>
          {primaryLabel(status)}
        </Text>
        {status === 'ready' && coordinate ? (
          <Text style={styles.secondary}>{formatCoordinatePair(coordinate)}</Text>
        ) : null}
      </Pressable>
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

const styles = StyleSheet.create({
  wrap: {
    marginTop: 42,
  },
  label: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginBottom: 14,
  },
  primary: {
    ...typography.location,
    color: colors.text,
  },
  action: {
    color: colors.text,
  },
  secondary: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: 6,
  },
  pressed: {
    opacity: 0.55,
  },
});
