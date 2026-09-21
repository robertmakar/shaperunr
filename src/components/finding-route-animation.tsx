import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  useWindowDimensions,
} from 'react-native';
import { useEffect, useMemo, useRef, useState } from 'react';

import { radii, spacing, typography, type ThemeColors } from '@/constants/theme';
import { useThemeColors } from '@/hooks/use-theme';
import { buildWordShape } from '@/lib/word-shape';
import type { Vec2 } from '@/lib/geometry';

type FindingRouteAnimationProps = {
  word: string;
  exiting?: boolean;
  onExitComplete?: () => void;
};

type Size = {
  width: number;
  height: number;
};

type Segment = {
  key: string;
  left: number;
  top: number;
  length: number;
  angle: number;
  startProgress: number;
  endProgress: number;
};

const DRAW_DURATION_MS = 3_200;
const ATTEMPT_HOLD_MS = 260;
const ATTEMPT_EXIT_MS = 320;
const SCREEN_EXIT_MS = 280;
const ROUTE_WIDTH = 6;

const BASE_STREET_LINES: Array<{
  points: Vec2[];
  width: number;
  opacity: number;
}> = [
  {
    points: [
      { x: 0.02, y: 0.14 },
      { x: 0.22, y: 0.18 },
      { x: 0.43, y: 0.13 },
      { x: 0.66, y: 0.2 },
      { x: 0.94, y: 0.15 },
    ],
    width: 1,
    opacity: 0.19,
  },
  {
    points: [
      { x: 0.05, y: 0.41 },
      { x: 0.26, y: 0.36 },
      { x: 0.49, y: 0.43 },
      { x: 0.7, y: 0.37 },
      { x: 0.96, y: 0.44 },
    ],
    width: 1.4,
    opacity: 0.21,
  },
  {
    points: [
      { x: 0.01, y: 0.73 },
      { x: 0.19, y: 0.67 },
      { x: 0.4, y: 0.75 },
      { x: 0.62, y: 0.69 },
      { x: 0.95, y: 0.76 },
    ],
    width: 1.1,
    opacity: 0.18,
  },
  {
    points: [
      { x: 0.13, y: 0.05 },
      { x: 0.17, y: 0.27 },
      { x: 0.11, y: 0.49 },
      { x: 0.2, y: 0.71 },
      { x: 0.16, y: 0.94 },
    ],
    width: 1,
    opacity: 0.17,
  },
  {
    points: [
      { x: 0.83, y: 0.04 },
      { x: 0.77, y: 0.25 },
      { x: 0.86, y: 0.48 },
      { x: 0.8, y: 0.67 },
      { x: 0.87, y: 0.92 },
    ],
    width: 1.2,
    opacity: 0.19,
  },
  {
    points: [
      { x: 0.28, y: 0.05 },
      { x: 0.38, y: 0.29 },
      { x: 0.34, y: 0.53 },
      { x: 0.45, y: 0.88 },
    ],
    width: 1,
    opacity: 0.16,
  },
];

const BLOCKS = [
  { left: '24%', top: '21%', width: '13%', height: '9%', rotate: '-4deg' },
  { left: '62%', top: '25%', width: '15%', height: '10%', rotate: '5deg' },
  { left: '55%', top: '72%', width: '14%', height: '9%', rotate: '-3deg' },
] as const;

