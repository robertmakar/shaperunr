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
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <Text style={styles.label}>←</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    marginLeft: -8,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
