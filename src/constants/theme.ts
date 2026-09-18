/**
 * RunShape design tokens.
 * Off-white, typography-led, lots of whitespace.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const colors = {
  background: '#F4F3EF',
  surface: '#ECEBE6',
  surfaceAlt: '#E4E3DE',
  text: '#111111',
  textSecondary: '#777777',
  textMuted: '#8B8B8B',
  border: '#D0D0CC',
  inverse: '#FFFFFF',
} as const;

export const Colors = {
  light: {
    text: colors.text,
    background: colors.background,
    backgroundElement: colors.surface,
    backgroundSelected: colors.surfaceAlt,
    textSecondary: colors.textSecondary,
  },
  dark: {
    text: colors.inverse,
    background: colors.text,
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  hero: 72,
  screen: 24,
} as const;

export const Spacing = spacing;

export const radii = {
  sm: 8,
  md: 16,
  lg: 22,
  card: 24,
  pill: 100,
} as const;

export const typography = {
  logo: {
    fontSize: 13,
    fontWeight: '700' as const,
    letterSpacing: 3,
  },
  kicker: {
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.6,
  },
  hero: {
    fontSize: 46,
    lineHeight: 48,
    fontWeight: '700' as const,
    letterSpacing: -1.5,
  },
  display: {
    fontSize: 44,
    lineHeight: 46,
    fontWeight: '700' as const,
    letterSpacing: -1.4,
  },
  input: {
    fontSize: 28,
    fontWeight: '500' as const,
  },
  title: {
    fontSize: 22,
    fontWeight: '600' as const,
    letterSpacing: -0.4,
  },
  body: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '500' as const,
  },
  location: {
    fontSize: 19,
    fontWeight: '500' as const,
  },
  cta: {
    fontSize: 14,
    fontWeight: '700' as const,
    letterSpacing: 1,
  },
  meta: {
    fontSize: 14,
    fontWeight: '600' as const,
  },
  stat: {
    fontSize: 28,
    fontWeight: '700' as const,
    letterSpacing: -0.8,
  },
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
