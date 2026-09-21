import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  useWindowDimensions,
} from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';
import { boundingBox2 } from '@/lib/geometry';
import { HOME_HANDOFF_MS } from '@/lib/home-handoff';
import {
  HOME_ROUTE_WIDTH,
  homeWordFromInput,
  layoutHomeRoutePoints,
  layoutHomeScene,
  type HomeSegment,
  type HomeSize,
} from '@/lib/home-street-path';

type HomeShapeMapProps = {
  word: string;
  focused?: boolean;
  height: number;
  searching?: boolean;
  /**
   * 0 → 1 progress for the word's own growth, owned by the caller (e.g.
   * index.tsx animates it in parallel with, but independently of, the
   * canvas's own layout-height growth). At 0 the frozen scene renders at
   * exactly its Home size; at 1 it renders at its fixed Finding-viewport
   * target size (see `findingBox`/`fitScale` below) — a deterministic
   * function of the word alone, not of Home's own current canvas size.
   */
  growProgress?: Animated.Value;
  /**
   * The Finding canvas's eventual height (width is assumed unchanged — Home
   * is already full-bleed). Used only to work out how large the word's own
   * bounding box should become there, by running the same layout function
   * at that size — never to scale the whole canvas by a height ratio.
   */
  findingHeight?: number;
  /** Overrides the retrace loop's per-cycle draw duration (defaults to HOME_HANDOFF_MS). */
  retraceDrawMs?: number;
  /** How long the fully-drawn route holds before redrawing (defaults to 0 — no hold, matching prior behavior). */
  retraceHoldMs?: number;
};

/**
 * The Finding-state shape's target footprint, as a fraction of the fixed
 * viewport (window width / findingHeight) — calibrated against what a
 * multi-letter word like "ROB" already occupies naturally, so short words
 * (whose unconstrained letterform aspect ratio can otherwise run tall) get
 * clamped down to a comparable footprint instead of dominating the screen.
 * Purely geometric — no per-word-length branching.
 *
 * ~17.5% larger than the original calibration (0.8 / 0.34) — the shape
 * read as too small, with too much empty space around it. Single letters
 * are height-bound in practice, so this is the lever that actually grows
 * their rendered size; the width budget is raised by the same proportion
 * for consistency, though it isn't the binding constraint for any word
 * tested so far.
 */
const FINDING_SHAPE_BUDGET_WIDTH = 0.94;
const FINDING_SHAPE_BUDGET_HEIGHT = 0.4;

