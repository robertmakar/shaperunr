import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { PrimaryButton } from '@/components/primary-button';
import { RouteMap } from '@/components/route-map';
import { RunStat } from '@/components/run-stat';
import { Screen } from '@/components/screen';
import { getRouteCoordinates } from '@/constants/mock-routes';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { formatMatch, formatPace, formatWord } from '@/lib/format';
import { resolveStartCoordinate } from '@/lib/location';
import { readNumberParam, readOptionalNumberParam, readParam } from '@/lib/search-params';

export default function RunScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    word?: string | string[];
    distance?: string | string[];
    match?: string | string[];
    duration?: string | string[];
    routeId?: string | string[];
    latitude?: string | string[];
    longitude?: string | string[];
  }>();

  const word = formatWord(readParam(params.word));
  const distanceKm = readNumberParam(params.distance, 0);
  const durationMin = readNumberParam(
    params.duration,
    Math.max(1, Math.round((distanceKm * 63) / 10)),
  );
  const matchPercent = readNumberParam(params.match, 0);
  const routeId = readNumberParam(params.routeId, 1);
  const start = resolveStartCoordinate(
    readOptionalNumberParam(params.latitude),
    readOptionalNumberParam(params.longitude),
  );
  const coordinates = getRouteCoordinates(routeId, start.coordinate);

  if (!word) {
    return <Redirect href="/" />;
  }

  return (
    <Screen style={styles.screen}>
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
        <Text style={styles.kicker}>DRAWING</Text>
        <Text style={styles.word}>{word}</Text>
        {matchPercent > 0 ? (
          <Text style={styles.match}>{formatMatch(matchPercent)} match</Text>
        ) : null}
      </View>

      <View style={styles.map}>
        <RouteMap
          coordinates={coordinates}
          userLocation={start.isFallback ? undefined : start.coordinate}
          showUserLocation={!start.isFallback}
          interactive
        />
      </View>

      <View style={styles.stats}>
        <RunStat value={distanceKm.toFixed(1)} label="KM" />
        <RunStat value={String(durationMin)} label="MIN" />
        <RunStat value={formatPace(distanceKm, durationMin)} label="/KM" />
      </View>

      <PrimaryButton label="START RUN" showArrow={false} onPress={() => {}} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    gap: spacing.xl,
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
  },
  match: {
    ...typography.body,
    color: colors.textSecondary,
  },
  map: {
    flex: 1,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.md,
  },
});
