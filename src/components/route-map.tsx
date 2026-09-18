import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

import { QUIET_MAP_STYLE } from '@/constants/map-style';
import { colors } from '@/constants/theme';
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
  overlays?: MapOverlay[];
  height?: number;
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function RouteMap({
  coordinates,
  start,
  end,
  userLocation,
  showUserLocation = false,
  overlays = [],
  height,
  interactive = false,
  style,
}: RouteMapProps) {
  const mapRef = useRef<MapView>(null);
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
        edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
        animated: false,
      });
    };

    requestAnimationFrame(fit);
    setTimeout(fit, 80);
  }, [coordinates, overlayPoints, userLocation]);

  useEffect(() => {
    fitRoute();
  }, [fitRoute]);

  return (
    <View style={[styles.frame, height ? { height } : styles.flex, style]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        mapType={Platform.OS === 'ios' ? 'mutedStandard' : 'standard'}
        userInterfaceStyle="light"
        customMapStyle={Platform.OS === 'android' ? QUIET_MAP_STYLE : undefined}
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
        showsUserLocation={showUserLocation}
        followsUserLocation={false}
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
            strokeColor={colors.text}
            strokeWidth={4}
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

const styles = StyleSheet.create({
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
    backgroundColor: colors.text,
  },
  endDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.text,
    backgroundColor: colors.inverse,
  },
});

