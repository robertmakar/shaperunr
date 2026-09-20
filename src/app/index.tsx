import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { BackButton } from '@/components/back-button';
import { BrandMark } from '@/components/brand-mark';
import { DeniedNotice } from '@/components/denied-notice';
import { DistanceSelector } from '@/components/distance-selector';
import { HomeShapeMap } from '@/components/home-shape-map';
import { LocationControl, type LocationControlStatus } from '@/components/location-control';
import { PrimaryButton } from '@/components/primary-button';
import { Screen } from '@/components/screen';
import { SettingsButton } from '@/components/settings-button';
import { EXPERIMENTAL_ROUTES } from '@/constants/experimental';
import { getDevelopmentApiUrl } from '@/constants/api';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { generateExperimentalRoutesFromBackend } from '@/lib/experimental-routes-client';
import { setExperimentalRoutesPrefetch } from '@/lib/experimental-routes-prefetch';
import { formatWord } from '@/lib/format';
import { shouldPlayHomeHandoff } from '@/lib/home-handoff';
import type { Coordinate } from '@/lib/geo';
import {
  getForegroundLocationForSearch,
  requestAndGetCurrentLocation,
  reverseGeocodeLabel,
  searchLocationNeededCopy,
  type LocationFailureReason,
} from '@/lib/location';

/** Total budget for the Home → Finding transition (map grow + chrome crossfade together). */
const HOME_TO_FINDING_MS = 650;
/** Each leg of the chrome crossfade — fade the current text out, swap it, fade the new text in. */
const CHROME_FADE_MS = 220;
/**
 * The Finding *search* animation's pacing (once the map has finished
 * growing) — recovered from the old, now-retired FindingRouteAnimation's
 * DRAW_DURATION_MS / ATTEMPT_HOLD_MS, deliberately much slower than the
 * ~650ms transition above. The two must never share a constant.
 */
const FINDING_SEARCH_DRAW_MS = 3_200;
const FINDING_SEARCH_HOLD_MS = 260;
/** How far from the left edge a touch must start for the back-swipe gesture to consider it. */
const EDGE_SWIPE_WIDTH = 24;
/** Minimum rightward travel (px) or velocity (px/s) to treat an edge swipe as a completed "go back". */
const EDGE_SWIPE_DISTANCE = 60;
const EDGE_SWIPE_VELOCITY = 600;

