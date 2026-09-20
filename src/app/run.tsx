import { Redirect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { DeniedNotice } from '@/components/denied-notice';
import { experimentalConnectorOverlay } from '@/components/experimental-route-card';
import { PrimaryButton } from '@/components/primary-button';
import { RouteMap, type MapOverlay } from '@/components/route-map';
import { RunStat } from '@/components/run-stat';
import { Screen } from '@/components/screen';
import { getRouteCoordinates } from '@/constants/mock-routes';
import { colors, spacing, typography } from '@/constants/theme';
import { useForegroundRun } from '@/hooks/use-foreground-run';
import { getSelectedExperimentalRoute } from '@/lib/experimental-route-session';
import { formatMatch, formatPace, formatWord } from '@/lib/format';
import { resolveStartCoordinate } from '@/lib/location';
import {
  elapsedMinutes,
  formatElapsedClock,
  runPermissionDeniedCopy,
} from '@/lib/run-tracking';
import { calculateShapeProgress } from '@/lib/shape-progress';
import { readNumberParam, readOptionalNumberParam, readParam } from '@/lib/search-params';

/** 3, 2, 1, GO — each step holds for this long before advancing. */
const COUNTDOWN_STEPS = ['3', '2', '1', 'GO'] as const;
const COUNTDOWN_STEP_MS = 700;

export default function RunScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    word?: string | string[];
    distance?: string | string[];
    match?: string | string[];
    duration?: string | string[];
    routeId?: string | string[];
    experimental?: string | string[];
    latitude?: string | string[];
    longitude?: string | string[];
  }>();

  const word = formatWord(readParam(params.word));
  const experimental = readParam(params.experimental) === '1';
  const selectedExperimental = experimental ? getSelectedExperimentalRoute() : null;
  const shapeStart = selectedExperimental?.shapeCoordinates[0];
  const run = useForegroundRun(shapeStart);
  const live =
    run.status === 'running' ||
    run.status === 'paused' ||
    run.status === 'finished';
  const plannedDistanceKm = selectedExperimental
    ? selectedExperimental.totalDistance / 1000
    : readNumberParam(params.distance, 0);
  const plannedDurationMin = readNumberParam(
    params.duration,
    Math.max(1, Math.round((plannedDistanceKm * 63) / 10)),
  );
  const matchPercent = selectedExperimental
    ? Math.round(selectedExperimental.shapeScore * 100)
    : readNumberParam(params.match, 0);
  const routeId = readNumberParam(params.routeId, 1);
  const start = resolveStartCoordinate(
    readOptionalNumberParam(params.latitude),
    readOptionalNumberParam(params.longitude),
  );
  const coordinates = selectedExperimental
    ? selectedExperimental.shapeCoordinates
    : getRouteCoordinates(routeId, start.coordinate);
  const shapeProgress = useMemo(
    () => calculateShapeProgress(coordinates, run.pathSegments),
    [coordinates, run.pathSegments],
  );
  const distanceKm = live ? run.distanceMeters / 1000 : plannedDistanceKm;
  const durationMin = live ? elapsedMinutes(run.elapsedMs) : plannedDurationMin;
  const durationLabel = live
    ? formatElapsedClock(run.elapsedMs)
    : String(Math.max(1, Math.round(plannedDurationMin)));
  const overlays = useMemo(() => {
    const layers: MapOverlay[] = selectedExperimental
      ? experimentalConnectorOverlay(selectedExperimental.connectorCoordinates)
      : [];
    for (const segment of run.pathSegments) {
      if (segment.length > 1) {
        layers.push({
          coordinates: segment,
          strokeColor: colors.text,
          strokeWidth: 3,
        });
      }
    }
    return layers;
  }, [run.pathSegments, selectedExperimental]);

  /**
   * Pre-run countdown — purely a presentation delay in front of run.start().
   * The tracking session stays 'idle' throughout; nothing here touches
   * elapsed time, distance, or GPS. Cleared on unmount so a stray leave
   * mid-countdown can never fire run.start() afterwards.
   */
  const [countdownIndex, setCountdownIndex] = useState<number | null>(null);
  const countdownTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      countdownTimeouts.current.forEach(clearTimeout);
      countdownTimeouts.current = [];
    };
  }, []);

  function beginCountdown() {
    if (countdownIndex !== null || run.status !== 'idle') {
      return;
    }
    setCountdownIndex(0);
    COUNTDOWN_STEPS.forEach((_, stepIndex) => {
      const timeout = setTimeout(() => {
        if (!mountedRef.current) {
          return;
        }
        if (stepIndex === COUNTDOWN_STEPS.length - 1) {
          const goTimeout = setTimeout(() => {
            if (!mountedRef.current) {
              return;
            }
            setCountdownIndex(null);
            void run.start();
          }, COUNTDOWN_STEP_MS);
          countdownTimeouts.current.push(goTimeout);
        }
        setCountdownIndex(stepIndex);
      }, stepIndex * COUNTDOWN_STEP_MS);
      countdownTimeouts.current.push(timeout);
    });
  }

  const countingDown = countdownIndex !== null;

  const missingExperimental = experimental && (!selectedExperimental || formatWord(selectedExperimental.word) !== word);
  if (missingExperimental || !word) {
    return <Redirect href="/" />;
  }

  const deniedCopy =
    run.status === 'denied'
      ? runPermissionDeniedCopy(
          run.deniedReason === 'restricted'
            ? 'restricted'
            : run.deniedReason === 'denied'
              ? 'denied'
              : 'unavailable',
        )
      : null;

  /** Pure presentation label for the run's overall state — the shape-progress row (below) owns "drawing"/"complete" language. */
  const stateKicker = countingDown
    ? 'GET READY'
    : run.status === 'paused'
      ? 'PAUSED'
      : run.status === 'finished'
        ? 'FINISHED'
        : run.status === 'running' && !shapeProgress.reachedShapeStart
          ? 'ON YOUR WAY'
          : run.status === 'running'
            ? 'RUNNING'
            : null;
  const paceLabel =
    distanceKm > 0
      ? formatPace(
          distanceKm,
          live ? Math.max(durationMin, 1 / 60) : durationMin,
        )
      : '--:--';

  function goBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  // A single guard for every way this screen can be dismissed — the header
  // back button, an edge swipe, or Android's hardware back — all route
  // through the navigator's own removal, so intercepting it here covers
  // them uniformly. Only an in-progress run (running/paused) is guarded;
  // idle, the countdown, denied, and finished all leave immediately.
  useEffect(() => {
    return navigation.addListener('beforeRemove', (event) => {
      if (run.status !== 'running' && run.status !== 'paused') {
        return;
      }
      event.preventDefault();
      Alert.alert(
        'ARE YOU SURE YOU WANT TO LEAVE THE RUN?',
        'Your current run will be lost.',
        [
          { text: 'CANCEL', style: 'cancel' },
          {
            text: 'LEAVE RUN',
            style: 'destructive',
            onPress: () => {
              run.finish();
              navigation.dispatch(event.data.action);
            },
          },
        ],
      );
    });
  }, [navigation, run]);

  return (
    <Screen style={styles.screen}>
      <View style={styles.header}>
        <BackButton onPress={goBack} />
        <View style={styles.identity}>
          {stateKicker ? <Text style={styles.kicker}>{stateKicker}</Text> : null}
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.85}
            style={styles.word}>
            {word}
          </Text>
          {!live && !countingDown && matchPercent > 0 ? (
            <Text style={styles.plannedMatch}>{formatMatch(matchPercent)} MATCH</Text>
          ) : null}
        </View>
      </View>

      <View style={[styles.map, run.status === 'paused' && styles.mapRecede]}>
        <RouteMap
          coordinates={coordinates}
          userLocation={run.position ?? (start.isFallback && !selectedExperimental ? undefined : start.coordinate)}
          showUserLocation={live || Boolean(selectedExperimental) || !start.isFallback}
          followUser={run.status === 'running'}
          overlays={overlays}
          interactive
        />
      </View>

      {run.status !== 'finished' ? (
        <View style={styles.stats}>
          <RunStat value={distanceKm.toFixed(2)} label="KM" emphasis="primary" />
          <RunStat value={paceLabel} label="/KM" emphasis="primary" />
          <RunStat value={durationLabel} label="TIME" emphasis="primary" />
        </View>
      ) : null}

      {live && run.status !== 'finished' ? (
        <View style={styles.shapeProgress}>
          {shapeProgress.completed ? (
            <Text style={styles.shapeComplete}>SHAPE COMPLETE</Text>
          ) : (
            <>
              <Text style={styles.shapeLabel}>SHAPE</Text>
              <View style={styles.shapeTrack}>
                <View
                  style={[
                    styles.shapeFill,
                    { width: `${Math.round(shapeProgress.progressPercent)}%` },
                  ]}
                />
              </View>
              <Text style={styles.shapeValue}>{shapeProgress.progressPercent}%</Text>
            </>
          )}
        </View>
      ) : null}

      {countingDown ? (
        <View style={styles.countdown}>
          <Text style={styles.countdownValue}>{COUNTDOWN_STEPS[countdownIndex]}</Text>
        </View>
      ) : deniedCopy ? (
        <DeniedNotice
          copy={deniedCopy}
          onPress={() => {
            void run.retry();
          }}
        />
      ) : run.status === 'finished' ? (
        <View style={styles.finishedSummary}>
          <Text
            style={[
              styles.finishedTitle,
              shapeProgress.completed && styles.finishedTitleComplete,
            ]}>
            {shapeProgress.completed ? 'SHAPE COMPLETE' : 'SHAPE PROGRESS'}
          </Text>
          <View style={styles.finishedStats}>
            <RunStat value={distanceKm.toFixed(2)} label="KM" />
            <RunStat value={paceLabel} label="/KM" />
            <RunStat value={durationLabel} label="TIME" />
          </View>
          <Text style={styles.finishedShapeLine}>
            SHAPE{' '}
            <Text style={styles.finishedShapeValue}>
              {shapeProgress.progressPercent}%
            </Text>
          </Text>
          <PrimaryButton
            label="DONE"
            showArrow={false}
            onPress={() => router.replace('/')}
          />
        </View>
      ) : run.status === 'running' || run.status === 'paused' ? (
        <View style={styles.activeControls}>
          <PrimaryButton
            label={run.status === 'paused' ? 'RESUME' : 'PAUSE'}
            showArrow={false}
            onPress={() => {
              if (run.status === 'paused') {
                void run.resume();
              } else {
                run.pause();
              }
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Finish run"
            onPress={run.finish}
            style={({ pressed }) => [styles.finishLink, pressed && styles.finishLinkPressed]}>
            <Text style={styles.finishLinkText}>FINISH</Text>
          </Pressable>
        </View>
      ) : (
        <PrimaryButton
          label={
            run.status === 'requesting' ? 'STARTING...' : 'START RUN'
          }
          showArrow={false}
          disabled={run.status === 'requesting'}
          onPress={beginCountdown}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  plannedMatch: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  map: {
    flex: 1,
    minHeight: 260,
  },
  mapRecede: {
    opacity: 0.82,
  },
  stats: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.md,
  },
  shapeProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 22,
  },
  shapeLabel: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  shapeTrack: {
    flex: 1,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  shapeFill: {
    height: '100%',
    borderRadius: 1.5,
    backgroundColor: colors.accent,
  },
  shapeValue: {
    ...typography.meta,
    color: colors.text,
    minWidth: 40,
    textAlign: 'right',
  },
  shapeComplete: {
    ...typography.title,
    color: colors.accent,
  },
  countdown: {
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countdownValue: {
    ...typography.display,
    color: colors.text,
  },
  activeControls: {
    gap: spacing.sm,
  },
  finishLink: {
    alignSelf: 'center',
    minHeight: 44,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
  },
  finishLinkPressed: {
    opacity: 0.5,
  },
  finishLinkText: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  finishedSummary: {
    gap: spacing.md,
  },
  finishedTitle: {
    ...typography.display,
    color: colors.text,
  },
  finishedTitleComplete: {
    color: colors.accent,
  },
  finishedStats: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.md,
  },
  finishedShapeLine: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  finishedShapeValue: {
    color: colors.accent,
  },
});
