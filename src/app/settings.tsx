import type { ReactNode } from 'react';
import { useState } from 'react';
import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { Screen } from '@/components/screen';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { useDistanceUnit } from '@/hooks/use-distance-unit';
import { DISTANCE_UNITS, distanceUnitName, type DistanceUnit } from '@/lib/format';

type SettingsRow = {
  label: string;
  value?: string;
};

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
  const [unit, setUnit] = useDistanceUnit();
  const [distanceExpanded, setDistanceExpanded] = useState(false);

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

        <View style={styles.section}>
          <Text style={styles.sectionHeading}>PREFERENCES</Text>
          <View style={styles.rowGroup}>
            <DistanceUnitRow
              unit={unit}
              expanded={distanceExpanded}
              onToggle={() => setDistanceExpanded((value) => !value)}
              onSelect={(next) => {
                setUnit(next);
                setDistanceExpanded(false);
              }}
            />
            <View style={styles.divider} />
            <Row label="Appearance" value="System" />
          </View>
        </View>

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

function DistanceUnitRow({
  unit,
  expanded,
  onToggle,
  onSelect,
}: {
  unit: DistanceUnit;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (unit: DistanceUnit) => void;
}) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Distance unit"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
        <Text style={styles.rowLabel}>Distance</Text>
        <View style={styles.rowValueGroup}>
          <Text style={styles.rowValue}>{distanceUnitName(unit)}</Text>
          <SymbolView
            name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
            size={13}
            weight="semibold"
            tintColor={colors.textMuted}
            style={[styles.chevron, expanded && styles.chevronExpanded]}
          />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.unitOptions}>
          {DISTANCE_UNITS.map((option) => {
            const selected = option === unit;
            return (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityLabel={distanceUnitName(option)}
                accessibilityState={{ selected }}
                onPress={() => onSelect(option)}
                style={({ pressed }) => [
                  styles.unitChip,
                  selected && styles.unitChipSelected,
                  pressed && !selected && styles.unitChipPressed,
                ]}>
                <Text style={[styles.unitChipLabel, selected && styles.unitChipLabelSelected]}>
                  {distanceUnitName(option)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
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
  rowPressed: {
    opacity: 0.6,
  },
  rowLabel: {
    ...typography.body,
    color: colors.text,
  },
  rowValue: {
    ...typography.body,
    color: colors.textSecondary,
  },
  rowValueGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  chevron: {
    transform: [{ rotate: '0deg' }],
  },
  chevronExpanded: {
    transform: [{ rotate: '180deg' }],
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  unitOptions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  unitChip: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
  },
  unitChipSelected: {
    backgroundColor: colors.accent,
  },
  unitChipPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  unitChipLabel: {
    ...typography.meta,
    color: colors.textSecondary,
  },
  unitChipLabelSelected: {
    color: colors.inverse,
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
