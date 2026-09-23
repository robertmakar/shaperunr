/**
 * DEVELOPMENT ONLY. Shared-budget vs baseline benchmark, with fixed request
 * isolation.
 *
 * Compares, for each location × word × distance × repeat:
 *   baseline:   geometryVariants = ['smooth']
 *   experiment: geometryVariants = ['smooth', 'angular']  (shared top-96 —
 *               see runSharedBudgetGeometryPipeline)
 *
 * Both conditions use the exact same matrix, locations, repeats, and
 * feasibilityTop (96) — the experiment never gets its own separate budget.
 *
 * RELIABILITY FIX (this file's reason for existing as a separate script):
 * the previous benchmark (experimental-benchmark-geometry.ts) used a 45s
 * client-side timeout. Express/Node does not cancel an in-flight request
 * handler just because the client's fetch() aborts, so an abandoned
 * request kept running server-side, occasionally finishing during a LATER
 * request's window and getting misattributed by naive "newest ndjson line"
 * correlation, and occasionally saturating Valhalla enough to fail an
 * unrelated subsequent request's own health check. Per the task's explicit
 * guidance ("if there is no reliable way to detect server-side completion,
 * prefer a longer timeout"), this runner uses a much longer timeout
 * (BENCHMARK_TIMEOUT_MS) so legitimate requests — including the heaviest
 * CAIRO/4km/two-variant cases — normally complete rather than being
 * abandoned, which is what makes the sequential "await, then read the
 * newest ndjson line" correlation trustworthy again. Every request is still
 * given an explicit status (completed / timed_out / cancelled / failed);
 * only 'completed' cases enter aggregates.
 *
 * Run with: npm run benchmark:shared-budget --prefix backend
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config';
import type { ExperimentalHistoryRecord, PerVariantHistorySummary } from '../generation/experimental-diagnostics';
import { BENCHMARK_LOCATIONS, readApiErrorMessage, type BenchmarkLocation } from './experimental-benchmark';
import { readExperimentalHistory } from './experimental-history';
import { summarizeNumbers } from './stats';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Same words/distances as the geometry-variant benchmark's own matrix ("at minimum" set from this task), 1/2/4 km only (no 6km — the task explicitly scopes distances to "1km, 2km, 4km where reliable"). */
export const SHARED_BUDGET_WORD_DISTANCES: Record<string, number[]> = {
  I: [1000, 2000, 4000],
  O: [1000, 2000, 4000],
  R: [1000, 2000, 4000],
  ROBZ: [2000, 4000],
  CAIRO: [2000, 4000],
};

export const SHARED_BUDGET_REPEATS = 3;

/**
 * Deliberately much longer than the production client's own
 * EXPERIMENTAL_ROUTES_REQUEST_TIMEOUT_MS (45s, untouched) — this is the
 * benchmark runner's OWN timeout, per the task's explicit instruction not
 * to change the production API timeout. 3 minutes comfortably exceeds every
 * duration observed in prior benchmarks (worst case ~43s for a single
 * request under the OLD, more expensive dual-budget architecture; the
 * shared-budget experiment condition here does at most 96 graph searches
 * total, the same as baseline, not 192).
 */
export const BENCHMARK_TIMEOUT_MS = 180_000;

export type SharedBudgetCondition = 'baseline' | 'experiment';
const CONDITION_VARIANTS: Record<SharedBudgetCondition, Array<'smooth' | 'angular'>> = {
  baseline: ['smooth'],
  experiment: ['smooth', 'angular'],
};

export type SharedBudgetConfig = {
  location: BenchmarkLocation;
  word: string;
  targetDistanceMeters: number;
};

