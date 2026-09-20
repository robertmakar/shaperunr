import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

import { QUIET_MAP_STYLE, QUIET_MAP_STYLE_DARK } from '@/constants/map-style';
import type { ThemeColors } from '@/constants/theme';
import { useResolvedAppearance, useThemeColors } from '@/hooks/use-theme';
import { regionForCoordinates, type Coordinate } from '@/lib/geo';

/**
 * Shared map foundation for route cards, the run screen, and later live tracking.
 * Uses react-native-maps (Apple Maps on iOS, Google Maps on Android).
 */
export type MapOverlay = {
  coordinates: Coordinate[];
  strokeColor: string;
  strokeWidth?: number;
  lineDashPattern?: number[];
};

export type RouteMapProps = {
  coordinates: Coordinate[];
  start?: Coordinate;
  end?: Coordinate;
  userLocation?: Coordinate;
  showUserLocation?: boolean;
  followUser?: boolean;
  overlays?: MapOverlay[];
  height?: number;
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Multiplier applied to the route's own bounding box for the initial region (before `fitToCoordinates` corrects it). Defaults to `regionForCoordinates`'s own default — pass a smaller value for a tighter-framed preview. */
  regionPaddingFactor?: number;
  /** Screen-pixel padding used by `fitToCoordinates`. Defaults to the existing hero padding — pass smaller values for a shorter/narrower preview so the route still fills most of the frame. */
  fitEdgePadding?: { top: number; right: number; bottom: number; left: number };
};

export function RouteMap({
  coordinates,
  start,
  end,
  userLocation,
  showUserLocation = false,
  followUser = false,
  overlays = [],
  height,
  interactive = false,
  style,
  regionPaddingFactor,
  fitEdgePadding,
}: RouteMapProps) {
  const mapRef = useRef<MapView>(null);
  const colors = useThemeColors();
  const resolvedAppearance = useResolvedAppearance();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const startPoint = start ?? coordinates[0];
  const endPoint = end ?? coordinates[coordinates.length - 1];
  const overlayPoints = useMemo(
    () => overlays.flatMap((overlay) => overlay.coordinates),
    [overlays],
  );
  const region = regionForCoordinates(
    [
      ...coordinates,
      ...overlayPoints,
      ...(userLocation ? [userLocation] : []),
    ],
    regionPaddingFactor,
  );

  const fitRoute = useCallback(() => {
    const points = [
      ...coordinates,
      ...overlayPoints,
      ...(userLocation ? [userLocation] : []),
    ];
    if (points.length === 0) {
      return;
    }

    const fit = () => {
      mapRef.current?.fitToCoordinates(points, {
        edgePadding: fitEdgePadding ?? { top: 44, right: 36, bottom: 44, left: 36 },
        animated: false,
      });
    };

    requestAnimationFrame(fit);
    setTimeout(fit, 80);
  }, [coordinates, overlayPoints, userLocation, fitEdgePadding]);

  useEffect(() => {
    if (followUser) {
      return;
    }
    fitRoute();
  }, [fitRoute, followUser]);

  return (
    <View style={[styles.frame, height ? { height } : styles.flex, style]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        mapType={Platform.OS === 'ios' ? 'mutedStandard' : 'standard'}
        userInterfaceStyle={resolvedAppearance}
        customMapStyle={
          Platform.OS === 'android'
            ? resolvedAppearance === 'dark'
              ? QUIET_MAP_STYLE_DARK
              : QUIET_MAP_STYLE
            : undefined
        }
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        rotateEnabled={false}
        pitchEnabled={false}
        zoomControlEnabled={false}
        toolbarEnabled={false}
        showsCompass={false}
        showsScale={false}
        showsTraffic={false}
        showsIndoors={false}
        showsBuildings={false}
        showsPointsOfInterests={false}
        showsMyLocationButton={false}
        showsUserLocation={showUserLocation || followUser}
        followsUserLocation={followUser}
        moveOnMarkerPress={false}
        pointerEvents={interactive ? 'auto' : 'none'}
        onMapReady={fitRoute}>
        {overlays.map((overlay, index) =>
          overlay.coordinates.length > 1 ? (
            <Polyline
              key={`overlay-${index}`}
              coordinates={overlay.coordinates}
              strokeColor={overlay.strokeColor}
              strokeWidth={overlay.strokeWidth ?? 3}
              lineDashPattern={overlay.lineDashPattern}
              lineCap="round"
              lineJoin="round"
            />
          ) : null,
        )}

        {coordinates.length > 1 ? (
          <Polyline
            coordinates={coordinates}
            strokeColor={colors.accent}
            strokeWidth={5}
            lineCap="round"
            lineJoin="round"
          />
        ) : null}

        {startPoint ? (
          <Marker
            coordinate={startPoint}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
            title="Start">
            <View style={styles.startDot} />
          </Marker>
        ) : null}

        {endPoint &&
        (endPoint.latitude !== startPoint?.latitude ||
          endPoint.longitude !== startPoint?.longitude) ? (
          <Marker
            coordinate={endPoint}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
            title="End">
            <View style={styles.endDot} />
          </Marker>
        ) : null}
      </MapView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    frame: {
      overflow: 'hidden',
      backgroundColor: colors.surface,
    },
    flex: {
      flex: 1,
    },
    startDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: colors.accent,
      borderWidth: 2,
      borderColor: colors.inverse,
    },
    endDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.inverse,
    },
  });
}

