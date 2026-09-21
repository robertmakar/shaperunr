export function formatWord(value: string): string {
  return value.trim().toUpperCase();
}

export type DistanceUnit = 'km' | 'mi';

export const DISTANCE_UNITS: DistanceUnit[] = ['km', 'mi'];
export const DEFAULT_DISTANCE_UNIT: DistanceUnit = 'km';

const KM_PER_MILE = 1.609344;

/** Route generation, scoring, and every backend/Valhalla call stay in meters/km — this only converts for display. */
export function convertKmToUnit(km: number, unit: DistanceUnit): number {
  return unit === 'mi' ? km / KM_PER_MILE : km;
}

export function distanceUnitLabel(unit: DistanceUnit): string {
  return unit === 'mi' ? 'mi' : 'km';
}

export function distanceUnitName(unit: DistanceUnit): string {
  return unit === 'mi' ? 'Miles' : 'Kilometers';
}

/** Pace shares the same km/mi unit domain as distance, but is a separate, independently-selectable preference — see pace-unit-preference.ts. */
export function paceUnitName(unit: DistanceUnit): string {
  return unit === 'mi' ? 'min/mi' : 'min/km';
}

export function formatDistance(km: number, unit: DistanceUnit = 'km'): string {
  return `${convertKmToUnit(km, unit).toFixed(1)} ${distanceUnitLabel(unit)}`;
}

export function formatDuration(minutes: number): string {
  return `${minutes} min`;
}

export function formatMatch(percent: number): string {
  return `${percent}%`;
}

export function formatCoordinatePair(coordinate: { latitude: number; longitude: number }): string {
  if (!Number.isFinite(coordinate.latitude) || !Number.isFinite(coordinate.longitude)) {
    return 'Current location';
  }

  return `${coordinate.latitude.toFixed(4)}, ${coordinate.longitude.toFixed(4)}`;
}

const SHORT_MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

/** "21 SEP" — deliberately not locale-dependent (unlike `toLocaleDateString`), so it reads the same on every device. */
export function formatHistoryDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const month = SHORT_MONTHS[date.getMonth()] ?? '';
  return `${date.getDate()} ${month}`;
}

export function formatPace(distanceKm: number, durationMin: number, unit: DistanceUnit = 'km'): string {
  if (distanceKm <= 0) {
    return '–';
  }

  const minPerKm = durationMin / distanceKm;
  const minPerUnit = unit === 'mi' ? minPerKm * KM_PER_MILE : minPerKm;
  let minutes = Math.floor(minPerUnit);
  let seconds = Math.round((minPerUnit - minutes) * 60);

  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
