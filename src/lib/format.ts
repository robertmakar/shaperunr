export function formatWord(value: string): string {
  return value.trim().toUpperCase();
}

export function formatDistance(km: number): string {
  return `${km.toFixed(1)} km`;
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

export function formatPace(distanceKm: number, durationMin: number): string {
  if (distanceKm <= 0) {
    return '–';
  }

  const minPerKm = durationMin / distanceKm;
  let minutes = Math.floor(minPerKm);
  let seconds = Math.round((minPerKm - minutes) * 60);

  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
