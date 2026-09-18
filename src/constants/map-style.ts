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