export function FindingRouteAnimation({
  word,
  exiting = false,
  onExitComplete,
}: FindingRouteAnimationProps) {
  const window = useWindowDimensions();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [attempt, setAttempt] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const routeOpacity = useRef(new Animated.Value(0)).current;
  const routeScale = useRef(new Animated.Value(0.99)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onExitCompleteRef = useRef(onExitComplete);
  onExitCompleteRef.current = onExitComplete;

  const scene = useMemo(
    () => layoutScene(word, size, attempt),
    [attempt, size, word],
  );
  const mapHeight = Math.min(460, Math.max(390, Math.round(window.height * 0.53)));

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
    if (size.width === 0 || exiting) {
      return;
    }

    if (reduceMotion) {
      progress.setValue(1);
      routeOpacity.setValue(0.88);
      routeScale.setValue(1);
      return;
    }

    let mounted = true;

    const runAttempt = () => {
      progress.setValue(0);
      routeOpacity.setValue(0);
      routeScale.setValue(0.99);

      animationRef.current = Animated.sequence([
        Animated.parallel([
          Animated.timing(routeOpacity, {
            toValue: 1,
            duration: 260,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(routeScale, {
            toValue: 1,
            duration: DRAW_DURATION_MS,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(progress, {
            toValue: 1,
            duration: DRAW_DURATION_MS,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
        Animated.delay(ATTEMPT_HOLD_MS),
        Animated.parallel([
          Animated.timing(routeOpacity, {
            toValue: 0,
            duration: ATTEMPT_EXIT_MS,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(routeScale, {
            toValue: 1.012,
            duration: ATTEMPT_EXIT_MS,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ]);

      animationRef.current.start(({ finished }) => {
        if (!finished || !mounted) {
          return;
        }
        setAttempt((current) => current + 1);
        restartTimerRef.current = setTimeout(runAttempt, 32);
      });
    };

    runAttempt();

    return () => {
      mounted = false;
      animationRef.current?.stop();
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
      }
    };
  }, [
    exiting,
    progress,
    reduceMotion,
    routeOpacity,
    routeScale,
    size.width,
  ]);

  useEffect(() => {
    if (!exiting) {
      screenOpacity.setValue(1);
      return;
    }

    animationRef.current?.stop();
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
    }

    const exitAnimation = Animated.timing(screenOpacity, {
      toValue: 0,
      duration: reduceMotion ? 0 : SCREEN_EXIT_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    exitAnimation.start(({ finished }) => {
      if (finished) {
        onExitCompleteRef.current?.();
      }
    });

    return () => exitAnimation.stop();
  }, [exiting, reduceMotion, screenOpacity]);

  function handleLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }

  return (
    <Animated.View
      style={[styles.container, { opacity: screenOpacity }]}
      accessibilityLabel={`Finding a route for ${word}`}>
      <View
        style={[styles.mapField, { height: mapHeight }]}
        onLayout={handleLayout}>
        {BLOCKS.map((block, index) => (
          <View
            key={`block-${index}`}
            style={[
              styles.block,
              {
                left: block.left,
                top: block.top,
                width: block.width,
                height: block.height,
                transform: [{ rotate: block.rotate }],
              },
            ]}
          />
        ))}

        {scene.streets.map((street) => (
          <View
            key={street.key}
            style={[
              styles.street,
              {
                left: street.left,
                top: street.top,
                width: street.length,
                height: street.width,
                opacity: street.opacity,
                transform: [{ rotate: `${street.angle}deg` }],
              },
            ]}
          />
        ))}

        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.routeLayer,
            {
              opacity: routeOpacity,
              transform: [{ scale: routeScale }],
            },
          ]}>
          {scene.route.map((segment) => {
            const reveal = progress.interpolate({
              inputRange: [segment.startProgress, segment.endProgress],
              outputRange: [-segment.length, 0],
              extrapolate: 'clamp',
            });
            return (
              <View
                key={segment.key}
                style={[
                  styles.routeSegment,
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
                      transform: [{ translateX: reveal }],
                    },
                  ]}
                />
              </View>
            );
          })}
        </Animated.View>
      </View>

      <View style={styles.footer}>
        <Text style={styles.searching}>Searching the streets around you…</Text>
        <Text style={styles.status}>MAPPING YOUR SHAPE</Text>
      </View>
    </Animated.View>
  );
}

function layoutScene(
  word: string,
  size: Size,
  attempt: number,
): {
  route: Segment[];
  streets: Array<
    ReturnType<typeof pointsToSegments>[number] & {
      width: number;
      opacity: number;
    }
  >;
} {
  if (size.width === 0 || size.height === 0) {
    return { route: [], streets: [] };
  }
  const routePoints = layoutRoutePoints(word, size, attempt);
  const rawRoute = pointsToSegments(
    routePoints,
    `attempt-${attempt}`,
    ROUTE_WIDTH,
    2,
  );
  const totalLength = rawRoute.reduce(
    (sum, segment) => sum + segment.length,
    0,
  );
  const pauseIndices = new Set([
    Math.floor(rawRoute.length * 0.34),
    Math.floor(rawRoute.length * 0.68),
  ]);
  const pauseWeight = totalLength * 0.045;
  const timelineLength = totalLength + pauseWeight * pauseIndices.size;
  let traveled = 0;
  const route = rawRoute.map((segment, index) => {
    const startProgress = timelineLength > 0 ? traveled / timelineLength : 0;
    traveled += segment.length;
    const endProgress = timelineLength > 0 ? traveled / timelineLength : 1;
    if (pauseIndices.has(index)) {
      traveled += pauseWeight;
    }
    return {
      ...segment,
      startProgress,
      endProgress,
    };
  });

  const baseStreets = BASE_STREET_LINES.flatMap((line, lineIndex) =>
    pointsToSegments(
      line.points.map((point) => ({
        x: point.x * size.width,
        y: point.y * size.height,
      })),
      `street-${lineIndex}`,
      line.width,
    ).map((segment) => ({
      ...segment,
      width: line.width,
      opacity: line.opacity,
    })),
  );
  const branches = layoutConnectingStreets(routePoints, attempt);
  const selectedStreets = route.map((segment, index) => {
    const width = 1.8;
    return {
      ...segment,
      key: `selected-street-${attempt}-${index}`,
      top: segment.top + (ROUTE_WIDTH - width) / 2,
      width,
      opacity: 0.3,
    };
  });

  return {
    route,
    streets: [...baseStreets, ...branches, ...selectedStreets],
  };
}

function layoutRoutePoints(
  word: string,
  size: Size,
  attempt: number,
): Vec2[] {
  const normalizedWord = word
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 12);
  const targetAspectRatio =
    normalizedWord.length > 1
      ? Math.min(3.4, Math.max(1.8, normalizedWord.length * 0.78))
      : undefined;
  const shape = buildWordShape(word, {
    aspectRatio: targetAspectRatio,
    letterSpacing: 0.2,
    maxLetters: 12,
  });
  if (shape.points.length < 2) {
    return [];
  }

  const singleLetter = normalizedWord.length <= 1;
  const maxWidth = size.width * (singleLetter ? 0.6 : 0.82);
  const maxHeight = size.height * (singleLetter ? 0.64 : 0.42);
  const scale = Math.min(
    maxWidth / (shape.width || 1),
    maxHeight / (shape.height || 1),
  );
  const drawingWidth = shape.width * scale;
  const drawingHeight = shape.height * scale;
  const originX = (size.width - drawingWidth) / 2;
  const originY = (size.height - drawingHeight) / 2;
  const variant = attempt % 3;
  const sourceFirst = shape.points[0];
  const sourceLast = shape.points[shape.points.length - 1];
  const closed =
    Boolean(sourceFirst && sourceLast) &&
    sourceFirst?.x === sourceLast?.x &&
    sourceFirst?.y === sourceLast?.y;

  const targetPoints = shape.points.map((point, index) => {
    const phase = index * 1.73 + variant * 1.9;
    const direction = variant === 2 ? -1 : 1;
    return {
      x:
        originX +
        point.x * scale +
        Math.sin(phase) * 3.4 * direction,
      y:
        originY +
        (shape.height - point.y) * scale +
        Math.cos(phase * 0.83) * 2.6,
    };
  });
  if (closed && targetPoints[0] && targetPoints.length > 1) {
    targetPoints[targetPoints.length - 1] = { ...targetPoints[0] };
  }
  return softenIntoStreetPath(
    chamferStreetCorners(targetPoints, singleLetter ? 11 : 6),
    variant,
    singleLetter,
  );
}

function chamferStreetCorners(points: Vec2[], amount: number): Vec2[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 3) {
    return points;
  }

  const chamfered: Vec2[] = [first];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const next = points[index + 1];
    if (!previous || !point || !next) {
      continue;
    }
    const incomingLength = Math.hypot(
      point.x - previous.x,
      point.y - previous.y,
    );
    const outgoingLength = Math.hypot(next.x - point.x, next.y - point.y);
    if (incomingLength < 1 || outgoingLength < 1) {
      chamfered.push(point);
      continue;
    }
    const incoming = {
      x: (point.x - previous.x) / incomingLength,
      y: (point.y - previous.y) / incomingLength,
    };
    const outgoing = {
      x: (next.x - point.x) / outgoingLength,
      y: (next.y - point.y) / outgoingLength,
    };
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    if (dot > 0.88) {
      chamfered.push(point);
      continue;
    }
    const trim = Math.min(
      amount,
      incomingLength * 0.22,
      outgoingLength * 0.22,
    );
    chamfered.push(
      {
        x: point.x - incoming.x * trim,
        y: point.y - incoming.y * trim,
      },
      {
        x: point.x + outgoing.x * trim,
        y: point.y + outgoing.y * trim,
      },
    );
  }
  chamfered.push(last);
  return chamfered;
}

function softenIntoStreetPath(
  points: Vec2[],
  variant: number,
  singleLetter: boolean,
): Vec2[] {
  const softened: Vec2[] = [];
  const bendPattern = [-0.72, 0.38, -0.24, 0.64, -0.34] as const;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) {
      continue;
    }
    if (softened.length === 0) {
      softened.push(start);
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(length / 30));
    const normalX = length > 0 ? -dy / length : 0;
    const normalY = length > 0 ? dx / length : 0;

    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const patternIndex =
        (index + step + variant * 2) % bendPattern.length;
      const bend =
        step < steps
          ? (bendPattern[patternIndex] ?? 0) *
            (singleLetter ? 6.2 : 4.2)
          : 0;
      softened.push({
        x: start.x + dx * t + normalX * bend,
        y: start.y + dy * t + normalY * bend,
      });
    }
  }

  return softened;
}

function layoutConnectingStreets(points: Vec2[], attempt: number) {
  if (points.length < 3) {
    return [];
  }
  const stride = Math.max(2, Math.floor(points.length / 7));
  const branches: Array<
    ReturnType<typeof pointsToSegments>[number] & {
      width: number;
      opacity: number;
    }
  > = [];

  for (let index = stride; index < points.length - 1; index += stride) {
    const origin = points[index];
    if (!origin) {
      continue;
    }
    const direction =
      ((((index * 67 + attempt * 29) % 150) - 75) * Math.PI) / 180;
    const firstLength = 28 + ((index + attempt) % 3) * 6;
    const secondLength = 24 + ((index * 2 + attempt) % 4) * 5;
    const bend = direction + (((index + attempt) % 2 === 0 ? 1 : -1) * 0.38);
    const middle = {
      x: origin.x + Math.cos(direction) * firstLength,
      y: origin.y + Math.sin(direction) * firstLength,
    };
    const end = {
      x: middle.x + Math.cos(bend) * secondLength,
      y: middle.y + Math.sin(bend) * secondLength,
    };
    const width = index % 2 === 0 ? 1.7 : 1.5;
    branches.push(
      ...pointsToSegments(
        [origin, middle, end],
        `connector-${attempt}-${index}`,
        width,
      ).map((segment) => ({
        ...segment,
        width,
        opacity: 0.23,
      })),
    );
  }

  return branches;
}

function pointsToSegments(
  points: Vec2[],
  keyPrefix: string,
  strokeWidth = ROUTE_WIDTH,
  overlap = 0,
) {
  const segments: Array<{
    key: string;
    left: number;
    top: number;
    length: number;
    angle: number;
  }> = [];

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) {
      continue;
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const rawLength = Math.hypot(dx, dy);
    if (rawLength < 0.5) {
      continue;
    }
    const length = rawLength + overlap;
    segments.push({
      key: `${keyPrefix}-${index}`,
      left: (start.x + end.x) / 2 - length / 2,
      top: (start.y + end.y) / 2 - strokeWidth / 2,
      length,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return segments;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'center',
      gap: spacing.xl,
    },
    mapField: {
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: colors.background,
    },
    block: {
      position: 'absolute',
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.routeMuted,
      opacity: 0.18,
    },
    street: {
      position: 'absolute',
      borderRadius: 2,
      backgroundColor: colors.routeMuted,
    },
    routeLayer: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    routeSegment: {
      position: 'absolute',
      height: ROUTE_WIDTH,
      overflow: 'hidden',
      borderRadius: ROUTE_WIDTH / 2,
    },
    routeLine: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      borderRadius: ROUTE_WIDTH / 2,
      /** Coral, matching Home's own searching-state route — the thing being found, not just a generic drawn line. */
      backgroundColor: colors.accent,
    },
    footer: {
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    searching: {
      ...typography.body,
      color: colors.text,
    },
    status: {
      ...typography.kicker,
      color: colors.accent,
    },
  });
}