export function HomeShapeMap({
  word,
  focused = false,
  height,
  searching = false,
  growProgress,
  findingHeight,
  retraceDrawMs = HOME_HANDOFF_MS,
  retraceHoldMs = 0,
}: HomeShapeMapProps) {
  const window = useWindowDimensions();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [measured, setMeasured] = useState<HomeSize>({ width: 0, height: 0 });
  const [reduceMotion, setReduceMotion] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const streetPresence = useRef(new Animated.Value(0)).current;
  const drawRef = useRef<Animated.CompositeAnimation | null>(null);
  const presenceRef = useRef<Animated.CompositeAnimation | null>(null);
  const searchLift = useRef(new Animated.Value(0)).current;
  const searchLiftRef = useRef<Animated.CompositeAnimation | null>(null);
  const normalizedWord = homeWordFromInput(word);
  const canvasWidth = measured.width > 0 ? measured.width : window.width;
  const canvasHeight = measured.height > 0 ? measured.height : height;
  const scene = useMemo(
    () => layoutHomeScene(normalizedWord, { width: canvasWidth, height: canvasHeight }),
    [canvasHeight, canvasWidth, normalizedWord],
  );

  /**
   * The Finding-state target geometry, computed ONCE from fixed inputs only
   * — the word, the window's own (layout-independent) width, and the fixed
   * `findingHeight` — never from Home's own live, keyboard-dependent canvas
   * measurement. `findingBox` is the word's complete bounding box at that
   * fixed viewport; `fitScale` then clamps it (never enlarges) so a single
   * letter's naturally tall, unconstrained-aspect-ratio footprint can't
   * dominate the viewport the way a multi-letter word's forced-wide aspect
   * ratio never does. Both are pure functions of `word` — the same input
   * always produces the same target, regardless of animation state, Home's
   * current measured size, or keyboard timing.
   */
  const findingBox = useMemo(() => {
    if (!findingHeight || window.width <= 0) {
      return null;
    }
    return boundingBox2(
      layoutHomeRoutePoints(normalizedWord, { width: window.width, height: findingHeight }),
    );
  }, [findingHeight, normalizedWord, window.width]);

  const fitScale = useMemo(() => {
    if (!findingBox || findingBox.width <= 0 || findingBox.height <= 0 || !findingHeight) {
      return 1;
    }
    return Math.min(
      1,
      (window.width * FINDING_SHAPE_BUDGET_WIDTH) / findingBox.width,
      (findingHeight * FINDING_SHAPE_BUDGET_HEIGHT) / findingBox.height,
    );
  }, [findingBox, findingHeight, window.width]);

  /**
   * Captured once, on the rising edge of `searching`, and held until searching
   * ends. Reading/writing a ref during render is safe here: it's a pure
   * snapshot of values already computed earlier in this same render, and the
   * component never reads a value it hasn't also written first.
   *
   * `growScaleEnd` is solved backward from the deterministic target above:
   * given whatever Home's own box happens to measure right now (`homeBox` —
   * live, and fine to be so, since it only describes the animation's
   * starting point), it's the multiplier that lands EXACTLY on the fixed
   * `findingBox × fitScale` target by construction — not a ratio that merely
   * happens to cancel out Home's raciness, but one built to guarantee it.
   */
  const frozenRef = useRef<{ scene: typeof scene; width: number; height: number; growScaleEnd: number } | null>(
    null,
  );
  if (searching) {
    if (!frozenRef.current && canvasWidth > 0 && canvasHeight > 0) {
      const homeBox = boundingBox2(
        layoutHomeRoutePoints(normalizedWord, { width: canvasWidth, height: canvasHeight }),
      );
      const growScaleEnd =
        homeBox && homeBox.height > 0 && findingBox && findingBox.height > 0
          ? (findingBox.height * fitScale) / homeBox.height
          : 1;
      frozenRef.current = { scene, width: canvasWidth, height: canvasHeight, growScaleEnd };
    }
  } else {
    frozenRef.current = null;
  }
  const frozen = frozenRef.current;
  const activeScene = frozen ? frozen.scene : scene;
  const activeCanvasWidth = frozen ? frozen.width : canvasWidth;
  const activeCanvasHeight = frozen ? frozen.height : canvasHeight;
  /** While actively searching, the drawn route turns coral — the thing the city is revealing — reverting to the quiet idle color the moment searching ends. */
  const routeColor = searching ? colors.accent : colors.text;
  const growScale =
    frozen && growProgress
      ? growProgress.interpolate({ inputRange: [0, 1], outputRange: [1, frozen.growScaleEnd] })
      : null;

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) {
        setReduceMotion(enabled);
      }
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    presenceRef.current?.stop();
    if (reduceMotion) {
      streetPresence.setValue(searching || focused || normalizedWord.length > 0 ? 1 : 0);
      return;
    }
    presenceRef.current = Animated.timing(streetPresence, {
      toValue: searching || focused || normalizedWord.length > 0 ? 1 : 0,
      duration: 320,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    presenceRef.current.start();
    return () => {
      presenceRef.current?.stop();
    };
  }, [focused, normalizedWord, reduceMotion, searching, streetPresence]);

  useEffect(() => {
    searchLiftRef.current?.stop();
    if (!searching) {
      if (reduceMotion) {
        searchLift.setValue(0);
        return;
      }
      searchLiftRef.current = Animated.timing(searchLift, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      });
      searchLiftRef.current.start();
      return () => {
        searchLiftRef.current?.stop();
      };
    }
    if (reduceMotion) {
      searchLift.setValue(1);
      return;
    }
    searchLiftRef.current = Animated.timing(searchLift, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    searchLiftRef.current.start();
    return () => {
      searchLiftRef.current?.stop();
    };
  }, [reduceMotion, searchLift, searching]);

  /**
   * The ONE place that owns `progress`/`drawRef`. This used to be two
   * separate effects — an "initial draw" one keyed off the live canvas size,
   * and a "retrace loop" one keyed off `searching` — and they could fight
   * over the same ref: if the first ever re-fired while searching was true
   * (e.g. from an incidental layout re-measurement), it would call
   * drawRef.current?.stop() and start a one-shot animation with no
   * continuation, silently killing the loop after its first cycle. Merging
   * them into a single effect makes that impossible — there is exactly one
   * animation owner at a time, chosen by an explicit branch.
   */
  useEffect(() => {
    drawRef.current?.stop();
    if (activeCanvasWidth <= 0 || activeCanvasHeight <= 0) {
      return;
    }

    if (normalizedWord.length === 0) {
      if (reduceMotion) {
        progress.setValue(0);
        return;
      }
      drawRef.current = Animated.timing(progress, {
        toValue: 0,
        duration: 280,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      });
      drawRef.current.start();
      return () => {
        drawRef.current?.stop();
      };
    }

    if (reduceMotion) {
      progress.setValue(1);
      return;
    }

    if (!searching) {
      progress.setValue(0);
      drawRef.current = Animated.timing(progress, {
        toValue: 1,
        duration: drawDuration(normalizedWord.length),
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      });
      drawRef.current.start();
      return () => {
        drawRef.current?.stop();
      };
    }

    // Searching: draw → hold → draw → hold → … until searching goes false,
    // the component unmounts, or any dependency below changes.
    let cancelled = false;
    const retrace = () => {
      if (cancelled) {
        return;
      }
      progress.setValue(0);
      drawRef.current = Animated.timing(progress, {
        toValue: 1,
        duration: retraceDrawMs,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      });
      drawRef.current.start(({ finished }) => {
        if (!finished || cancelled) {
          return;
        }
        if (retraceHoldMs > 0) {
          drawRef.current = Animated.delay(retraceHoldMs);
          drawRef.current.start(({ finished: heldToEnd }) => {
            if (heldToEnd && !cancelled) {
              retrace();
            }
          });
          return;
        }
        retrace();
      });
    };
    retrace();
    return () => {
      cancelled = true;
      drawRef.current?.stop();
      progress.setValue(1);
    };
  }, [
    activeCanvasHeight,
    activeCanvasWidth,
    normalizedWord,
    progress,
    reduceMotion,
    retraceDrawMs,
    retraceHoldMs,
    searching,
  ]);

  function handleLayout(event: LayoutChangeEvent) {
    const next = event.nativeEvent.layout;
    if (next.width <= 0 || next.height <= 0) {
      return;
    }
    setMeasured((current) =>
      current.width === next.width && current.height === next.height
        ? current
        : { width: next.width, height: next.height },
    );
  }

  const label = normalizedWord
    ? `Streets forming ${normalizedWord}`
    : 'Quiet street map';

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      collapsable={false}
      style={[styles.canvas, { height, minHeight: height }, growScale && styles.canvasGrowing]}
      onLayout={handleLayout}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, growScale ? { transform: [{ scale: growScale }] } : null]}>
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: streetPresence.interpolate({
                inputRange: [0, 1],
                outputRange: [0.95, 1],
              }),
            },
          ]}>
          {activeScene.streets.map((street) => (
            <View
              key={street.key}
              style={[
                styles.stroke,
                {
                  left: street.left,
                  top: street.top,
                  width: street.length,
                  height: street.width,
                  opacity: street.opacity,
                  backgroundColor: colors.routeMuted,
                  transform: [{ rotate: `${street.angle}deg` }],
                },
              ]}
            />
          ))}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { opacity: searchLift }]}>
            {activeScene.streets.map((street) => (
              <View
                key={`search-${street.key}`}
                style={[
                  styles.stroke,
                  {
                    left: street.left,
                    top: street.top,
                    width: street.length,
                    height: street.width,
                    opacity: Math.min(street.opacity * 0.7, 0.14),
                    backgroundColor: colors.routeMuted,
                    transform: [{ rotate: `${street.angle}deg` }],
                  },
                ]}
              />
            ))}
          </Animated.View>
        </Animated.View>

        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {activeScene.route.map((segment) => (
            <RouteSegment
              key={`${normalizedWord}-${segment.key}`}
              segment={segment}
              progress={progress}
              styles={styles}
              color={routeColor}
            />
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

function RouteSegment({
  segment,
  progress,
  styles,
  color,
}: {
  segment: HomeSegment;
  progress: Animated.Value;
  styles: ReturnType<typeof createStyles>;
  color: string;
}) {
  const reveal = progress.interpolate({
    inputRange: [segment.startProgress, Math.max(segment.endProgress, segment.startProgress + 0.001)],
    outputRange: [-segment.length, 0],
    extrapolate: 'clamp',
  });
  return (
    <View
      style={[
        styles.routeClip,
        {
          left: segment.left,
          top: segment.top,
          width: segment.length,
          transform: [{ rotate: `${segment.angle}deg` }],
        },
      ]}>
      <Animated.View
        style={[
          styles.routeLine,
          {
            width: segment.length,
            backgroundColor: color,
            transform: [{ translateX: reveal }],
          },
        ]}
      />
    </View>
  );
}

function drawDuration(letterCount: number): number {
  if (letterCount <= 1) {
    return 780;
  }
  if (letterCount <= 3) {
    return 1040;
  }
  return 1280;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    canvas: {
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: colors.background,
      flexShrink: 0,
    },
    /** The frozen scene renders larger than the canvas's own (fixed) layout box while growing. */
    canvasGrowing: {
      overflow: 'visible',
    },
    stroke: {
      position: 'absolute',
      borderRadius: 1,
    },
    routeClip: {
      position: 'absolute',
      height: HOME_ROUTE_WIDTH,
      overflow: 'hidden',
      borderRadius: HOME_ROUTE_WIDTH / 2,
    },
    routeLine: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      borderRadius: HOME_ROUTE_WIDTH / 2,
      // backgroundColor is set per-segment (idle vs. searching color) — see RouteSegment.
    },
  });
}