export function buildSharedBudgetConfigs(): SharedBudgetConfig[] {
  const configs: SharedBudgetConfig[] = [];
  for (const location of BENCHMARK_LOCATIONS) {
    for (const [word, distances] of Object.entries(SHARED_BUDGET_WORD_DISTANCES)) {
      for (const targetDistanceMeters of distances) {
        configs.push({ location, word, targetDistanceMeters });
      }
    }
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaseStatus = 'completed' | 'timed_out' | 'cancelled' | 'failed';
export type SharedBudgetOutcome = 'accepted' | 'no_viable_shape' | 'invalid_request' | 'server_error' | 'unexpected_error';

export type SharedBudgetRecord = {
  locationId: string;
  locationName: string;
  latitude: number;
  longitude: number;
  word: string;
  targetDistanceMeters: number;
  condition: SharedBudgetCondition;
  repeatIndex: 1 | 2 | 3;
  timestamp: string;
  algorithmVersion: string | null;
  durationMs: number;
  httpStatus: number | null;
  status: CaseStatus;
  outcome: SharedBudgetOutcome | null;
  errorMessage: string | null;
  routesReturned: number;
  /** Correlated from experimental-history.ndjson — see file header for why this is now trustworthy. Null for any non-'completed' status. */
  history: ExperimentalHistoryRecord | null;
};

// ---------------------------------------------------------------------------
// HTTP call with explicit status
// ---------------------------------------------------------------------------

type RawCallResult = {
  httpStatus: number | null;
  status: CaseStatus;
  outcome: SharedBudgetOutcome | null;
  errorMessage: string | null;
  routesReturned: number;
};

async function callWithStatus(input: {
  baseUrl: string;
  word: string;
  latitude: number;
  longitude: number;
  targetDistanceMeters: number;
  variants: Array<'smooth' | 'angular'>;
}): Promise<RawCallResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BENCHMARK_TIMEOUT_MS);
  try {
    const response = await fetch(`${input.baseUrl}/generate-routes-experimental`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        word: input.word,
        latitude: input.latitude,
        longitude: input.longitude,
        targetDistance: input.targetDistanceMeters,
        geometryVariants: input.variants,
      }),
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (parseError) {
      return {
        httpStatus: response.status,
        status: 'failed',
        outcome: 'unexpected_error',
        errorMessage: `Response was not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        routesReturned: 0,
      };
    }

    if (response.status === 400) {
      return { httpStatus: response.status, status: 'completed', outcome: 'invalid_request', errorMessage: readApiErrorMessage(payload), routesReturned: 0 };
    }
    if (response.status >= 500) {
      return { httpStatus: response.status, status: 'completed', outcome: 'server_error', errorMessage: readApiErrorMessage(payload), routesReturned: 0 };
    }
    if (!response.ok) {
      return { httpStatus: response.status, status: 'completed', outcome: 'unexpected_error', errorMessage: readApiErrorMessage(payload), routesReturned: 0 };
    }

    const body = payload as { status?: string; routes?: unknown[] };
    const routesReturned = Array.isArray(body.routes) ? body.routes.length : 0;
    if (body.status === 'ok') {
      return { httpStatus: response.status, status: 'completed', outcome: 'accepted', errorMessage: null, routesReturned };
    }
    if (body.status === 'no_viable_shape') {
      return { httpStatus: response.status, status: 'completed', outcome: 'no_viable_shape', errorMessage: null, routesReturned };
    }
    return {
      httpStatus: response.status,
      status: 'failed',
      outcome: 'unexpected_error',
      errorMessage: `Unrecognized response status: ${String(body.status)}`,
      routesReturned,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { httpStatus: null, status: 'timed_out', outcome: null, errorMessage: `Request exceeded ${BENCHMARK_TIMEOUT_MS} ms`, routesReturned: 0 };
    }
    return {
      httpStatus: null,
      status: 'failed',
      outcome: 'unexpected_error',
      errorMessage: error instanceof Error ? error.message : String(error),
      routesReturned: 0,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Main run — strictly sequential, one request at a time, next request only
// ever started after the previous one's status is known.
// ---------------------------------------------------------------------------

async function runSharedBudgetBenchmark(): Promise<SharedBudgetRecord[]> {
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const configs = buildSharedBudgetConfigs();
  const totalRequests = configs.length * SHARED_BUDGET_REPEATS * 2; // baseline + experiment
  console.log(
    `[shared-budget-benchmark] ${configs.length} configurations × ${SHARED_BUDGET_REPEATS} repeats × 2 conditions = ${totalRequests} requests, sequential, timeout ${BENCHMARK_TIMEOUT_MS} ms`,
  );

  const records: SharedBudgetRecord[] = [];
  let requestNumber = 0;

  for (const benchmarkConfig of configs) {
    for (let repeatIndex = 1; repeatIndex <= SHARED_BUDGET_REPEATS; repeatIndex += 1) {
      for (const condition of ['baseline', 'experiment'] as SharedBudgetCondition[]) {
        requestNumber += 1;
        const label = `${benchmarkConfig.location.name} ${benchmarkConfig.word} ${benchmarkConfig.targetDistanceMeters}m repeat${repeatIndex} [${condition}]`;
        console.log(`[shared-budget-benchmark] ${requestNumber}/${totalRequests} START  ${label}`);

        const historyBefore = readExperimentalHistory(Number.MAX_SAFE_INTEGER);
        const startedAt = Date.now();
        // Sequential by construction: this `await` blocks the loop — the
        // next iteration's `START` log line (and its request) cannot print
        // or fire until this one's result is fully known.
        const result = await callWithStatus({
          baseUrl,
          word: benchmarkConfig.word,
          latitude: benchmarkConfig.location.latitude,
          longitude: benchmarkConfig.location.longitude,
          targetDistanceMeters: benchmarkConfig.targetDistanceMeters,
          variants: CONDITION_VARIANTS[condition],
        });
        const durationMs = Date.now() - startedAt;

        let history: ExperimentalHistoryRecord | null = null;
        if (result.status === 'completed' && (result.outcome === 'accepted' || result.outcome === 'no_viable_shape')) {
          const historyAfter = readExperimentalHistory(Number.MAX_SAFE_INTEGER);
          const newRecords = historyAfter.slice(historyBefore.length) as ExperimentalHistoryRecord[];
          history = newRecords.length > 0 ? newRecords[newRecords.length - 1] ?? null : null;
        }

        const record: SharedBudgetRecord = {
          locationId: benchmarkConfig.location.id,
          locationName: benchmarkConfig.location.name,
          latitude: benchmarkConfig.location.latitude,
          longitude: benchmarkConfig.location.longitude,
          word: benchmarkConfig.word,
          targetDistanceMeters: benchmarkConfig.targetDistanceMeters,
          condition,
          repeatIndex: repeatIndex as 1 | 2 | 3,
          timestamp: new Date(startedAt).toISOString(),
          algorithmVersion: history?.algorithmVersion ?? null,
          durationMs,
          httpStatus: result.httpStatus,
          status: result.status,
          outcome: result.outcome,
          errorMessage: result.errorMessage,
          routesReturned: result.routesReturned,
          history,
        };
        records.push(record);

        console.log(
          `[shared-budget-benchmark] ${requestNumber}/${totalRequests} DONE   ${label} -> status=${result.status} outcome=${result.outcome ?? 'n/a'} (${durationMs} ms)${result.errorMessage ? ` [${result.errorMessage}]` : ''}`,
        );
      }
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function ensureDiagnosticDir(): void {
  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
}

function writeRawResults(records: SharedBudgetRecord[], generatedAt: Date): { timestampedPath: string; latestPath: string } {
  ensureDiagnosticDir();
  const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  const timestampedPath = resolve(DIAGNOSTIC_DIR, `experimental-benchmark-shared-budget-${stamp}.json`);
  const latestPath = resolve(DIAGNOSTIC_DIR, 'experimental-benchmark-shared-budget-results.json');
  const payload = {
    generatedAt: generatedAt.toISOString(),
    locations: BENCHMARK_LOCATIONS,
    wordDistances: SHARED_BUDGET_WORD_DISTANCES,
    repeats: SHARED_BUDGET_REPEATS,
    benchmarkTimeoutMs: BENCHMARK_TIMEOUT_MS,
    totalRequests: records.length,
    records,
  };
  const json = JSON.stringify(payload, null, 2);
  if (existsSync(timestampedPath)) {
    throw new Error(`Refusing to overwrite existing benchmark file: ${timestampedPath}`);
  }
  writeFileSync(timestampedPath, json, 'utf8');
  writeFileSync(latestPath, json, 'utf8');
  return { timestampedPath, latestPath };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const list = map.get(groupKey) ?? [];
    list.push(item);
    map.set(groupKey, list);
  }
  return map;
}

function fmt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(3);
}

function conditionBlock(records: SharedBudgetRecord[]): string[] {
  const completed = records.filter((record) => record.status === 'completed');
  const excluded = records.filter((record) => record.status !== 'completed');
  const lines: string[] = [`runs: ${records.length} (completed: ${completed.length}, excluded: ${excluded.length})`];
  if (excluded.length > 0) {
    const byStatus = groupBy(excluded, (record) => record.status);
    lines.push(`  excluded: ${[...byStatus.entries()].map(([status, list]) => `${status}=${list.length}`).join(', ')}`);
  }
  const withHistory = completed.map((record) => record.history).filter((history): history is ExperimentalHistoryRecord => history != null);
  if (withHistory.length === 0) {
    lines.push('no completed data with history');
    return lines;
  }
  for (const variant of ['smooth', 'angular'] as const) {
    const summaries = withHistory
      .map((history) => history.geometryVariants[variant])
      .filter((summary): summary is PerVariantHistorySummary => summary != null);
    if (summaries.length === 0) {
      continue;
    }
    const graphFeasible = summaries.reduce((sum, s) => sum + s.graphFeasibleCount, 0);
    const routed = summaries.reduce((sum, s) => sum + s.routedCount, 0);
    const accepted = summaries.reduce((sum, s) => sum + s.acceptedCount, 0);
    lines.push(`  ${variant}: graphFeasible=${graphFeasible} routed=${routed} accepted=${accepted}`);
    lines.push(
      `    shapeScore median=${fmt(summarizeNumbers(summaries.map((s) => s.shapeScore.median).filter((v): v is number => v != null)).median)}` +
        ` coverage median=${fmt(summarizeNumbers(summaries.map((s) => s.coverage.median).filter((v): v is number => v != null)).median)}` +
        ` order median=${fmt(summarizeNumbers(summaries.map((s) => s.order.median).filter((v): v is number => v != null)).median)}`,
    );
    lines.push(
      `    targetSpan median=${fmt(summarizeNumbers(summaries.map((s) => s.targetSpan.median).filter((v): v is number => v != null)).median)}` +
        ` backtrack median=${fmt(summarizeNumbers(summaries.map((s) => s.backtrack.median).filter((v): v is number => v != null)).median)}` +
        ` shape/target median=${fmt(summarizeNumbers(summaries.map((s) => s.shapeTargetRatio.median).filter((v): v is number => v != null)).median)}` +
        ` route/target median=${fmt(summarizeNumbers(summaries.map((s) => s.routeTargetRatio.median).filter((v): v is number => v != null)).median)}`,
    );
    const wordy = summaries.filter((s) => s.wordTraversalPassRate != null);
    if (wordy.length > 0) {
      const passed = wordy.reduce((sum, s) => sum + (s.wordTraversalPassRate?.passed ?? 0), 0);
      const totalCount = wordy.reduce((sum, s) => sum + (s.wordTraversalPassRate?.total ?? 0), 0);
      lines.push(`    wordTraversal ${passed}/${totalCount}`);
    }
  }
  const durations = completed.map((record) => record.durationMs);
  if (durations.length > 0) {
    lines.push(
      `  duration: avg=${fmt(durations.reduce((a, b) => a + b, 0) / durations.length)}ms min=${Math.min(...durations)}ms max=${Math.max(...durations)}ms`,
    );
  }
  return lines;
}

function buildSummary(records: SharedBudgetRecord[]): string {
  const lines: string[] = [
    'ShapeRunr shared-budget benchmark (DEVELOPMENT ONLY): baseline (smooth) vs experiment (smooth+angular, shared top-96)',
    'Measurement only.',
    `generated from ${records.length} requests`,
    '',
  ];

  const byLocation = groupBy(records, (record) => record.locationName);
  for (const [locationName, locationRecords] of byLocation) {
    lines.push(locationName.toUpperCase());
    const byWord = groupBy(locationRecords, (record) => record.word);
    for (const [word, wordRecords] of byWord) {
      lines.push(`  ${word}`);
      const byDistance = groupBy(wordRecords, (record) => record.targetDistanceMeters);
      for (const [distance, distanceRecords] of byDistance) {
        lines.push(`    ${distance}m`);
        const byCondition = groupBy(distanceRecords, (record) => record.condition);
        for (const condition of ['baseline', 'experiment'] as SharedBudgetCondition[]) {
          const conditionRecords = byCondition.get(condition) ?? [];
          lines.push(`      ${condition}:`);
          lines.push(...conditionBlock(conditionRecords).map((line) => `        ${line}`));
        }
      }
    }
    lines.push('');
  }

  lines.push('=== OVERALL ===');
  const statusCounts = groupBy(records, (record) => record.status);
  lines.push(`total requests: ${records.length}`);
  for (const [status, list] of statusCounts) {
    lines.push(`  ${status}: ${list.length}`);
  }
  for (const condition of ['baseline', 'experiment'] as SharedBudgetCondition[]) {
    const conditionRecords = records.filter((record) => record.condition === condition);
    lines.push(`${condition}:`);
    lines.push(...conditionBlock(conditionRecords).map((line) => `  ${line}`));
  }

  return lines.join('\n');
}

export { runSharedBudgetBenchmark, writeRawResults, buildSummary, callWithStatus };

if (import.meta.url === `file://${process.argv[1]}`) {
  const started = Date.now();
  const records = await runSharedBudgetBenchmark();
  const generatedAt = new Date();
  const { timestampedPath, latestPath } = writeRawResults(records, generatedAt);
  const summaryText = buildSummary(records);
  const summaryPath = resolve(DIAGNOSTIC_DIR, 'experimental-benchmark-shared-budget-summary.txt');
  writeFileSync(summaryPath, summaryText, 'utf8');

  const completed = records.filter((record) => record.status === 'completed').length;
  const excluded = records.length - completed;
  console.log('');
  console.log(
    `[shared-budget-benchmark] done in ${Math.round((Date.now() - started) / 1000)}s — ${records.length} requests, ${completed} completed, ${excluded} excluded (timed_out/cancelled/failed)`,
  );
  console.log(`[shared-budget-benchmark] raw results: ${timestampedPath}`);
  console.log(`[shared-budget-benchmark] latest copy: ${latestPath}`);
  console.log(`[shared-budget-benchmark] summary: ${summaryPath}`);
}
