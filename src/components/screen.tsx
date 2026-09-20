import { type ReactNode, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';

type ScreenProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Screen({ children, style }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top + spacing.two,
          paddingBottom: Math.max(
            insets.bottom + spacing.two,
            spacing.three,
          ),
        },
        style,
      ]}>
      {children}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: spacing.screen,
    },
  });
}
