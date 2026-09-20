/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors, darkColors, lightColors, type ThemeColors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useAppearance } from '@/hooks/use-appearance';

/**
 * Resolves the Appearance preference ('system' | 'light' | 'dark') against
 * the device's live color scheme. 'system' always tracks the OS setting via
 * React Native's own `useColorScheme` — it's never frozen at whatever
 * scheme was active on first render, so a mid-session OS theme change is
 * picked up immediately, same as an explicit Light/Dark selection.
 */
export function useResolvedAppearance(): 'light' | 'dark' {
  const [appearance] = useAppearance();
  const systemScheme = useColorScheme();
  if (appearance === 'system') {
    return systemScheme === 'dark' ? 'dark' : 'light';
  }
  return appearance;
}

/** The live ShapeRunr color tokens for the resolved appearance — the single source every themed screen/component reads from. */
export function useThemeColors(): ThemeColors {
  const resolved = useResolvedAppearance();
  return resolved === 'dark' ? darkColors : lightColors;
}

/** The legacy Themed*-component palette (unrelated to ShapeRunr's own `colors` tokens above) — kept as-is for its existing (unused-in-app) consumers. */
export function useTheme() {
  const scheme = useColorScheme();
  const theme = scheme === 'unspecified' ? 'light' : scheme;

  return Colors[theme];
}
