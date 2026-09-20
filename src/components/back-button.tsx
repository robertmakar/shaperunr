import { useMemo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { typography, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';

type BackButtonProps = {
  onPress: () => void;
};

export function BackButton({ onPress }: BackButtonProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

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

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
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
}
