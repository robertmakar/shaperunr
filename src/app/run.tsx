import { Redirect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { DeniedNotice } from '@/components/denied-notice';
import { experimentalConnectorOverlay } from '@/components/experimental-route-card';
import { PrimaryButton } from '@/components/primary-button';
import { RouteMap, type MapOverlay, type RouteMapHandle } from '@/components/route-map';
import { RunStat } from '@/components/run-stat';
import { Screen } from '@/components/screen';
import { getRouteCoordinates } from '@/constants/mock-routes';
import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useDistanceUnit } from '@/hooks/use-distance-unit';
import { useForegroundRun } from '@/hooks/use-foreground-run';
import { usePaceUnit } from '@/hooks/use-pace-unit';
import { useThemeColors } from '@/hooks/use-theme';
import { getSelectedExperimentalRoute } from '@/lib/experimental-route-session';
import { convertKmToUnit, distanceUnitLabel, formatMatch, formatPace, formatWord } from '@/lib/format';
import { resolveStartCoordinate } from '@/lib/location';
import {
  elapsedMinutes,
  formatElapsedClock,
  runPermissionDeniedCopy,
} from '@/lib/run-tracking';
import {
  calculateShapeProgress,
  remainingShapeProgressCoordinates,
  shapeProgressCoordinates,
} from '@/lib/shape-progress';
import { readNumberParam, readOptionalNumberParam, readParam } from '@/lib/search-params';

/** 3, 2, 1, GO — each step holds for this long before advancing. */
const COUNTDOWN_STEPS = ['3', '2', '1', 'GO'] as const;
const COUNTDOWN_STEP_MS = 700;

