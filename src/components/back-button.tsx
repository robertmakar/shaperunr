import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, typography } from '@/constants/theme';

type BackButtonProps = {
  onPress: () => void;
};

export function BackButton({ onPress }: BackButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Go back"
      hitSlop={12}
      onPress={onPress}
      style={({ pressed }) => pressed && styles.pressed}>
      <Text style={styles.label}>←</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 28,
    lineHeight: 32,
    color: colors.text,
    fontWeight: '400',
  },
  pressed: {
    opacity: 0.45,
  },
});
