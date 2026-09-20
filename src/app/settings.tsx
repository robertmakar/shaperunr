import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { Screen } from '@/components/screen';
import { radii, spacing, typography, type ThemeColors } from '@/constants/theme';
import { useAppearance } from '@/hooks/use-appearance';
import { useAutoPause } from '@/hooks/use-auto-pause';
import { useDistanceUnit } from '@/hooks/use-distance-unit';
import { usePaceUnit } from '@/hooks/use-pace-unit';
import { useThemeColors } from '@/hooks/use-theme';
import { APPEARANCES, appearanceName, type Appearance } from '@/lib/appearance-preference';
import { AUTO_PAUSE_SETTINGS, autoPauseSettingName, type AutoPauseSetting } from '@/lib/auto-pause-preference';
import { DISTANCE_UNITS, distanceUnitName, paceUnitName, type DistanceUnit } from '@/lib/format';

type SettingsRow = {
  label: string;
  value?: string;
};

const ABOUT: SettingsRow[] = [
  { label: 'About ShapeRunr' },
  { label: 'Privacy' },
  { label: 'Terms' },
];

export default function SettingsScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [unit, setUnit] = useDistanceUnit();
  const [distanceExpanded, setDistanceExpanded] = useState(false);
  const [autoPause, setAutoPause] = useAutoPause();
  const [autoPauseExpanded, setAutoPauseExpanded] = useState(false);
  const [paceUnit, setPaceUnit] = usePaceUnit();
  const [paceExpanded, setPaceExpanded] = useState(false);
  const [appearance, setAppearance] = useAppearance();
  const [appearanceExpanded, setAppearanceExpanded] = useState(false);

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
            <ExpandableOptionRow
              label="Distance"
              accessibilityLabel="Distance unit"
              options={DISTANCE_UNITS}
              value={unit}
              optionLabel={distanceUnitName}
              expanded={distanceExpanded}
              onToggle={() => setDistanceExpanded((value) => !value)}
              onSelect={(next: DistanceUnit) => {
                setUnit(next);
                setDistanceExpanded(false);
              }}
            />
            <View style={styles.divider} />
            <ExpandableOptionRow
              label="Appearance"
              accessibilityLabel="Appearance"
              options={APPEARANCES}
              value={appearance}
              optionLabel={appearanceName}
              expanded={appearanceExpanded}
              onToggle={() => setAppearanceExpanded((value) => !value)}
              onSelect={(next: Appearance) => {
                setAppearance(next);
                setAppearanceExpanded(false);
              }}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeading}>RUNNING</Text>
          <View style={styles.rowGroup}>
            <ExpandableOptionRow
              label="Pace"
              accessibilityLabel="Pace unit"
              options={DISTANCE_UNITS}
              value={paceUnit}
              optionLabel={paceUnitName}
              expanded={paceExpanded}
              onToggle={() => setPaceExpanded((value) => !value)}
              onSelect={(next: DistanceUnit) => {
                setPaceUnit(next);
                setPaceExpanded(false);
              }}
            />
            <View style={styles.divider} />
            <ExpandableOptionRow
              label="Auto-pause"
              accessibilityLabel="Auto-pause"
              options={AUTO_PAUSE_SETTINGS}
              value={autoPause}
              optionLabel={autoPauseSettingName}
              expanded={autoPauseExpanded}
              onToggle={() => setAutoPauseExpanded((value) => !value)}
              onSelect={(next: AutoPauseSetting) => {
                setAutoPause(next);
                setAutoPauseExpanded(false);
              }}
            />
          </View>
        </View>

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
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
    </View>
  );
}

/** The interaction Distance introduced (tap to reveal pill options, selected one highlighted) — reused as-is for any other Settings preference with a short, fixed option list. */
function ExpandableOptionRow<T extends string>({
  label,
  accessibilityLabel,
  options,
  value,
  optionLabel,
  expanded,
  onToggle,
  onSelect,
}: {
  label: string;
  accessibilityLabel: string;
  options: T[];
  value: T;
  optionLabel: (option: T) => string;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (option: T) => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
        <Text style={styles.rowLabel}>{label}</Text>
        <View style={styles.rowValueGroup}>
          <Text style={styles.rowValue}>{optionLabel(value)}</Text>
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
        <View style={styles.optionChips}>
          {options.map((option) => {
            const selected = option === value;
            return (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityLabel={optionLabel(option)}
                accessibilityState={{ selected }}
                onPress={() => onSelect(option)}
                style={({ pressed }) => [
                  styles.chip,
                  selected && styles.chipSelected,
                  pressed && !selected && styles.chipPressed,
                ]}>
                <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
                  {optionLabel(option)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
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
    optionChips: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingBottom: spacing.md,
    },
    chip: {
      flex: 1,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm,
    },
    chipSelected: {
      backgroundColor: colors.accent,
    },
    chipPressed: {
      backgroundColor: colors.surfaceAlt,
    },
    chipLabel: {
      ...typography.meta,
      color: colors.textSecondary,
    },
    chipLabelSelected: {
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
}
