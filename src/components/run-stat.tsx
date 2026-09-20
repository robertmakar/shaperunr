import { StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

type RunStatProps = {
  value: string;
  label: string;
  emphasis?: 'primary' | 'secondary';
};

export function RunStat({
  value,
  label,
  emphasis = 'secondary',
}: RunStatProps) {
  return (
    <View style={styles.stat}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        style={[styles.value, emphasis === 'primary' && styles.valuePrimary]}>
        {value}
      </Text>
      <Text numberOfLines={1} style={styles.label}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stat: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  value: {
    ...typography.statSecondary,
    color: colors.text,
  },
  valuePrimary: {
    ...typography.metricLarge,
  },
  label: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
});
