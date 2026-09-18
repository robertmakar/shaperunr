import { StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '@/constants/theme';

type RunStatProps = {
  value: string;
  label: string;
};

export function RunStat({ value, label }: RunStatProps) {
  return (
    <View style={styles.stat}>
      <Text numberOfLines={1} style={styles.value}>
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
    fontSize: 28,
    lineHeight: 32,
    fontWeight: '700',
    letterSpacing: -0.8,
    color: colors.text,
  },
  label: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
});
