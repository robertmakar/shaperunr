import { Pressable, StyleSheet, Text, View } from 'react-native';

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
        height={210}
      />

      <View style={styles.body}>
        <View style={styles.meta}>
          <View style={styles.metaCopy}>
            <Text style={styles.routeLabel}>ROUTE {route.id}</Text>
            <Text style={styles.details}>
              {formatDistance(route.distanceKm)} · {formatDuration(route.durationMin)} · {route.difficulty}
            </Text>
          </View>

          <View style={styles.match}>
            <Text style={styles.matchValue}>{formatMatch(route.matchPercent)}</Text>
            <Text style={styles.matchLabel}>match</Text>
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use route ${route.id}`}
          onPress={onSelect}
          style={({ pressed }) => [styles.cta, pressed && styles.pressed]}>
          <Text style={styles.ctaText}>USE THIS ROUTE</Text>
          <Text style={styles.arrow}>→</Text>
        </Pressable>
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
    gap: spacing.lg,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  metaCopy: {
    flex: 1,
    gap: 6,
  },
  routeLabel: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  details: {
    ...typography.body,
    color: colors.text,
  },
  match: {
    alignItems: 'flex-end',
  },
  matchValue: {
    fontSize: 28,
    lineHeight: 32,
    fontWeight: '700',
    letterSpacing: -0.8,
    color: colors.text,
  },
  matchLabel: {
    ...typography.kicker,
    color: colors.textSecondary,
    marginTop: 2,
  },
  cta: {
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: colors.text,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  pressed: {
    opacity: 0.82,
  },
  ctaText: {
    ...typography.cta,
    color: colors.inverse,
  },
  arrow: {
    color: colors.inverse,
    fontSize: 18,
    marginTop: -1,
  },
});
