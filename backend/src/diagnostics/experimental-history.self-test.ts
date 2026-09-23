/**
 * DEVELOPMENT ONLY. Append-only history persistence tests.
 * Uses its own temp ndjson file — never touches the real
 * experimental-history.ndjson.
 */
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendExperimentalHistoryRecord, readExperimentalHistory } from './experimental-history';

type SelfTest = { name: string; passed: boolean; detail: string };

function tempPath(name: string): string {
  return join(tmpdir(), `shaperunr-experimental-history-self-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
}

const singlePath = tempPath('single');
appendExperimentalHistoryRecord({ word: 'L', ok: true }, singlePath);
const singleRead = readExperimentalHistory(50, singlePath);

const multiPath = tempPath('multi');
appendExperimentalHistoryRecord({ word: 'L', seq: 1 }, multiPath);
appendExperimentalHistoryRecord({ word: 'O', seq: 2 }, multiPath);
appendExperimentalHistoryRecord({ word: 'I', seq: 3 }, multiPath);
const multiRead = readExperimentalHistory(50, multiPath);
const multiReadLimited = readExperimentalHistory(2, multiPath);

const malformedPath = tempPath('malformed');
appendFileSync(malformedPath, '{"word":"L","seq":1}\nnot json at all\n{"word":"O","seq":2}\n', 'utf8');
const malformedRead = readExperimentalHistory(50, malformedPath);

const missingPath = tempPath('missing');
const missingRead = readExperimentalHistory(50, missingPath);

const tests: SelfTest[] = [
  {
    name: 'append then read returns exactly the one appended record',
    passed:
      singleRead.length === 1 &&
      existsSync(singlePath) &&
      (singleRead[0] as { word: string; ok: boolean }).word === 'L' &&
      (singleRead[0] as { word: string; ok: boolean }).ok === true,
    detail: JSON.stringify(singleRead),
  },
  {
    name: 'multiple appends never overwrite previous records',
    passed:
      multiRead.length === 3 &&
      (multiRead[0] as { seq: number }).seq === 1 &&
      (multiRead[1] as { seq: number }).seq === 2 &&
      (multiRead[2] as { seq: number }).seq === 3,
    detail: JSON.stringify(multiRead),
  },
  {
    name: 'a limit returns only the most recent records',
    passed:
      multiReadLimited.length === 2 &&
      (multiReadLimited[0] as { seq: number }).seq === 2 &&
      (multiReadLimited[1] as { seq: number }).seq === 3,
    detail: JSON.stringify(multiReadLimited),
  },
  {
    name: 'a malformed line is skipped without crashing the read',
    passed:
      malformedRead.length === 2 &&
      (malformedRead[0] as { seq: number }).seq === 1 &&
      (malformedRead[1] as { seq: number }).seq === 2,
    detail: JSON.stringify(malformedRead),
  },
  {
    name: 'reading a history file that does not exist yet returns an empty list, not an error',
    passed: missingRead.length === 0,
    detail: JSON.stringify(missingRead),
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}

for (const path of [singlePath, multiPath, malformedPath]) {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort cleanup only
  }
}
