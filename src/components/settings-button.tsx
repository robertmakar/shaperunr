import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import { colors } from '@/constants/theme';

type SettingsButtonProps = {
  onPress: () => void;
};

export function SettingsButton({ onPress }: SettingsButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open settings"
      hitSlop={12}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <SymbolView
        name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
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
    marginRight: -8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.45,
  },
});
