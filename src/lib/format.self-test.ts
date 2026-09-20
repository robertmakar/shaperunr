import {
  convertKmToUnit,
  DEFAULT_DISTANCE_UNIT,
  distanceUnitLabel,
  distanceUnitName,
  formatDistance,
  formatDuration,
  formatMatch,
  formatPace,
} from './format';

type SelfTest = { name: string; passed: boolean; detail: string };

function approxEqual(a: number, b: number, epsilon = 0.001): boolean {
  return Math.abs(a - b) <= epsilon;
}

export function runFormatSelfTests(): SelfTest[] {
  const tests: SelfTest[] = [];

  tests.push({
    name: 'DEFAULT_DISTANCE_UNIT is km',
    passed: DEFAULT_DISTANCE_UNIT === 'km',
    detail: `default=${DEFAULT_DISTANCE_UNIT}`,
  });

  tests.push({
    name: 'formatDistance defaults to km (backward compatible)',
    passed: formatDistance(3.8) === '3.8 km',
    detail: formatDistance(3.8),
  });

  tests.push({
    name: 'formatDistance(km, "km") is unchanged by round-tripping the unit',
    passed: formatDistance(3.8, 'km') === '3.8 km',
    detail: formatDistance(3.8, 'km'),
  });

  const fiveKmInMiles = convertKmToUnit(5, 'mi');
  tests.push({
    name: 'convertKmToUnit converts km -> mi using the standard factor',
    passed: approxEqual(fiveKmInMiles, 3.10686),
    detail: `5 km -> ${fiveKmInMiles} mi`,
  });

  tests.push({
    name: 'convertKmToUnit is a no-op for km',
    passed: convertKmToUnit(5, 'km') === 5,
    detail: `5 km -> ${convertKmToUnit(5, 'km')} km`,
  });

  tests.push({
    name: 'formatDistance renders miles with the mi suffix',
    passed: formatDistance(5, 'mi') === '3.1 mi',
    detail: formatDistance(5, 'mi'),
  });

  tests.push({
    name: 'distanceUnitLabel/distanceUnitName cover both units',
    passed:
      distanceUnitLabel('km') === 'km' &&
      distanceUnitLabel('mi') === 'mi' &&
      distanceUnitName('km') === 'Kilometers' &&
      distanceUnitName('mi') === 'Miles',
    detail: `${distanceUnitLabel('km')}/${distanceUnitName('km')}, ${distanceUnitLabel('mi')}/${distanceUnitName('mi')}`,
  });

  tests.push({
    name: 'unrelated formatters (duration/match/pace) are untouched by this change',
    passed:
      formatDuration(24) === '24 min' &&
      formatMatch(92) === '92%' &&
      formatPace(5, 30) === '6:00',
    detail: `${formatDuration(24)}, ${formatMatch(92)}, ${formatPace(5, 30)}`,
  });

  return tests;
}
