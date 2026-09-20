import {
  convertKmToUnit,
  DEFAULT_DISTANCE_UNIT,
  distanceUnitLabel,
  distanceUnitName,
  formatDistance,
  formatDuration,
  formatMatch,
  formatPace,
  paceUnitName,
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
    name: 'unrelated formatters (duration/match) are untouched by this change',
    passed: formatDuration(24) === '24 min' && formatMatch(92) === '92%',
    detail: `${formatDuration(24)}, ${formatMatch(92)}`,
  });

  tests.push({
    name: 'formatPace defaults to min/km (backward compatible)',
    passed: formatPace(5, 30) === '6:00',
    detail: formatPace(5, 30),
  });

  tests.push({
    name: 'formatPace(km, mi, "km") is unchanged by round-tripping the unit',
    passed: formatPace(5, 30, 'km') === '6:00',
    detail: formatPace(5, 30, 'km'),
  });

  tests.push({
    name: 'formatPace converts an even min/km pace to min/mi correctly',
    // 5 min/km * 1.609344 km/mi = 8.0467.. min/mi -> 8:03
    passed: formatPace(10, 50, 'mi') === '8:03',
    detail: formatPace(10, 50, 'mi'),
  });

  tests.push({
    name: 'formatPace converts a non-even min/km pace to min/mi correctly',
    // 6 min/km * 1.609344 km/mi = 9.656.. min/mi -> 9:39
    passed: formatPace(5, 30, 'mi') === '9:39',
    detail: formatPace(5, 30, 'mi'),
  });

  tests.push({
    name: 'formatPace still guards against zero distance for both units',
    passed: formatPace(0, 30, 'km') === '–' && formatPace(0, 30, 'mi') === '–',
    detail: `${formatPace(0, 30, 'km')}, ${formatPace(0, 30, 'mi')}`,
  });

  tests.push({
    name: 'paceUnitName covers both units and is independent of distanceUnitName',
    passed: paceUnitName('km') === 'min/km' && paceUnitName('mi') === 'min/mi',
    detail: `${paceUnitName('km')}, ${paceUnitName('mi')}`,
  });

  return tests;
}
