import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { Screen } from '@/components/screen';
import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';

type InfoScreenProps = {
  title: string;
  children: ReactNode;
  /** Where Back goes if there's nothing to pop to (e.g. deep-linked directly to this screen). Defaults to `/settings`, matching About/Privacy/Terms, which are only ever reached from there. */
  backFallback?: '/settings' | '/';
  /** `'default'` (typography.title, 22px) matches About/Privacy/Terms. `'display'` is the larger editorial scale used by My Shapes, where the title reads as this screen's own identity rather than a settings sub-page label. */
  titleSize?: 'default' | 'display';
};

/**
 * Shared header/scroll shell for Settings' informational pages (About,
 * Privacy, Terms) and other simple back+title+content screens (e.g. My
 * Shapes) — the same back-navigation and title treatment throughout, so
 * they all read as part of the same screen family.
 */
export function InfoScreen({ title, children, backFallback = '/settings', titleSize = 'default' }: InfoScreenProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <BackButton
            onPress={() => {
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace(backFallback);
              }
            }}
          />
          <Text style={[styles.title, titleSize === 'display' && styles.titleDisplay]}>{title}</Text>
        </View>
        {children}
      </ScrollView>
    </Screen>
  );
}

type InfoSectionProps = {
  heading: string;
  children: ReactNode;
};

/** A heading + stacked-paragraph block, shared by Privacy and Terms — keeps every section's spacing and type treatment identical without repeating styles at each call site. */
export function InfoSection({ heading, children }: InfoSectionProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createSectionStyles(colors), [colors]);

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{heading}</Text>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/** A single short paragraph, styled for comfortable reading (not dense legal-block text). */
export function InfoParagraph({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createSectionStyles(colors), [colors]);

  return <Text style={styles.paragraph}>{children}</Text>;
}

/** A small muted meta line (e.g. "Last updated"). */
export function InfoMeta({ children }: { children: ReactNode }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createSectionStyles(colors), [colors]);

  return <Text style={styles.meta}>{children}</Text>;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    content: {
      paddingBottom: spacing.xxl,
      gap: spacing.xxl,
    },
    header: {
      gap: spacing.md,
    },
    title: {
      ...typography.title,
      color: colors.text,
      marginTop: spacing.sm,
    },
    titleDisplay: {
      ...typography.display,
      fontSize: 34,
      lineHeight: 38,
    },
  });
}

function createSectionStyles(colors: ThemeColors) {
  return StyleSheet.create({
    section: {
      gap: spacing.md,
    },
    heading: {
      ...typography.kicker,
      color: colors.textSecondary,
    },
    body: {
      gap: spacing.sm,
    },
    paragraph: {
      ...typography.body,
      color: colors.text,
    },
    meta: {
      ...typography.caption,
      color: colors.textMuted,
    },
  });
}
