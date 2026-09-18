import { useMemo } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { RouteCard } from '@/components/route-card';
import { Screen } from '@/components/screen';
import { getMockRoutes } from '@/constants/mock-routes';
import { colors, spacing, typography } from '@/constants/theme';
import { formatWord } from '@/lib/format';
import { resolveStartCoordinate } from '@/lib/location';
import { readNumberParam, readOptionalNumberParam, readParam } from '@/lib/search-params';

export default function RoutesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    word?: string | string[];
    distance?: string | string[];
    latitude?: string | string[];
    longitude?: string | string[];
  }>();
  const word = formatWord(readParam(params.word));
  const requestedDistance = readNumberParam(params.distance, 4);
  const start = resolveStartCoordinate(
    readOptionalNumberParam(params.latitude),
    readOptionalNumberParam(params.longitude),
  );
  const routes = useMemo(
    () => getMockRoutes(requestedDistance, start.coordinate),
    [requestedDistance, start.coordinate.latitude, start.coordinate.longitude],
  );

  if (!word) {
    return <Redirect href="/" />;
  }

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
          <Text style={styles.kicker}>ROUTES NEAR YOU</Text>
          <Text style={styles.word}>{word}</Text>
          <Text style={styles.description}>We found a few ways to turn your run into {word}.</Text>
          {start.isFallback ? (
            <Text style={styles.fallback}>Using development location</Text>
          ) : null}
        </View>

        <View style={styles.list}>
          {routes.map((route) => (
            <RouteCard
              key={route.id}
              route={route}
              userLocation={start.isFallback ? undefined : start.coordinate}
              showUserLocation={!start.isFallback}
              onSelect={() => {
                router.push({
                  pathname: '/run',
                  params: {
                    word,
                    distance: String(route.distanceKm),
                    match: String(route.matchPercent),
                    duration: String(route.durationMin),
                    routeId: String(route.id),
                    ...(start.isFallback
                      ? {}
                      : {
                          latitude: String(start.coordinate.latitude),
                          longitude: String(start.coordinate.longitude),
                        }),
                  },
                });
              }}
            />
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.xl,
    gap: spacing.xxl,
  },
  header: {
    gap: spacing.sm,
  },
  kicker: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  word: {
    ...typography.display,
    color: colors.text,
    marginTop: spacing.xs,
  },
  description: {
    ...typography.body,
    color: colors.textSecondary,
    maxWidth: 280,
    marginTop: spacing.sm,
  },
  fallback: {
    ...typography.kicker,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  list: {
    gap: spacing.lg,
  },
});
