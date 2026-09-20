import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { InfoScreen } from '@/components/info-screen';
import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';

const STEPS = [
  {
    number: '01',
    label: 'TYPE',
    body: 'Enter a word, letter, or shape.',
  },
  {
    number: '02',
    label: 'FIND',
    body: 'ShapeRunr searches the streets around your starting point for a walkable route that follows it.',
  },
  {
    number: '03',
    label: 'RUN',
    body: 'Choose a route and run it. Your movement becomes the shape.',
  },
] as const;

export default function AboutScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <InfoScreen title="About ShapeRunr">
      <View style={styles.hero}>
        <Text style={styles.wordmark}>SHAPERUNR</Text>
        <Text style={styles.tagline}>Run the shape.</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.paragraph}>ShapeRunr turns words into running routes.</Text>
        <Text style={styles.paragraph}>
          Type a word, choose how far you want to run, and ShapeRunr searches the streets around
          you for routes that trace the shape.
        </Text>
        <Text style={styles.paragraph}>The city becomes your canvas.</Text>
      </View>

      <View style={styles.divider} />

      <View style={styles.section}>
        <Text style={styles.sectionHeading}>HOW IT WORKS</Text>
        <View style={styles.steps}>
          {STEPS.map((step) => (
            <View key={step.number} style={styles.step}>
              <Text style={styles.stepNumber}>
                {step.number} — {step.label}
              </Text>
              <Text style={styles.paragraph}>{step.body}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.section}>
        <Text style={styles.sectionHeading}>BUILT FOR THE CITY</Text>
        <Text style={styles.paragraph}>
          ShapeRunr is an experiment in seeing familiar streets differently — turning ordinary
          roads into letters, words, drawings and runs.
        </Text>
      </View>

      <View style={styles.divider} />

      <View style={styles.footer}>
        <Text style={styles.version}>Version 1.0.0</Text>
        <Text style={styles.credit}>DEVELOPED BY ROBZ!</Text>
        <Text style={styles.copyright}>© 2026 ShapeRunr</Text>
      </View>
    </InfoScreen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    hero: {
      gap: spacing.xs,
    },
    wordmark: {
      ...typography.display,
      fontSize: 34,
      lineHeight: 38,
      color: colors.text,
    },
    tagline: {
      ...typography.title,
      color: colors.accent,
    },
    section: {
      gap: spacing.md,
    },
    sectionHeading: {
      ...typography.kicker,
      color: colors.textSecondary,
    },
    paragraph: {
      ...typography.body,
      color: colors.text,
    },
    steps: {
      gap: spacing.lg,
    },
    step: {
      gap: spacing.xs,
    },
    stepNumber: {
      ...typography.kicker,
      color: colors.accent,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    footer: {
      alignItems: 'center',
      gap: spacing.xs,
    },
    version: {
      ...typography.caption,
      color: colors.textMuted,
    },
    credit: {
      ...typography.microLabel,
      color: colors.textMuted,
    },
    copyright: {
      ...typography.microLabel,
      color: colors.textMuted,
    },
  });
}
