import { StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/primary-button';
import { RouteMap } from '@/components/route-map';
import type { MockRoute } from '@/constants/mock-routes';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { formatDistance, formatDuration, formatMatch } from '@/lib/format';
import type { Coordinate } from '@/lib/geo';

type RouteCardProps = {
  route: MockRoute;
  userLocation?: Coordinate;
  showUserLocation?: boolean;
  onSelect: () => void;
};

export function RouteCard({ route, userLocation, showUserLocation = false, onSelect }: RouteCardProps) {
  return (
    <View style={styles.card}>
      <RouteMap
        coordinates={route.coordinates}
        userLocation={userLocation}
        showUserLocation={showUserLocation}
        height={220}
      />

      <View style={styles.body}>
        <View style={styles.summary}>
          <View style={styles.match}>
            <Text style={styles.matchValue}>{formatMatch(route.matchPercent)}</Text>
            <Text style={styles.matchLabel}>MATCH</Text>
          </View>
          <View style={styles.details}>
            <Text style={styles.detail}>
              <Text style={styles.detailValue}>
                {formatDistance(route.distanceKm)}
              </Text>
              {'  TOTAL'}
            </Text>
            <Text style={styles.detail}>
              <Text style={styles.detailValue}>
                {formatDuration(route.durationMin)}
              </Text>
              {'  RUN'}
            </Text>
            <Text style={styles.detail}>
              <Text style={styles.detailValue}>{route.difficulty}</Text>
              {'  ROUTE'}
            </Text>
          </View>
        </View>

        <PrimaryButton
          label="USE THIS ROUTE"
          size="compact"
          onPress={onSelect}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    overflow: 'hidden',
  },
  body: {
    padding: spacing.lg,
    gap: spacing.xl,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xl,
  },
  match: {
    flex: 1,
    gap: spacing.xs,
  },
  matchValue: {
    ...typography.metricLarge,
    color: colors.accent,
  },
  matchLabel: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  details: {
    flex: 1.15,
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  detail: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  detailValue: {
    ...typography.meta,
    color: colors.text,
    textTransform: 'uppercase',
  },
});
