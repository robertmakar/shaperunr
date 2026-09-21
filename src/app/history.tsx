import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { InfoScreen } from '@/components/info-screen';
import { PrimaryButton } from '@/components/primary-button';
import { ShapeThumbnail } from '@/components/shape-thumbnail';
import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useDistanceUnit } from '@/hooks/use-distance-unit';
import { useThemeColors } from '@/hooks/use-theme';
import { formatDistance, formatHistoryDate } from '@/lib/format';
import { listRunHistory, type RunHistoryRecord } from '@/lib/run-history';

export default function HistoryScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [unit] = useDistanceUnit();
  /** null = still loading; [] = loaded and genuinely empty. */
  const [runs, setRuns] = useState<RunHistoryRecord[] | null>(null);

  // Reloads every time this screen gains focus (not just on first mount) —
  // it's always reached fresh from Home, but this also means returning here
  // from the detail screen, or after finishing another run, never shows a
  // stale list.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void listRunHistory().then((records) => {
        if (active) {
          setRuns(records);
        }
      });
      return () => {
        active = false;
      };
    }, []),
  );

  function openRun(id: string) {
    router.push({ pathname: '/history/[id]', params: { id } });
  }

  return (
    <InfoScreen title="MY SHAPES" titleSize="display" backFallback="/">
      {runs === null ? null : runs.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>NO SHAPES YET</Text>
          <Text style={styles.emptyBody}>Run your first shape and it'll live here.</Text>
          <PrimaryButton
            label="FIND A ROUTE"
            onPress={() => router.replace('/')}
            style={styles.emptyAction}
          />
        </View>
      ) : (
        <View style={styles.list}>
          {runs.map((run, index) => (
            <View key={run.id}>
              {index > 0 ? <View style={styles.divider} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${run.word}, ${Math.round(run.shapeProgressPercent)} percent`}
                onPress={() => openRun(run.id)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <ShapeThumbnail coordinates={run.targetShapeCoordinates} size={60} />
                <View style={styles.rowIdentity}>
                  <Text style={styles.rowWord}>{run.word}</Text>
                  <Text style={styles.rowMeta}>
                    {formatHistoryDate(run.finishedAt)} · {formatDistance(run.distanceMeters / 1000, unit)}
                  </Text>
                </View>
                <Text style={[styles.rowPercent, run.completed && styles.rowPercentComplete]}>
                  {Math.round(run.shapeProgressPercent)}%
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </InfoScreen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    empty: {
      gap: spacing.sm,
      maxWidth: 320,
      paddingTop: spacing.xxxl,
    },
    emptyTitle: {
      ...typography.title,
      color: colors.text,
    },
    emptyBody: {
      ...typography.body,
      color: colors.textSecondary,
    },
    emptyAction: {
      marginTop: spacing.xl,
    },
    list: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingVertical: spacing.xl,
    },
    rowPressed: {
      opacity: 0.6,
    },
    rowIdentity: {
      flex: 1,
      gap: spacing.xs,
    },
    rowWord: {
      ...typography.title,
      color: colors.text,
    },
    rowMeta: {
      ...typography.caption,
      color: colors.textSecondary,
      textTransform: 'uppercase',
    },
    rowPercent: {
      ...typography.title,
      color: colors.textMuted,
    },
    rowPercentComplete: {
      color: colors.accent,
    },
  });
}
