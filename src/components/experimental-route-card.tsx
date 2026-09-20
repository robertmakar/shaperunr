import { StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/primary-button';
import { RouteMap, type MapOverlay } from '@/components/route-map';
import { colors, spacing, typography } from '@/constants/theme';
import type { ExperimentalUserRoute } from '@/lib/experimental-routes-client';
import { formatDistance, formatMatch } from '@/lib/format';
import type { Coordinate } from '@/lib/geo';

export type ExperimentalRouteCardVariant = 'hero' | 'compact';

type ExperimentalRouteCardProps = {
  route: ExperimentalUserRoute;
  userLocation?: Coordinate;
  showUserLocation?: boolean;
  variant?: ExperimentalRouteCardVariant;
  onSelect: () => void;
};

const HERO_MAP_HEIGHT = 270;
const COMPACT_MAP_HEIGHT = 230;
/** Below this, the connector leg is too short to be worth a line item. */
const CONNECTOR_DISPLAY_THRESHOLD_METERS = 15;

export function experimentalConnectorOverlay(connector: Coordinate[]): MapOverlay[] {
  if (connector.length < 2) {
    return [];
  }
  return [
    {
      coordinates: connector,
      strokeColor: colors.routeMuted,
      strokeWidth: 2,
      lineDashPattern: [6, 7],
    },
  ];
}

export function ExperimentalRouteCard({
  route,
  userLocation,
  showUserLocation = false,
  variant = 'compact',
  onSelect,
}: ExperimentalRouteCardProps) {
  const isHero = variant === 'hero';
  const shapeKm = route.shapeDistance / 1000;
  const totalKm = route.totalDistance / 1000;
  const connectorKm = route.connectorDistance / 1000;
  const matchPercent = Math.round(route.shapeScore * 100);
  const approximateMinutes = Math.max(1, Math.round(totalKm * 6.3));
  const showConnector = route.connectorDistance >= CONNECTOR_DISPLAY_THRESHOLD_METERS;

  return (
    <View style={styles.card}>
      <RouteMap
        coordinates={route.shapeCoordinates}
        userLocation={userLocation}
        showUserLocation={showUserLocation}
        overlays={experimentalConnectorOverlay(route.connectorCoordinates)}
        height={isHero ? HERO_MAP_HEIGHT : COMPACT_MAP_HEIGHT}
      />

      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={styles.legendSwatchShape} />
          <Text style={styles.legendLabel}>SHAPE</Text>
        </View>
        {showConnector ? (
          <View style={styles.legendItem}>
            <View style={styles.legendSwatchConnector} />
            <Text style={styles.legendLabel}>CONNECTOR TO START</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        {isHero ? <Text style={styles.bestKicker}>BEST MATCH</Text> : null}

        <Text style={[styles.matchValue, isHero ? styles.matchValueHero : styles.matchValueCompact]}>
          {formatMatch(matchPercent)}
          <Text style={styles.matchUnit}> MATCH</Text>
        </Text>

        <Text style={styles.metaLine}>
          {formatDistance(totalKm)} TOTAL · ~{approximateMinutes} MIN
        </Text>
        <Text style={styles.subMetaLine}>
          {formatDistance(shapeKm)} SHAPE
          {showConnector ? `  ·  +${connectorKm.toFixed(1)} KM TO START` : ''}
        </Text>

        <PrimaryButton label="USE THIS ROUTE" size="compact" onPress={onSelect} style={styles.cta} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
  },
  legend: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  legendSwatchShape: {
    width: 14,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.accent,
  },
  legendSwatchConnector: {
    width: 14,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.routeMuted,
  },
  legendLabel: {
    ...typography.microLabel,
    color: colors.textMuted,
  },
  body: {
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  bestKicker: {
    ...typography.kicker,
    color: colors.accent,
  },
  matchValue: {
    fontWeight: '700',
    color: colors.accent,
    letterSpacing: -0.6,
  },
  matchValueHero: {
    fontSize: 28,
    lineHeight: 32,
  },
  matchValueCompact: {
    fontSize: 22,
    lineHeight: 26,
  },
  matchUnit: {
    ...typography.kicker,
    color: colors.textSecondary,
  },
  metaLine: {
    ...typography.meta,
    color: colors.text,
    textTransform: 'uppercase',
  },
  subMetaLine: {
    ...typography.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
  },
  cta: {
    marginTop: spacing.sm,
  },
});
