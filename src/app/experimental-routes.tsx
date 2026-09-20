import { useCallback, useEffect, useRef, useState } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { ExperimentalRouteCard } from '@/components/experimental-route-card';
import { FindingRouteAnimation } from '@/components/finding-route-animation';
import { PrimaryButton } from '@/components/primary-button';
import { Screen } from '@/components/screen';
import {
  ALEXANDRIA_DIAGNOSTIC_COORDINATE,
  DEBUG_FIXED_ALEXANDRIA,
} from '@/constants/experimental';
import { colors, spacing, typography } from '@/constants/theme';
import {
  experimentalNoMatchCopy,
  generateExperimentalRoutesFromBackend,
  type ExperimentalGenerateRoutesResponse,
} from '@/lib/experimental-routes-client';
import { takeExperimentalRoutesPrefetch } from '@/lib/experimental-routes-prefetch';
import { setSelectedExperimentalRoute } from '@/lib/experimental-route-session';
import { formatWord } from '@/lib/format';
import { resolveStartCoordinate } from '@/lib/location';
import { readNumberParam, readOptionalNumberParam, readParam } from '@/lib/search-params';

type Phase = 'loading' | 'ready' | 'empty' | 'error';

export default function ExperimentalRoutesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    word?: string | string[];
    distance?: string | string[];
    targetDistance?: string | string[];
    latitude?: string | string[];
    longitude?: string | string[];
  }>();
  const word = formatWord(readParam(params.word));
  const requestedDistanceKm = readNumberParam(params.distance, 2);
  const targetDistanceMeters =
    readOptionalNumberParam(params.targetDistance) ?? Math.round(requestedDistanceKm * 1000);
  const resolvedStart = resolveStartCoordinate(
    readOptionalNumberParam(params.latitude),
    readOptionalNumberParam(params.longitude),
  );
  const start = DEBUG_FIXED_ALEXANDRIA
    ? { coordinate: { ...ALEXANDRIA_DIAGNOSTIC_COORDINATE }, isFallback: false }
    : resolvedStart;

  const [phase, setPhase] = useState<Phase>('loading');
  const [result, setResult] = useState<ExperimentalGenerateRoutesResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('We couldn’t find a walkable route right now.');
  const [exitTarget, setExitTarget] = useState<Exclude<Phase, 'loading'> | null>(
    null,
  );
  const requestIdRef = useRef(0);

  const runSearch = useCallback(() => {
    if (!word) {
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setPhase('loading');
    setResult(null);
    setExitTarget(null);

    console.log('[find-my-route][results-screen]', {
      word,
      selectedDistanceKm: requestedDistanceKm,
      targetDistanceMeters,
      latitude: start.coordinate.latitude,
      longitude: start.coordinate.longitude,
      gpsLatitude: resolvedStart.coordinate.latitude,
      gpsLongitude: resolvedStart.coordinate.longitude,
      isFallback: start.isFallback,
      debugFixedAlexandria: DEBUG_FIXED_ALEXANDRIA,
    });
    console.log('[experimental-routes] start', {
      word,
      latitude: start.coordinate.latitude,
      longitude: start.coordinate.longitude,
      isFallback: start.isFallback,
      requestedDistanceKm,
      targetDistanceMeters,
    });

    const handleResponse = (response: Awaited<ReturnType<typeof generateExperimentalRoutesFromBackend>>) => {
      if (requestIdRef.current !== requestId) {
        console.log('[experimental-routes] dropped stale response', {
          ok: response.ok,
          status: response.ok ? response.data.status : response.code,
          routes: response.ok ? response.data.routes.length : 0,
          firstRouteId: response.ok ? response.data.routes[0]?.id : undefined,
        });
        return;
      }
      if (!response.ok) {
        console.log('[find-my-route][frontend-interpretation]', {
          ok: false,
          httpStatus: response.status,
          code: response.code,
          phase: 'error',
        });
        console.log('[experimental-routes] phase error', {
          httpStatus: response.status,
          code: response.code,
          message: response.message,
        });
        setErrorMessage(response.message);
        setExitTarget('error');
        return;
      }
      const nextPhase = response.data.status === 'ok' && response.data.routes.length > 0 ? 'ready' : 'empty';
      console.log('[find-my-route][frontend-interpretation]', {
        ok: true,
        jsonStatus: response.data.status,
        routes: response.data.routes.length,
        phase: nextPhase,
      });
      console.log('[experimental-routes] phase', {
        phase: nextPhase,
        jsonStatus: response.data.status,
        routes: response.data.routes.length,
        firstRouteId: response.data.routes[0]?.id,
      });
      setResult(response.data);
      setExitTarget(nextPhase);
    };

    // Home already ran this exact search inline while it played the
    // "finding" presentation — reuse that response instead of asking the
    // backend again for the same word/distance.
    const prefetched = takeExperimentalRoutesPrefetch(word, targetDistanceMeters);
    if (prefetched) {
      console.log('[experimental-routes] using prefetched response', { word, targetDistanceMeters });
      handleResponse(prefetched);
      return;
    }

    void generateExperimentalRoutesFromBackend({
      word,
      start: start.coordinate,
      targetDistanceMeters,
    }).then(handleResponse);
  }, [
    word,
    requestedDistanceKm,
    targetDistanceMeters,
    start.coordinate.latitude,
    start.coordinate.longitude,
    start.isFallback,
    resolvedStart.coordinate.latitude,
    resolvedStart.coordinate.longitude,
  ]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  if (!word) {
    return <Redirect href="/" />;
  }

  function goBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  function goHome() {
    router.replace('/');
  }

  if (phase === 'loading') {
    return (
      <Screen style={styles.loadingScreen}>
        <View style={styles.header}>
          <BackButton onPress={goBack} />
          <Text style={styles.kicker}>FINDING YOUR ROUTE</Text>
          <Text style={styles.loadingWord}>{word}</Text>
        </View>
        <FindingRouteAnimation
          word={word}
          exiting={exitTarget !== null}
          onExitComplete={() => {
            if (exitTarget) {
              setPhase(exitTarget);
              setExitTarget(null);
            }
          }}
        />
      </Screen>
    );
  }

  if (phase === 'empty' || (phase === 'ready' && (result?.routes.length ?? 0) === 0)) {
    const copy = experimentalNoMatchCopy(word);
    return (
      <Screen>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <BackButton onPress={goBack} />
            <Text style={styles.kicker}>ROUTES FOR</Text>
            <Text style={styles.word}>{word}</Text>
          </View>
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>NO ROUTES FOUND</Text>
            <Text style={styles.emptyBody}>{copy.body}</Text>
            <Text style={styles.tryLabel}>Try:</Text>
            {copy.tries.map((item) => (
              <Text key={item} style={styles.tryItem}>
                · {item}
              </Text>
            ))}
            <PrimaryButton label="TRY A DIFFERENT SEARCH" onPress={goHome} style={styles.emptyAction} />
          </View>
        </ScrollView>
      </Screen>
    );
  }

  if (phase === 'error') {
    return (
      <Screen>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <BackButton onPress={goBack} />
            <Text style={styles.kicker}>ROUTES FOR</Text>
            <Text style={styles.word}>{word}</Text>
          </View>
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>COULDN’T FIND A ROUTE</Text>
            <Text style={styles.emptyBody}>{errorMessage}</Text>
            <PrimaryButton label="TRY AGAIN" onPress={runSearch} style={styles.emptyAction} />
          </View>
        </ScrollView>
      </Screen>
    );
  }

  const routes = result?.routes ?? [];

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <BackButton onPress={goBack} />
          <Text style={styles.kicker}>ROUTES FOR</Text>
          <Text style={styles.word}>{word}</Text>
          <Text style={styles.description}>
            {routes.length} ROUTE{routes.length === 1 ? '' : 'S'} FOUND
          </Text>
        </View>

        <View style={styles.list}>
          {routes.map((route, index) => (
            <View key={route.id} style={index > 0 ? styles.secondaryCandidate : undefined}>
              <ExperimentalRouteCard
                route={route}
                variant={index === 0 ? 'hero' : 'compact'}
                userLocation={start.coordinate}
                showUserLocation
                onSelect={() => {
                  setSelectedExperimentalRoute({ ...route, word });
                  router.push({
                    pathname: '/run',
                    params: {
                      word,
                      experimental: '1',
                      routeId: route.id,
                      distance: String(route.totalDistance / 1000),
                      match: String(Math.round(route.shapeScore * 100)),
                      duration: String(Math.max(1, Math.round((route.totalDistance / 1000) * 6.3))),
                      latitude: String(start.coordinate.latitude),
                      longitude: String(start.coordinate.longitude),
                    },
                  });
                }}
              />
            </View>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.xxl,
    gap: spacing.xxl,
  },
  header: {
    gap: spacing.xs,
  },
  loadingScreen: {
    gap: spacing.xl,
  },
  kicker: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  word: {
    ...typography.display,
    color: colors.text,
    marginTop: spacing.xs,
  },
  loadingWord: {
    ...typography.title,
    color: colors.text,
    marginTop: spacing.xs,
  },
  description: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  list: {
    gap: spacing.xxl,
  },
  secondaryCandidate: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.xxl,
  },
  empty: {
    gap: spacing.sm,
    maxWidth: 320,
    paddingTop: spacing.xxxl,
  },
  emptyAction: {
    marginTop: spacing.xl,
  },
  emptyTitle: {
    ...typography.title,
    color: colors.text,
  },
  emptyBody: {
    ...typography.body,
    color: colors.textSecondary,
  },
  tryLabel: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginTop: spacing.lg,
  },
  tryItem: {
    ...typography.body,
    color: colors.text,
  },
});
