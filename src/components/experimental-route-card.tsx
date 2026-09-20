import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/primary-button';
import { RouteMap, type MapOverlay } from '@/components/route-map';
import { spacing, typography, type ThemeColors } from '@/constants/theme';
import { useDistanceUnit } from '@/hooks/use-distance-unit';
import { useThemeColors } from '@/hooks/use-theme';
import type { ExperimentalUserRoute } from '@/lib/experimental-routes-client';
import { formatDistance, formatMatch } from '@/lib/format';
import type { Coordinate } from '@/lib/geo';

/** 'expanded' is always the best route's full hero presentation; 'collapsed' is every other route's smaller, subordinate option — never interchangeable, no accordion. */
export type ExperimentalRouteCardVariant = 'expanded' | 'collapsed';

export type ExperimentalRouteCardProps = {
  route: ExperimentalUserRoute;
  userLocation?: Coordinate;
  showUserLocation?: boolean;
  variant: ExperimentalRouteCardVariant;
  /** "USE THIS ROUTE →" — calls selectRoute(route), navigating to Run with this exact route. */
  onSelect: () => void;
};

const EXPANDED_MAP_HEIGHT = 270;
/** Large enough to actually see the route's shape, not a postage-stamp tile. */
const COLLAPSED_MAP_HEIGHT = 130;
/**
 * A much tighter camera than the hero's default (regionForCoordinates'
 * paddingFactor 1.7 / fitToCoordinates' {44,36,44,36} edge padding) — at
 * this preview's smaller height, that default padding left the route
 * occupying only a sliver of the frame. Doesn't touch the hero's own
 * camera behavior, which still uses RouteMap's defaults.
 */
const COLLAPSED_REGION_PADDING_FACTOR = 1.15;
const COLLAPSED_FIT_EDGE_PADDING = { top: 10, right: 10, bottom: 10, left: 10 };
/** Below this, the connector leg is too short to be worth a line item. */
const CONNECTOR_DISPLAY_THRESHOLD_METERS = 15;

export function experimentalConnectorOverlay(connector: Coordinate[], colors: ThemeColors): MapOverlay[] {
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
  variant,
  onSelect,
}: ExperimentalRouteCardProps) {
  const [unit] = useDistanceUnit();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const shapeKm = route.shapeDistance / 1000;
  const totalKm = route.totalDistance / 1000;
  const connectorKm = route.connectorDistance / 1000;
  const matchPercent = Math.round(route.shapeScore * 100);
  const approximateMinutes = Math.max(1, Math.round(totalKm * 6.3));
  const showConnector = route.connectorDistance >= CONNECTOR_DISPLAY_THRESHOLD_METERS;
  const overlays = experimentalConnectorOverlay(route.connectorCoordinates, colors);

  if (variant === 'collapsed') {
    // A medium, passive list row — not a card, not a button, and it never
    // navigates on its own. Its own "USE THIS ROUTE" button below is the
    // only thing that selects this route.
    return (
      <View style={styles.collapsedRow}>
        <RouteMap
          coordinates={route.shapeCoordinates}
          userLocation={userLocation}
          showUserLocation={showUserLocation}
          overlays={overlays}
          height={COLLAPSED_MAP_HEIGHT}
          regionPaddingFactor={COLLAPSED_REGION_PADDING_FACTOR}
          fitEdgePadding={COLLAPSED_FIT_EDGE_PADDING}
        />
        <Text style={styles.collapsedMetaText}>
          {formatMatch(matchPercent)} MATCH  ·  {formatDistance(totalKm, unit)} · ~{approximateMinutes} MIN
        </Text>
        <PrimaryButton label="USE THIS ROUTE" size="small" onPress={onSelect} style={styles.collapsedCta} />
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <RouteMap
        coordinates={route.shapeCoordinates}
        userLocation={userLocation}
        showUserLocation={showUserLocation}
        overlays={overlays}
        height={EXPANDED_MAP_HEIGHT}
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
        <Text style={styles.kicker}>BEST MATCH</Text>

        <Text style={styles.matchValue}>
          {formatMatch(matchPercent)}
          <Text style={styles.matchUnit}> MATCH</Text>
        </Text>

        <Text style={styles.metaLine}>
          {formatDistance(totalKm, unit)} TOTAL · ~{approximateMinutes} MIN
        </Text>
        <Text style={styles.subMetaLine}>
          {formatDistance(shapeKm, unit)} SHAPE
          {showConnector ? `  ·  +${formatDistance(connectorKm, unit)} TO START` : ''}
        </Text>

        <PrimaryButton label="USE THIS ROUTE" size="compact" onPress={onSelect} style={styles.cta} />
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
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
    kicker: {
      ...typography.kicker,
      color: colors.accent,
    },
    matchValue: {
      fontWeight: '700',
      color: colors.accent,
      letterSpacing: -0.6,
      fontSize: 28,
      lineHeight: 32,
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
    collapsedRow: {
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    collapsedMetaText: {
      ...typography.meta,
      color: colors.text,
      textTransform: 'uppercase',
    },
    collapsedCta: {
      marginTop: spacing.xs,
    },
  });
}
