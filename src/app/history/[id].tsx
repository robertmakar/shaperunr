import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { RouteMap, type MapOverlay } from '@/components/route-map';
import { RunStat } from '@/components/run-stat';
import { Screen } from '@/components/screen';
import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useDistanceUnit } from '@/hooks/use-distance-unit';
import { usePaceUnit } from '@/hooks/use-pace-unit';
import { useThemeColors } from '@/hooks/use-theme';
import { convertKmToUnit, distanceUnitLabel, formatPace } from '@/lib/format';
import { listRunHistory, type RunHistoryRecord } from '@/lib/run-history';
import { elapsedMinutes, formatElapsedClock } from '@/lib/run-tracking';
import { remainingShapeProgressCoordinates, shapeProgressCoordinates } from '@/lib/shape-progress';

/**
 * A read-only look at one saved run — visually mirrors the Finished Run
 * screen's own header/map/result hierarchy (see run.tsx's `finished` state),
 * but built as its own screen rather than by touching run.tsx: that screen's
 * Active/Countdown/Finished behavior is locked, and this one never starts
 * location tracking or a run session — it only ever reads a past
 * RunHistoryRecord back out of storage.
 */
export default function HistoryDetailScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [distanceUnit] = useDistanceUnit();
  const [paceUnit] = usePaceUnit();
  /** null = still loading; undefined = loaded, but no record with this id exists. */
  const [record, setRecord] = useState<RunHistoryRecord | null | undefined>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void listRunHistory().then((records) => {
        if (active) {
          setRecord(records.find((entry) => entry.id === id) ?? undefined);
        }
      });
      return () => {
        active = false;
      };
    }, [id]),
  );

  function goBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/history');
    }
  }

  if (!record) {
    return (
      <Screen style={styles.screen}>
        <View style={styles.header}>
          <BackButton onPress={goBack} />
          {record === undefined ? (
            <View style={styles.identity}>
              <Text style={styles.notFound}>This shape couldn't be found.</Text>
            </View>
          ) : null}
        </View>
      </Screen>
    );
  }

  const distanceKm = record.distanceMeters / 1000;
  const displayDistance = convertKmToUnit(distanceKm, distanceUnit);
  const displayDistanceUnitLabel = distanceUnitLabel(distanceUnit).toUpperCase();
  const durationLabel = formatElapsedClock(record.elapsedMs);
  const paceLabel =
    distanceKm > 0 ? formatPace(distanceKm, elapsedMinutes(record.elapsedMs), paceUnit) : '--:--';
  const paceUnitLabelText = `/${distanceUnitLabel(paceUnit).toUpperCase()}`;
  const progress = Math.max(0, Math.min(1, record.shapeProgressPercent / 100));

  const targetProgress = {
    completedCoordinates: shapeProgressCoordinates(record.targetShapeCoordinates, progress),
    remainingCoordinates: remainingShapeProgressCoordinates(record.targetShapeCoordinates, progress),
  };

  const overlays: MapOverlay[] = record.runnerPathSegments
    .filter((segment) => segment.length > 1)
    .map((segment) => ({ coordinates: segment, strokeColor: colors.text, strokeWidth: 3 }));

  return (
    <Screen style={styles.screen}>
      <View style={styles.header}>
        <BackButton onPress={goBack} />
        <View style={styles.identity}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.85}
            style={styles.word}>
            {record.word}
          </Text>
          <Text style={styles.kicker}>FINISHED</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <RouteMap
          coordinates={record.targetShapeCoordinates}
          targetProgress={targetProgress}
          overlays={overlays}
          height={280}
          interactive
        />

        <View style={styles.summary}>
          <Text style={[styles.title, record.completed && styles.titleComplete]}>
            {record.completed ? 'SHAPE COMPLETE' : 'RUN FINISHED'}
          </Text>
          <View style={styles.stats}>
            <RunStat value={displayDistance.toFixed(2)} label={displayDistanceUnitLabel} emphasis="primary" />
            <RunStat value={durationLabel} label="TIME" emphasis="primary" />
            <RunStat value={paceLabel} label={paceUnitLabelText} emphasis="primary" />
          </View>
          <View style={styles.shapeRow}>
            <Text style={styles.shapeLabel}>SHAPE</Text>
            <View style={styles.shapeTrack}>
              <View
                style={[styles.shapeFill, { width: `${Math.round(record.shapeProgressPercent)}%` }]}
              />
            </View>
            <Text style={styles.shapeValue}>{Math.round(record.shapeProgressPercent)}%</Text>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: {
      gap: spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    identity: {
      flex: 1,
      gap: spacing.xs,
      minHeight: 52,
      justifyContent: 'center',
    },
    kicker: {
      ...typography.kicker,
      color: colors.textSecondary,
    },
    word: {
      ...typography.display,
      fontSize: 34,
      lineHeight: 38,
      color: colors.text,
    },
    notFound: {
      ...typography.body,
      color: colors.textSecondary,
    },
    content: {
      gap: spacing.xxl,
      paddingBottom: spacing.xxl,
    },
    summary: {
      gap: spacing.xxl,
    },
    title: {
      ...typography.display,
      color: colors.text,
    },
    titleComplete: {
      color: colors.accent,
    },
    stats: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.lg,
    },
    shapeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    shapeLabel: {
      ...typography.meta,
      color: colors.textSecondary,
    },
    shapeTrack: {
      flex: 1,
      height: 5,
      borderRadius: 2.5,
      backgroundColor: colors.border,
      overflow: 'hidden',
    },
    shapeFill: {
      height: '100%',
      borderRadius: 2.5,
      backgroundColor: colors.accent,
    },
    shapeValue: {
      ...typography.meta,
      color: colors.accent,
      minWidth: 44,
      textAlign: 'right',
    },
  });
}
