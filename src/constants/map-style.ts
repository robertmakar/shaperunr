import type { MapStyleElement } from 'react-native-maps';

/** Quiet, light Google Maps style used on Android. */
export const QUIET_MAP_STYLE: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#f4f3ef' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6f6f6f' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f4f3ef' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  {
    featureType: 'poi.park',
    elementType: 'geometry',
    stylers: [{ color: '#e4e3de' }, { visibility: 'on' }],
  },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#d8d7d2' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#ecebe6' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#d2d1cc' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
];

/**
 * Quiet, dark Google Maps style used on Android — the same relationships as
 * QUIET_MAP_STYLE (local roads pop lighter than the land, highways sit
 * closer to it, water reads as a distinct deep tone), mirrored into the
 * dark palette rather than simply inverted.
 */
export const QUIET_MAP_STYLE_DARK: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#111111' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8b8b8b' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#111111' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  {
    featureType: 'poi.park',
    elementType: 'geometry',
    stylers: [{ color: '#182019' }, { visibility: 'on' }],
  },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#242424' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#2c2c2c' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#1a1a1a' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a0a0c' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#8b8b8b' }] },
];
