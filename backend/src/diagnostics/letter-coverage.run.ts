/**
 * DEVELOPMENT ONLY.
 *
 * npm run letter-coverage --prefix backend -- --label=before
 * Optional: --letters=ALOZ --locations=zamalek,alexandria --distances=2000
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LETTERS,
  LETTER_COVERAGE_DISTANCES,
  LETTER_COVERAGE_LOCATIONS,
  runLetterCoverageAudit,
} from './letter-coverage';

const args = parseArgs(process.argv.slice(2));
const label = args.label || 'coverage';
const requestedLetters = (args.letters || LETTERS.join(''))
  .toUpperCase()
  .split('')
  .filter((letter, index, all) => LETTERS.includes(letter) && all.indexOf(letter) === index);
const requestedLocationIds = (args.locations || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const locations =
  requestedLocationIds.length === 0
    ? LETTER_COVERAGE_LOCATIONS
    : LETTER_COVERAGE_LOCATIONS.filter((location) =>
        requestedLocationIds.includes(location.id),
      );
const requestedDistances = (args.distances || '')
  .split(',')
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0);
const distances =
  requestedDistances.length > 0
    ? requestedDistances
    : [...LETTER_COVERAGE_DISTANCES];

console.log('DEVELOPMENT / A-Z letter coverage audit');
console.log(
  `label=${label} letters=${requestedLetters.join('')} locations=${locations.map((item) => item.id).join(',')} distances=${distances.join(',')}`,
);
console.log('Production pipeline settings and product thresholds are unchanged.');

const report = await runLetterCoverageAudit({
  label,
  letters: requestedLetters,
  locations,
  distances,
  includeStability: args.stability !== 'false',
  onCase(item) {
    console.log(
      `${item.locationId.padEnd(15)} ${String(item.targetDistanceMeters).padStart(4)}m ${item.letter} ${item.status.padEnd(14)} graph=${String(item.graphFeasibleCandidates).padStart(2)} product=${String(item.productValidCandidates).padStart(2)} routed=${item.routedCandidates} ${item.elapsedMs}ms`,
    );
  },
});

const directory = dirname(fileURLToPath(import.meta.url));
const textPath = resolve(directory, `letter-coverage-${label}.txt`);
const jsonPath = resolve(directory, `letter-coverage-${label}.json`);
writeFileSync(textPath, report.textReport);
writeFileSync(jsonPath, JSON.stringify(report, null, 2));

console.log('');
console.log(report.textReport);
console.log('');
console.log(`text: ${textPath}`);
console.log(`json: ${jsonPath}`);

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (match?.[1]) {
      parsed[match[1]] = match[2] ?? '';
    }
  }
  return parsed;
}
