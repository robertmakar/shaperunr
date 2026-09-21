import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import { useThemeColors } from '@/hooks/use-theme';

type HistoryButtonProps = {
  onPress: () => void;
};

/** Opens "My Shapes" — the same 44×44 hit target, monochrome icon-button treatment as SettingsButton, just without its edge-flush negative margin, since this one sits to its left rather than at the row's own end. */
export function HistoryButton({ onPress }: HistoryButtonProps) {
  const colors = useThemeColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open My Shapes"
      hitSlop={12}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <SymbolView
        name={{ ios: 'square.stack', android: 'collections', web: 'collections' }}
        type="monochrome"
        weight="regular"
        size={19}
        tintColor={colors.text}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.45,
  },
});