export default function RunScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
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
  /** An in-progress run — the one state a swipe-back must never be allowed to silently leave. */
  const runInProgress = run.status === 'running' || run.status === 'paused';
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
  const [distanceUnit] = useDistanceUnit();
  const [paceUnit] = usePaceUnit();
  const distanceKm = live ? run.distanceMeters / 1000 : plannedDistanceKm;
  const displayDistance = convertKmToUnit(distanceKm, distanceUnit);
  const displayDistanceUnitLabel = distanceUnitLabel(distanceUnit).toUpperCase();
  const durationMin = live ? elapsedMinutes(run.elapsedMs) : plannedDurationMin;
  const durationLabel = live
    ? formatElapsedClock(run.elapsedMs)
    : String(Math.max(1, Math.round(plannedDurationMin)));
  const overlays = useMemo(() => {
    const layers: MapOverlay[] = selectedExperimental
      ? experimentalConnectorOverlay(selectedExperimental.connectorCoordinates, colors)
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
  }, [colors, run.pathSegments, selectedExperimental]);
  /**
   * Splits the target shape itself into a traced (coral) and untraced
   * (muted) portion, using the exact same `shapeProgress.progress` value
   * the linear SHAPE bar already reads — no separate progress calculation.
   * Only while live: before the run starts the target stays the normal,
   * undifferentiated route color (RouteMap's own default rendering).
   */
  const targetProgress = useMemo(() => {
    if (!live) {
      return undefined;
    }
    return {
      completedCoordinates: shapeProgressCoordinates(coordinates, shapeProgress.progress),
      remainingCoordinates: remainingShapeProgressCoordinates(coordinates, shapeProgress.progress),
    };
  }, [coordinates, live, shapeProgress.progress]);
  /** Pre-run only — lets the "recenter" control re-trigger RouteMap's own existing fit-to-route framing without reimplementing any camera logic. */
  const mapRef = useRef<RouteMapHandle>(null);

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
  const isGoStep = countdownIndex !== null && COUNTDOWN_STEPS[countdownIndex] === 'GO';

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
          paceUnit,
        )
      : '--:--';
  const paceUnitLabelText = `/${distanceUnitLabel(paceUnit).toUpperCase()}`;

  function goBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  /**
   * `run` is a fresh object every render (useForegroundRun doesn't memoize
   * its return value); reading the latest run state through a ref lets the
   * `beforeRemove` listener below be registered exactly once, for the
   * lifetime of this screen, instead of being torn down and re-registered
   * on every render.
   */
  const runRef = useRef(run);
  runRef.current = run;
  /** Guards against `beforeRemove` firing more than once for the same leave attempt while the Alert is already up. */
  const leaveConfirmationShowingRef = useRef(false);

  /**
   * `beforeRemove` + `event.preventDefault()` reliably intercepts any
   * JS-dispatched removal (the back button's `router.back()`, Android's
   * hardware back), because those go through react-navigation's own action
   * pipeline before anything native happens. The interactive iOS swipe-back
   * gesture does not: it's driven natively by react-native-screens, and on
   * this native-stack version the native pop transition can complete before
   * `beforeRemove` ever gets a chance to run, let alone prevent it — by the
   * time the Alert appeared, Run had already been popped, and confirming
   * "stay" had nothing left to restore. `preventDefault()` simply cannot
   * reverse an already-committed native gesture transition here.
   *
   * The native-stack-supported fix for exactly this case is the per-screen
   * `gestureEnabled` option: while a run is running or paused, the swipe
   * gesture is turned off via `navigation.setOptions`, so it can't start an
   * unconfirmed removal in the first place. It's re-enabled the instant the
   * run leaves that state (idle, requesting, denied, finished) — this is a
   * dynamic, run-state-driven toggle, not a permanent disable. The tradeoff:
   * while a run is in progress, leaving must go through the explicit Back
   * button (or Android hardware back), which still reliably shows the
   * confirmation; the swipe gesture itself is simply not available during
   * that window, since native-stack has no way to let the gesture begin and
   * still guarantee it can be cancelled after the fact.
   */
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !runInProgress });
  }, [navigation, runInProgress]);

  // A single guard for every way this screen can be dismissed — the header
  // back button and Android's hardware back both route through the
  // navigator's own removal, so intercepting it here covers them uniformly.
  // (The iOS swipe gesture is handled separately above, via `gestureEnabled`,
  // since `beforeRemove` alone can't reliably guard against it.) Only an
  // in-progress run (running/paused) is guarded; idle, the countdown,
  // denied, and finished all leave immediately.
  useEffect(() => {
    return navigation.addListener('beforeRemove', (event) => {
      if (runRef.current.status !== 'running' && runRef.current.status !== 'paused') {
        return;
      }
      event.preventDefault();
      if (leaveConfirmationShowingRef.current) {
        return;
      }
      leaveConfirmationShowingRef.current = true;
      Alert.alert(
        'Leave the run?',
        'Are you sure you want to leave your run? Your current run will be ended.',
        [
          {
            text: 'KEEP RUNNING',
            style: 'cancel',
            onPress: () => {
              leaveConfirmationShowingRef.current = false;
            },
          },
          {
            text: 'LEAVE THE RUN',
            style: 'destructive',
            onPress: () => {
              leaveConfirmationShowingRef.current = false;
              runRef.current.finish();
              navigation.dispatch(event.data.action);
            },
          },
        ],
        {
          onDismiss: () => {
            leaveConfirmationShowingRef.current = false;
          },
        },
      );
    });
  }, [navigation]);

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
            {word}
          </Text>
          {stateKicker ? <Text style={styles.kicker}>{stateKicker}</Text> : null}
          {!live && !countingDown && matchPercent > 0 ? (
            <Text style={styles.plannedMatch}>{formatMatch(matchPercent)} MATCH</Text>
          ) : null}
        </View>
      </View>

      <View style={[styles.map, run.status === 'paused' && styles.mapRecede]}>
        <RouteMap
          ref={mapRef}
          coordinates={coordinates}
          userLocation={run.position ?? (start.isFallback && !selectedExperimental ? undefined : start.coordinate)}
          showUserLocation={live || Boolean(selectedExperimental) || !start.isFallback}
          followUser={run.status === 'running'}
          overlays={overlays}
          targetProgress={targetProgress}
          interactive
        />

        {!live ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Recenter map on the route"
            hitSlop={4}
            onPress={() => mapRef.current?.recenter()}
            style={({ pressed }) => [styles.recenterButton, pressed && styles.recenterButtonPressed]}>
            <SymbolView
              name={{ ios: 'location', android: 'my_location', web: 'my_location' }}
              type="monochrome"
              weight="medium"
              size={18}
              tintColor={colors.text}
            />
          </Pressable>
        ) : null}
      </View>

      {countingDown ? (
        // A full takeover while counting down — no stats, shape progress, or
        // controls underneath it, so the numbers never collide with the
        // normal run UI. Replaces that entire region rather than sitting in
        // front of it.
        <View style={styles.countdown}>
          <Text style={[styles.countdownValue, isGoStep && styles.countdownValueGo]}>
            {COUNTDOWN_STEPS[countdownIndex]}
          </Text>
        </View>
      ) : (
        <>
          {run.status !== 'finished' ? (
            <View style={styles.liveMetrics}>
              {live ? (
                <View style={styles.stats}>
                  <RunStat value={displayDistance.toFixed(2)} label={displayDistanceUnitLabel} emphasis="primary" />
                  <RunStat value={paceLabel} label={paceUnitLabelText} emphasis="primary" />
                  <RunStat value={durationLabel} label="TIME" emphasis="primary" />
                </View>
              ) : (
                // Pre-run preview only (before START RUN is tapped) — distance
                // is the dominant metric, estimated time a clearly secondary
                // one; no pace here. Once live, the run reverts to the
                // three-column stats row above, unchanged.
                <View style={styles.preRunMetrics}>
                  <View style={styles.preRunMetricBlock}>
                    <Text style={styles.preRunMetricLabel}>DISTANCE</Text>
                    <Text style={styles.preRunDistanceValue}>
                      {displayDistance.toFixed(2)} {displayDistanceUnitLabel}
                    </Text>
                  </View>
                  <View style={styles.preRunMetricBlock}>
                    <Text style={styles.preRunMetricLabelQuiet}>EST. TIME</Text>
                    <Text style={styles.preRunTimeValue}>~{durationLabel} MIN</Text>
                  </View>
                </View>
              )}

              {live ? (
                <View style={styles.shapeProgress}>
                  {shapeProgress.completed ? (
                    <Text style={styles.shapeComplete}>SHAPE COMPLETE</Text>
                  ) : (
                    <>
                      <View style={styles.shapeHeaderRow}>
                        <Text style={styles.shapeLabel}>SHAPE</Text>
                        <Text style={styles.shapeValue}>{shapeProgress.progressPercent}%</Text>
                      </View>
                      <View style={styles.shapeTrack}>
                        <View
                          style={[
                            styles.shapeFill,
                            { width: `${Math.round(shapeProgress.progressPercent)}%` },
                          ]}
                        />
                      </View>
                    </>
                  )}
                </View>
              ) : null}
            </View>
          ) : null}

          {deniedCopy ? (
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
                {shapeProgress.completed ? 'SHAPE COMPLETE' : 'RUN FINISHED'}
              </Text>
              <View style={styles.finishedStats}>
                <RunStat value={displayDistance.toFixed(2)} label={displayDistanceUnitLabel} emphasis="primary" />
                <RunStat value={durationLabel} label="TIME" emphasis="primary" />
                <RunStat value={paceLabel} label={paceUnitLabelText} emphasis="primary" />
              </View>
              <View style={styles.finishedShapeRow}>
                <Text style={styles.finishedShapeLabel}>SHAPE</Text>
                <View style={styles.finishedShapeTrack}>
                  <View
                    style={[
                      styles.finishedShapeFill,
                      { width: `${Math.round(shapeProgress.progressPercent)}%` },
                    ]}
                  />
                </View>
                <Text style={styles.finishedShapeValue}>{shapeProgress.progressPercent}%</Text>
              </View>
              <PrimaryButton
                label="DONE"
                showArrow={false}
                style={styles.doneButton}
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
        </>
      )}
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
    plannedMatch: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    /**
     * Was the one flexible element, absorbing all leftover vertical space.
     * Now shares that space evenly with `liveMetrics` below — shorter than
     * before, but still a real floor (`minHeight`) so the route and current
     * position stay clearly readable.
     */
    map: {
      flex: 1,
      minHeight: 220,
    },
    mapRecede: {
      opacity: 0.82,
    },
    /** Pre-run only — a quiet, secondary control, not styled like a CTA. */
    recenterButton: {
      position: 'absolute',
      right: spacing.md,
      bottom: spacing.md,
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.15,
      shadowRadius: 4,
      elevation: 3,
    },
    recenterButtonPressed: {
      opacity: 0.6,
    },
    /** The live numbers and SHAPE progress — now a flexible region of its own, roughly matching the map's share of the screen rather than sitting in whatever auto-height space was left over. */
    liveMetrics: {
      flex: 1,
      justifyContent: 'center',
      gap: spacing.xxl,
      marginBottom: spacing.sm,
    },
    stats: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.lg,
      paddingVertical: spacing.sm,
    },
    /**
     * Pre-run only (before START RUN): distance is the dominant metric,
     * estimated time a clearly secondary one — two labeled blocks stacked
     * with real weight difference, not a three-column row with one column
     * removed. No pace here; the live three-column `stats` row (with pace)
     * takes over unchanged the moment the run actually starts.
     */
    preRunMetrics: {
      gap: spacing.xl,
    },
    preRunMetricBlock: {
      gap: spacing.xs,
    },
    preRunMetricLabel: {
      ...typography.kicker,
      color: colors.textSecondary,
    },
    preRunMetricLabelQuiet: {
      ...typography.kicker,
      color: colors.textMuted,
    },
    preRunDistanceValue: {
      ...typography.display,
      color: colors.text,
    },
    preRunTimeValue: {
      ...typography.statSecondary,
      color: colors.textSecondary,
    },
    /** SHAPE is a primary ShapeRunr metric, not a secondary widget — a real header row (label + a large percent) over a substantial track, not a thin inline bar. */
    shapeProgress: {
      gap: spacing.md,
    },
    shapeHeaderRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
    },
    shapeLabel: {
      ...typography.kicker,
      color: colors.textSecondary,
    },
    shapeTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.border,
      overflow: 'hidden',
    },
    shapeFill: {
      height: '100%',
      borderRadius: 4,
      backgroundColor: colors.accent,
    },
    shapeValue: {
      ...typography.metricLarge,
      color: colors.accent,
    },
    shapeComplete: {
      ...typography.metricLarge,
      color: colors.accent,
    },
    /** A true takeover: fills the same flexible region stats/shape-progress/controls would otherwise occupy, so nothing else renders underneath it. */
    countdown: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countdownValue: {
      fontSize: 128,
      lineHeight: 136,
      fontWeight: '700',
      letterSpacing: -3,
      color: colors.text,
    },
    countdownValueGo: {
      color: colors.accent,
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
    /**
     * `map` is still `flex: 1`, unchanged — but it's no longer the only
     * flexible element on the finished screen: this now competes with it
     * for the same leftover space (roughly 1:1.3), which both shrinks the
     * map modestly (~10-15%, versus it absorbing all remaining space alone)
     * and gives the result content real room to breathe. `flex-start`
     * (rather than centering) keeps that content flush against the map
     * instead of floating in the middle of its share of the space.
     *
     * No single uniform `gap` here — each element below has its own
     * `marginTop` instead, so the rhythm can vary rather than every
     * boundary getting identical space. Growing the block's own total
     * height this way is what eats into the dead space that used to sit
     * below DONE, without touching `map` or `justifyContent` again.
     *
     * Each of the four `marginTop` values below (14 / xxl / 40 / xxl) is
     * ~6-8px more than its previous value — a subtle, per-boundary increase
     * rather than one larger gap. 14 and 40 aren't on the named spacing
     * scale (the nearest tokens — md=12 and xxxl=48 — over/undershoot the
     * intended "a little more" by too much), so they're small intermediate
     * values instead, per the same convention `spacing`'s own half-step
     * entries (e.g. `half`, `one`, `two`) already use.
     */
    finishedSummary: {
      flex: 1.3,
      justifyContent: 'flex-start',
      marginTop: 14,
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
      gap: spacing.lg,
      marginTop: spacing.xxl,
    },
    /**
     * The secondary achievement indicator: label, a proportional coral
     * progress bar, and the percentage — label and percentage share one
     * type size/weight (only color distinguishes the percentage), and the
     * bar sits between them, vertically centered with both.
     */
    finishedShapeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: 40,
    },
    finishedShapeLabel: {
      ...typography.meta,
      color: colors.textSecondary,
    },
    finishedShapeTrack: {
      flex: 1,
      height: 5,
      borderRadius: 2.5,
      backgroundColor: colors.border,
      overflow: 'hidden',
    },
    finishedShapeFill: {
      height: '100%',
      borderRadius: 2.5,
      backgroundColor: colors.accent,
    },
    finishedShapeValue: {
      ...typography.meta,
      color: colors.accent,
      minWidth: 44,
      textAlign: 'right',
    },
    doneButton: {
      marginTop: spacing.xxl,
    },
  });
}
