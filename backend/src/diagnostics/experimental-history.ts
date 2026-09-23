/**
 * DEVELOPMENT ONLY. Append-only diagnostic history for the experimental
 * route-generation pipeline — lets multiple requests, and eventually
 * multiple algorithm versions, be compared quantitatively.
 *
 * Deliberately simple: synchronous file append, one JSON object per line
 * (ndjson). This is a diagnostics log, not a production database — no
 * write queue, no rotation, no schema migration.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
export const EXPERIMENTAL_HISTORY_PATH = resolve(DIAGNOSTIC_DIR, 'experimental-history.ndjson');

/**
 * Best-effort, like every other diagnostics write in this codebase: a
 * failure here must never surface as a route-generation error, so it's
 * logged and swallowed rather than thrown.
 */
export function appendExperimentalHistoryRecord(record: unknown, path: string = EXPERIMENTAL_HISTORY_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    console.log('[experimental-history] append failed', error instanceof Error ? error.message : error);
  }
}

/**
 * Reads the most recent `limit` records. A malformed line (partial write,
 * hand-edited file) is skipped rather than failing the whole read — history
 * is diagnostics, not a source of truth, so a best-effort partial result is
 * preferable to an error.
 */
export function readExperimentalHistory(limit = 50, path: string = EXPERIMENTAL_HISTORY_PATH): unknown[] {
  try {
    if (!existsSync(path)) {
      return [];
    }
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const recent = lines.slice(-Math.max(0, limit));
    const records: unknown[] = [];
    for (const line of recent) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Skip a malformed line rather than failing the whole read.
      }
    }
    return records;
  } catch (error) {
    console.log('[experimental-history] read failed', error instanceof Error ? error.message : error);
    return [];
  }
}
