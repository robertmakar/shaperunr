import type { ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { Screen } from '@/components/screen';
import { colors, spacing, typography } from '@/constants/theme';

type SettingsRow = {
  label: string;
  value?: string;
};

const PREFERENCES: SettingsRow[] = [
  { label: 'Distance', value: 'Kilometers' },
  { label: 'Appearance', value: 'System' },
];

const RUNNING: SettingsRow[] = [
  { label: 'Pace', value: 'min/km' },
  { label: 'Auto-pause', value: 'Off' },
];

const ABOUT: SettingsRow[] = [
  { label: 'About ShapeRunr' },
  { label: 'Privacy' },
  { label: 'Terms' },
];

export default function SettingsScreen() {
  const router = useRouter();

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <BackButton
            onPress={() => {
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace('/');
              }
            }}
          />
          <Text style={styles.title}>Settings</Text>
        </View>

        <Section heading="PREFERENCES" rows={PREFERENCES} />
        <Section heading="RUNNING" rows={RUNNING} />
        <Section heading="ABOUT" rows={ABOUT} />

        <View style={styles.footer}>
          <Text style={styles.version}>Version 1.0.0</Text>
          <Text style={styles.credit}>DEVELOPED BY ROBZ!</Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

function Section({ heading, rows }: { heading: string; rows: SettingsRow[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>{heading}</Text>
      <View style={styles.rowGroup}>
        {rows.map((row, index) => (
          <View key={row.label}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <Row label={row.label} value={row.value} />
          </View>
        ))}
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value?: string }): ReactNode {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
  section: {
    gap: spacing.md,
  },
  sectionHeading: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  rowGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  rowLabel: {
    ...typography.body,
    color: colors.text,
  },
  rowValue: {
    ...typography.body,
    color: colors.textSecondary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  footer: {
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  version: {
    ...typography.caption,
    color: colors.textMuted,
  },
  credit: {
    ...typography.microLabel,
    color: colors.textMuted,
  },
});
