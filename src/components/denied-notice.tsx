import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, spacing, typography } from '@/constants/theme';

export type DeniedNoticeCopy = {
  title: string;
  body: string;
  action: string;
};

type DeniedNoticeProps = {
  copy: DeniedNoticeCopy;
  onPress: () => void;
  /** Lets each host control its own surrounding spacing rather than baking one assumption in here. */
  style?: StyleProp<ViewStyle>;
};

/** The one "location/permission denied, here's what to do" notice — shared so it looks identical wherever it appears. */
export function DeniedNotice({ copy, onPress, style }: DeniedNoticeProps) {
  return (
    <View style={[styles.denied, style]}>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.action}
        onPress={onPress}
        style={({ pressed }) => pressed && styles.pressed}>
        <Text style={styles.action}>{copy.action}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  denied: {
    gap: spacing.sm,
  },
  title: {
    ...typography.kicker,
    color: colors.text,
  },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    maxWidth: 320,
  },
  action: {
    ...typography.kicker,
    color: colors.text,
    marginTop: spacing.sm,
  },
  pressed: {
    opacity: 0.55,
  },
});