export default function HomeScreen() {
  const router = useRouter();
  const window = useWindowDimensions();
  const [word, setWord] = useState('');
  const [distance, setDistance] = useState(EXPERIMENTAL_ROUTES ? 2 : 4);
  const [locationStatus, setLocationStatus] = useState<LocationControlStatus>('idle');
  const [userLocation, setUserLocation] = useState<Coordinate | null>(null);
  const [locationLabel, setLocationLabel] = useState<string | null>(null);
  const [searchingLocation, setSearchingLocation] = useState(false);
  const [searchDeniedReason, setSearchDeniedReason] = useState<LocationFailureReason | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [handoff, setHandoff] = useState(false);
  /** Which text set the two chrome slots show — swapped only once they're faded to invisible, never both at once. */
  const [showFindingChrome, setShowFindingChrome] = useState(false);
  const chromeOpacity = useRef(new Animated.Value(1)).current;
  const chromeAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const mountedRef = useRef(true);
  const findLockRef = useRef(false);
  /** Bumped by exitFinding() and read after every await in handleFindRoute — a mismatch means the user backed out, so the result must be discarded rather than acted on. */
  const requestTokenRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const canSearch = word.trim().length > 0;
  const finding = searchingLocation || handoff;
  const searchDeniedCopy = searchDeniedReason ? searchLocationNeededCopy(searchDeniedReason) : null;
  const mapHeight = homeMapHeight(window.height, keyboardHeight);
  const findingMapHeight = Math.min(560, Math.max(420, Math.round(window.height * 0.56)));
  /**
   * Canvas growth: HomeShapeMap's OWN layout height never changes (its
   * `height` prop below is always the constant `mapHeight`) — this only
   * drives the outer `mapBleed` wrapper's real layout height, so surrounding
   * content reflows as the map area opens up. Deliberately separate from
   * `wordGrowAnim` below — the canvas and the word inside it do not share a
   * scale factor.
   */
  const mapHeightAnim = useRef(new Animated.Value(mapHeight)).current;
  /**
   * Word growth: a plain 0→1 progress, independent of the canvas's own
   * height. HomeShapeMap maps this to a scale derived from the word's OWN
   * bounding box (Home size → Finding size), not from how much the canvas
   * itself grows. Native-driven since it's pure progress, not a layout prop.
   */
  const wordGrowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      chromeAnimRef.current?.stop();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      findLockRef.current = false;
      requestTokenRef.current += 1;
      abortControllerRef.current?.abort();
      setHandoff(false);
      setShowFindingChrome(false);
      setSearchingLocation(false);
      chromeOpacity.setValue(1);
      mapHeightAnim.setValue(mapHeight);
      wordGrowAnim.setValue(0);
      return () => {
        chromeAnimRef.current?.stop();
        setHandoff(false);
      };
      // mapHeight intentionally omitted: this only needs to reset to whatever
      // height is current at the moment of (re)focus, not re-run on resize.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chromeOpacity, mapHeightAnim, wordGrowAnim]),
  );

  // Keeps the map's height following Home's normal (keyboard-aware) sizing
  // whenever we are NOT mid-transition — unchanged Home behavior.
  useEffect(() => {
    if (handoff) {
      return;
    }
    mapHeightAnim.setValue(mapHeight);
    wordGrowAnim.setValue(0);
  }, [handoff, mapHeight, mapHeightAnim, wordGrowAnim]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Resolves a human-readable place name for whatever coordinate is current
  // (from either the location control or a FIND MY ROUTE search) — the UI
  // never shows raw lat/long, and falls back to nothing (just "Current
  // location") if reverse geocoding is unavailable or fails.
  useEffect(() => {
    if (!userLocation) {
      setLocationLabel(null);
      return;
    }
    let cancelled = false;
    setLocationLabel(null);
    void reverseGeocodeLabel(userLocation).then((label) => {
      if (!cancelled) {
        setLocationLabel(label);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userLocation]);

  async function handleUseLocation() {
    setLocationStatus('loading');
    setSearchDeniedReason(null);

    const result = await requestAndGetCurrentLocation();

    if (result.ok) {
      setUserLocation(result.coordinate);
      setLocationStatus('ready');
      return;
    }

    setUserLocation(null);
    setLocationStatus('unavailable');
  }

  function openRoutes(coordinate?: Coordinate) {
    router.push({
      pathname: EXPERIMENTAL_ROUTES ? '/experimental-routes' : '/routes',
      params: {
        word: formatWord(word),
        distance: String(distance),
        ...(coordinate
          ? {
              latitude: String(coordinate.latitude),
              longitude: String(coordinate.longitude),
            }
          : {}),
      },
    });
  }

  function playChromeHandoff(toValue: number, duration: number) {
    return new Promise<void>((resolve) => {
      chromeAnimRef.current?.stop();
      chromeAnimRef.current = Animated.timing(chromeOpacity, {
        toValue,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });
      chromeAnimRef.current.start(() => {
        resolve();
      });
    });
  }

  /** Fades Home's chrome out, swaps the two text slots to their Finding content while invisible, then fades that in. */
  async function runChromeToFinding() {
    await playChromeHandoff(0, CHROME_FADE_MS);
    if (!mountedRef.current) {
      return;
    }
    setShowFindingChrome(true);
    await playChromeHandoff(1, HOME_TO_FINDING_MS - CHROME_FADE_MS);
  }

  /** The reverse: fade Finding's text out, swap back to Home's, fade it in — used by both the failure path and exitFinding(). */
  async function runChromeToHome() {
    await playChromeHandoff(0, CHROME_FADE_MS);
    if (!mountedRef.current) {
      return;
    }
    setShowFindingChrome(false);
    await playChromeHandoff(1, CHROME_FADE_MS);
  }

  /**
   * Shrinks the map back to its resting size in step with the chrome
   * reverting, and only then lets HomeShapeMap leave its frozen/searching
   * state — so the map's own un-freeze (back to live, small geometry)
   * lands exactly when it's back to the size that geometry matches.
   */
  async function revertToHome() {
    mapHeightAnim.stopAnimation();
    wordGrowAnim.stopAnimation();
    const mapRevert = new Promise<void>((resolve) => {
      Animated.timing(mapHeightAnim, {
        toValue: mapHeight,
        duration: CHROME_FADE_MS * 2,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start(() => resolve());
    });
    const wordRevert = new Promise<void>((resolve) => {
      Animated.timing(wordGrowAnim, {
        toValue: 0,
        duration: CHROME_FADE_MS * 2,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => resolve());
    });
    await Promise.all([mapRevert, wordRevert, runChromeToHome()]);
    if (mountedRef.current) {
      setHandoff(false);
    }
  }

  /**
   * The back button and the left-edge swipe both call exactly this. It must
   * make any in-flight handleFindRoute() call from this same search unable
   * to act on its result later — see the requestToken checks below.
   */
  function exitFinding() {
    requestTokenRef.current += 1;
    abortControllerRef.current?.abort();
    findLockRef.current = false;
    setSearchingLocation(false);
    void revertToHome();
  }

  async function handleFindRoute() {
    if (!canSearch || findLockRef.current) {
      return;
    }

    findLockRef.current = true;
    const requestToken = ++requestTokenRef.current;
    Keyboard.dismiss();
    setSearchDeniedReason(null);
    setSearchingLocation(true);

    if (!EXPERIMENTAL_ROUTES) {
      openRoutes(userLocation ?? undefined);
      setSearchingLocation(false);
      findLockRef.current = false;
      return;
    }

    const reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
    if (!mountedRef.current || requestTokenRef.current !== requestToken) {
      findLockRef.current = false;
      return;
    }

    const playHandoff = shouldPlayHomeHandoff({
      canSearch: true,
      reduceMotion,
      alreadyLocked: false,
    });

    setLocationStatus('loading');
    if (playHandoff) {
      setHandoff(true);
    }

    const locationPromise = getForegroundLocationForSearch();

    // Home stays mounted and IS the Finding presentation: the same map grows
    // in place while its own chrome dissolves into the Finding text. There is
    // no second screen or second scene to reconcile with.
    let transitionPromise: Promise<void> = Promise.resolve();
    if (playHandoff) {
      mapHeightAnim.stopAnimation();
      Animated.timing(mapHeightAnim, {
        toValue: findingMapHeight,
        duration: HOME_TO_FINDING_MS,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: false,
      }).start();
      wordGrowAnim.stopAnimation();
      wordGrowAnim.setValue(0);
      Animated.timing(wordGrowAnim, {
        toValue: 1,
        duration: HOME_TO_FINDING_MS,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }).start();
      transitionPromise = runChromeToFinding();
    }

    const result = await locationPromise;

    if (!mountedRef.current || requestTokenRef.current !== requestToken) {
      findLockRef.current = false;
      return;
    }

    if (!result.ok) {
      setUserLocation(null);
      setLocationStatus('unavailable');
      setSearchDeniedReason(result.reason);
      setSearchingLocation(false);
      if (playHandoff) {
        await revertToHome();
      } else {
        setHandoff(false);
      }
      findLockRef.current = false;
      return;
    }

    setUserLocation(result.coordinate);
    setLocationStatus('ready');
    console.log('[find-my-route][home]', {
      word: formatWord(word),
      selectedDistanceKm: distance,
      targetDistanceMeters: distance * 1000,
      latitude: result.coordinate.latitude,
      longitude: result.coordinate.longitude,
      expoPublicApiUrl: process.env.EXPO_PUBLIC_API_URL ?? null,
      apiUrl: getDevelopmentApiUrl(),
    });
    console.log('[experimental client] FIND MY ROUTE location', {
      latitude: result.coordinate.latitude,
      longitude: result.coordinate.longitude,
      distanceKm: distance,
      targetDistance: distance * 1000,
      word: formatWord(word),
    });

    // Starts exactly where it always has — right after location resolves —
    // just no longer gated behind a navigation. It runs concurrently with
    // whatever's left of the visual transition below.
    const targetDistanceMeters = distance * 1000;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const fetchPromise = generateExperimentalRoutesFromBackend({
      word: formatWord(word),
      start: result.coordinate,
      targetDistanceMeters,
      signal: abortController.signal,
    });

    const [, response] = await Promise.all([transitionPromise, fetchPromise]);
    if (!mountedRef.current || requestTokenRef.current !== requestToken) {
      // The user backed out (or a newer search superseded this one) while
      // this was in flight — the response must never reach Results.
      findLockRef.current = false;
      return;
    }

    setExperimentalRoutesPrefetch({
      word: formatWord(word),
      targetDistanceMeters,
      result: response,
    });
    openRoutes(result.coordinate);
  }

  async function handleSearchDeniedAction() {
    if (searchDeniedReason === 'restricted') {
      await Linking.openSettings();
      return;
    }
    await handleFindRoute();
  }

  function handleInputFocus() {
    setInputFocused(true);
  }

  const edgeSwipeGesture = Gesture.Pan()
    .activeOffsetX(10)
    .failOffsetY([-15, 15])
    .onEnd((event) => {
      if (event.translationX > EDGE_SWIPE_DISTANCE || event.velocityX > EDGE_SWIPE_VELOCITY) {
        runOnJS(exitFinding)();
      }
    });

  return (
    <Screen>
      {handoff ? (
        <GestureDetector gesture={edgeSwipeGesture}>
          <View style={styles.edgeSwipeZone} />
        </GestureDetector>
      ) : null}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}>
          <View style={styles.form}>
            {handoff ? (
              <View style={styles.findingBackRow}>
                <BackButton onPress={exitFinding} />
              </View>
            ) : null}

            <Animated.View
              pointerEvents={handoff ? 'none' : 'auto'}
              style={{ opacity: chromeOpacity }}>
              {showFindingChrome ? (
                <View>
                  <Text style={styles.findingKicker}>FINDING YOUR ROUTE</Text>
                  <Text style={styles.findingWord} numberOfLines={1}>
                    {formatWord(word)}
                  </Text>
                </View>
              ) : (
                <>
                  <View style={styles.topBar}>
                    <View style={styles.logoRow}>
                      <BrandMark size={14} />
                      <Text style={styles.logo}>SHAPERUNR</Text>
                    </View>
                    <View style={styles.settingsButtonSlot}>
                      <SettingsButton onPress={() => router.push('/settings')} />
                    </View>
                  </View>

                  <View style={styles.hero}>
                    <Text style={styles.title} numberOfLines={1}>
                      What do you
                    </Text>
                    <Text style={styles.title} numberOfLines={1}>
                      want to run?
                    </Text>
                  </View>

                  <Text style={styles.explanation}>
                    Type a word. We’ll find the streets that draw it.
                  </Text>

                  <View style={styles.inputWrapper}>
                    <TextInput
                      value={word}
                      onChangeText={setWord}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      editable={!finding}
                      accessibilityLabel="Word to run"
                      enterKeyHint="search"
                      returnKeyType="search"
                      selectionColor={colors.accent}
                      onFocus={handleInputFocus}
                      onBlur={() => setInputFocused(false)}
                      onSubmitEditing={() => {
                        void handleFindRoute();
                      }}
                      maxLength={12}
                      style={[
                        styles.input,
                        (inputFocused || canSearch) && styles.inputActive,
                      ]}
                    />
                    {word.length === 0 ? (
                      <View style={styles.inputPlaceholder} pointerEvents="none">
                        <Text
                          style={styles.inputPlaceholderText}
                          numberOfLines={1}
                          ellipsizeMode="tail">
                          Type a shape (e.g. L, O, ROBZ)
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </>
              )}
            </Animated.View>

            <Animated.View style={[styles.mapBleed, { height: mapHeightAnim }]}>
              <HomeShapeMap
                word={word}
                focused={inputFocused}
                height={mapHeight}
                searching={handoff}
                growProgress={wordGrowAnim}
                findingHeight={findingMapHeight}
                retraceDrawMs={FINDING_SEARCH_DRAW_MS}
                retraceHoldMs={FINDING_SEARCH_HOLD_MS}
              />
            </Animated.View>

            <Animated.View
              pointerEvents={handoff ? 'none' : 'auto'}
              style={{ opacity: chromeOpacity }}>
              {showFindingChrome ? (
                <View style={styles.findingFooter}>
                  <Text style={styles.findingSearching}>Searching the streets around you…</Text>
                  <Text style={styles.findingStatus}>MAPPING YOUR SHAPE</Text>
                </View>
              ) : (
                <>
                  <View style={styles.section}>
                    <Text style={styles.label}>DISTANCE</Text>
                    <DistanceSelector value={distance} onChange={setDistance} />
                  </View>

                  <LocationControl
                    status={locationStatus}
                    label={locationLabel}
                    onPress={() => {
                      void handleUseLocation();
                    }}
                  />

                  <View style={styles.primaryAction}>
                    <PrimaryButton
                      label={finding ? 'FINDING YOU...' : 'FIND MY ROUTE'}
                      disabled={!canSearch || finding}
                      onPress={() => {
                        void handleFindRoute();
                      }}
                    />
                  </View>

                  {searchDeniedCopy ? (
                    <DeniedNotice
                      copy={searchDeniedCopy}
                      onPress={() => {
                        void handleSearchDeniedAction();
                      }}
                      style={styles.denied}
                    />
                  ) : null}
                </>
              )}
            </Animated.View>
          </View>

          {!handoff ? (
            <Animated.View style={[styles.actions, { opacity: chromeOpacity }]}>
              <View style={styles.devLinks}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open developer shape proof of concept"
                  onPress={() => router.push('/debug-shape')}
                  style={({ pressed }) => pressed && styles.devLinkPressed}>
                  <Text style={styles.devLinkText}>DEV · SHAPE POC</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open developer real OpenStreetMap route generator"
                  onPress={() => router.push('/debug-real-routes')}
                  style={({ pressed }) => pressed && styles.devLinkPressed}>
                  <Text style={styles.devLinkText}>DEV · REAL OSM ROUTES</Text>
                </Pressable>
              </View>
            </Animated.View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  edgeSwipeZone: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: EDGE_SWIPE_WIDTH,
    zIndex: 10,
  },
  findingBackRow: {
    marginBottom: spacing.sm,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'space-between',
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    gap: spacing.lg,
  },
  form: {
    flexShrink: 1,
  },
  topBar: {
    justifyContent: 'center',
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  settingsButtonSlot: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  logo: {
    ...typography.logo,
    color: colors.text,
  },
  hero: {
    marginTop: spacing.xxl,
    marginBottom: spacing.xs,
  },
  title: {
    ...typography.display,
    color: colors.text,
  },
  findingKicker: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginTop: spacing.xl,
  },
  findingWord: {
    ...typography.display,
    color: colors.text,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  findingFooter: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  findingSearching: {
    ...typography.body,
    color: colors.text,
  },
  findingStatus: {
    ...typography.kicker,
    color: colors.textMuted,
  },
  input: {
    height: 64,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
    ...typography.input,
    color: colors.text,
    paddingHorizontal: spacing.xl,
  },
  inputActive: {
    borderColor: colors.text,
  },
  inputWrapper: {
    position: 'relative',
    marginBottom: spacing.md,
  },
  inputPlaceholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  inputPlaceholderText: {
    ...typography.input,
    fontSize: 23,
    color: colors.textMuted,
  },
  mapBleed: {
    marginHorizontal: -spacing.screen,
    flexShrink: 0,
    justifyContent: 'center',
    overflow: 'visible',
  },
  section: {
    marginTop: spacing.lg,
  },
  label: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  actions: {
    paddingTop: spacing.lg,
  },
  primaryAction: {
    gap: spacing.md,
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
  },
  explanation: {
    ...typography.caption,
    color: colors.textSecondary,
    maxWidth: 320,
    marginBottom: spacing.lg,
  },
  devLinks: {
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  devLinkText: {
    ...typography.kicker,
    color: colors.textMuted,
  },
  devLinkPressed: {
    opacity: 0.5,
  },
  denied: {
    marginTop: spacing.lg,
  },
});

function homeMapHeight(windowHeight: number, keyboardHeight: number): number {
  if (windowHeight <= 0) {
    return 207;
  }
  const available = Math.max(windowHeight - keyboardHeight, 520);
  const target = Math.round(windowHeight * (keyboardHeight > 0 ? 0.16 : 0.245));
  const min = keyboardHeight > 0 ? 112 : Math.round(windowHeight * 0.22);
  const max = Math.round(available * 0.3);
  return Math.min(max, Math.max(min, target));
}
