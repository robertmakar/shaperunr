/**
 * DEVELOPMENT ONLY. Geometry-variant comparison benchmark.
 *
 * Reuses the same locations, repeat count, request timeout, HTTP endpoint,
 * sequential-execution methodology, and outcome/failure-stage classification
 * as experimental-benchmark.ts, so results stay directly comparable. The
 * one difference: each request asks the endpoint to search BOTH 'smooth'
 * and 'angular' geometry in a single call (geometryVariants in the request
 * body — see routes/generate-routes-experimental.ts), which shares one
 * street-graph collection between the two variants and lets the resulting
 * per-variant breakdown (experimental-history.ndjson's `geometryVariants`
 * field) be read back directly, the same correlation technique used by
 * experimental-benchmark.ts.
 *
 * This file changes no placement, search, scoring, or product-gate
 * parameter — it only calls the existing HTTP endpoint with the existing
 * geometryVariants option added in this task.
 *
 * Run with: npm run benchmark:geometry --prefix backend
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config';
import type { ExperimentalHistoryRecord, PerVariantHistorySummary } from '../generation/experimental-diagnostics';
import {
  BENCHMARK_LOCATIONS,
  BENCHMARK_REPEATS,
  BENCHMARK_REQUEST_TIMEOUT_MS,
  classifyFailureStage,
  readApiErrorMessage,
  type BenchmarkFailureStage,
  type BenchmarkLocation,
  type BenchmarkOutcome,
} from './experimental-benchmark';
import { readExperimentalHistory } from './experimental-history';
import { summarizeNumbers } from './stats';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

/** Deliberately smaller than the full baseline matrix (section 7 asks for "at minimum" this set). Every word here is also present in the baseline matrix, so per-word numbers can be sanity-checked against it. */
export const GEOMETRY_BENCHMARK_WORD_DISTANCES: Record<string, number[]> = {
  I: [1000, 2000],
  O: [1000, 2000],
  R: [1000, 2000],
  ROBZ: [2000, 4000],
  CAIRO: [2000, 4000],
};

export const GEOMETRY_VARIANTS_UNDER_TEST: Array<'smooth' | 'angular'> = ['smooth', 'angular'];

export type GeometryBenchmarkConfig = {
  location: BenchmarkLocation;
  word: string;
  targetDistanceMeters: number;
};

export function buildGeometryBenchmarkConfigs(): GeometryBenchmarkConfig[] {
  const configs: GeometryBenchmarkConfig[] = [];
  for (const location of BENCHMARK_LOCATIONS) {
    for (const [word, distances] of Object.entries(GEOMETRY_BENCHMARK_WORD_DISTANCES)) {
      for (const targetDistanceMeters of distances) {
        configs.push({ location, word, targetDistanceMeters });
      }
    }
  }
  return configs;
}

export type GeometryBenchmarkRecord = {
  locationId: string;
  locationName: string;
  latitude: number;
  longitude: number;
  word: string;
  targetDistanceMeters: number;
  repeatIndex: 1 | 2 | 3;
  timestamp: string;
  algorithmVersion: string | null;
  durationMs: number;
  httpStatus: number | null;
  outcome: BenchmarkOutcome;
  failureStage: BenchmarkFailureStage;
  errorMessage: string | null;
  routesReturned: number;
  /** Per-variant breakdown correlated from experimental-history.ndjson (see file header) — null when the request never reached the pipeline. */
  geometryVariants: Record<string, PerVariantHistorySummary> | null;
};

type RawCallResult = {
  httpStatus: number | null;
  outcome: BenchmarkOutcome;
  errorMessage: string | null;
  routesReturned: number;
};

async function callExperimentalEndpointWithVariants(input: {
  baseUrl: string;
  word: string;
  latitude: number;
  longitude: number;
  targetDistanceMeters: number;
}): Promise<RawCallResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BENCHMARK_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${input.baseUrl}/generate-routes-experimental`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        word: input.word,
        latitude: input.latitude,
        longitude: input.longitude,
        targetDistance: input.targetDistanceMeters,
        geometryVariants: GEOMETRY_VARIANTS_UNDER_TEST,
      }),
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (parseError) {
      return {
        httpStatus: response.status,
        outcome: 'unexpected_error',
        errorMessage: `Response was not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        routesReturned: 0,
      };
    }

    if (response.status === 400) {
      return { httpStatus: response.status, outcome: 'invalid_request', errorMessage: readApiErrorMessage(payload), routesReturned: 0 };
    }
    if (response.status >= 500) {
      return { httpStatus: response.status, outcome: 'server_error', errorMessage: readApiErrorMessage(payload), routesReturned: 0 };
    }
    if (!response.ok) {
      return { httpStatus: response.status, outcome: 'unexpected_error', errorMessage: readApiErrorMessage(payload), routesReturned: 0 };
    }

    const body = payload as { status?: string; routes?: unknown[] };
    const routesReturned = Array.isArray(body.routes) ? body.routes.length : 0;
    if (body.status === 'ok') {
      return { httpStatus: response.status, outcome: 'accepted', errorMessage: null, routesReturned };
    }
    if (body.status === 'no_viable_shape') {
      return { httpStatus: response.status, outcome: 'no_viable_shape', errorMessage: null, routesReturned };
    }
    return {
      httpStatus: response.status,
      outcome: 'unexpected_error',
      errorMessage: `Unrecognized response status: ${String(body.status)}`,
      routesReturned,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { httpStatus: null, outcome: 'timeout', errorMessage: `Request exceeded ${BENCHMARK_REQUEST_TIMEOUT_MS} ms`, routesReturned: 0 };
    }
    return {
      httpStatus: null,
      outcome: 'unexpected_error',
      errorMessage: error instanceof Error ? error.message : String(error),
      routesReturned: 0,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runGeometryBenchmark(): Promise<GeometryBenchmarkRecord[]> {
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const configs = buildGeometryBenchmarkConfigs();
  const totalRequests = configs.length * BENCHMARK_REPEATS;
  console.log(
    `[geometry-benchmark] ${configs.length} configurations × ${BENCHMARK_REPEATS} repeats = ${totalRequests} requests, sequential, variants=${GEOMETRY_VARIANTS_UNDER_TEST.join('+')}`,
  );

  const records: GeometryBenchmarkRecord[] = [];
  let requestNumber = 0;

  for (const benchmarkConfig of configs) {
    for (let repeatIndex = 1; repeatIndex <= BENCHMARK_REPEATS; repeatIndex += 1) {
      requestNumber += 1;
      const historyBefore = readExperimentalHistory(Number.MAX_SAFE_INTEGER);
      const startedAt = Date.now();
      const result = await callExperimentalEndpointWithVariants({
        baseUrl,
        word: benchmarkConfig.word,
        latitude: benchmarkConfig.location.latitude,
        longitude: benchmarkConfig.location.longitude,
        targetDistanceMeters: benchmarkConfig.targetDistanceMeters,
      });
      const durationMs = Date.now() - startedAt;
      const historyAfter = readExperimentalHistory(Number.MAX_SAFE_INTEGER);
      const newHistoryRecords = historyAfter.slice(historyBefore.length) as ExperimentalHistoryRecord[];
      const history = newHistoryRecords.length > 0 ? newHistoryRecords[newHistoryRecords.length - 1] ?? null : null;
      const failureStage = classifyFailureStage(result.outcome, history);

      const record: GeometryBenchmarkRecord = {
        locationId: benchmarkConfig.location.id,
        locationName: benchmarkConfig.location.name,
        latitude: benchmarkConfig.location.latitude,
        longitude: benchmarkConfig.location.longitude,
        word: benchmarkConfig.word,
        targetDistanceMeters: benchmarkConfig.targetDistanceMeters,
        repeatIndex: repeatIndex as 1 | 2 | 3,
        timestamp: new Date(startedAt).toISOString(),
        algorithmVersion: history?.algorithmVersion ?? null,
        durationMs,
        httpStatus: result.httpStatus,
        outcome: result.outcome,
        failureStage,
        errorMessage: result.errorMessage,
        routesReturned: result.routesReturned,
        geometryVariants: history?.geometryVariants ?? null,
      };
      records.push(record);

      console.log(
        `[geometry-benchmark] ${requestNumber}/${totalRequests} ${benchmarkConfig.location.name} ${benchmarkConfig.word} ${benchmarkConfig.targetDistanceMeters}m repeat${repeatIndex} -> ${result.outcome} (${durationMs} ms)${result.errorMessage ? ` [${result.errorMessage}]` : ''}`,
      );
    }
  }

  return records;
}

function ensureDiagnosticDir(): void {
  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
}

function writeRawResults(records: GeometryBenchmarkRecord[], generatedAt: Date): { timestampedPath: string; latestPath: string } {
  ensureDiagnosticDir();
  const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  const timestampedPath = resolve(DIAGNOSTIC_DIR, `experimental-benchmark-geometry-${stamp}.json`);
  const latestPath = resolve(DIAGNOSTIC_DIR, 'experimental-benchmark-geometry-results.json');
  const payload = {
    generatedAt: generatedAt.toISOString(),
    locations: BENCHMARK_LOCATIONS,
    wordDistances: GEOMETRY_BENCHMARK_WORD_DISTANCES,
    geometryVariantsUnderTest: GEOMETRY_VARIANTS_UNDER_TEST,
    repeats: BENCHMARK_REPEATS,
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

function buildGeometrySummary(records: GeometryBenchmarkRecord[]): string {
  const lines: string[] = [
    'ShapeRunr geometry-variant benchmark (DEVELOPMENT ONLY): smooth vs angular',
    'Measurement only — no placement/search/scoring/product-gate parameter was changed for this comparison.',
    `generated from ${records.length} requests (${records.length / GEOMETRY_VARIANTS_UNDER_TEST.length === Math.floor(records.length) ? '' : ''}each request searched both variants in one call)`,
    '',
  ];

  const byLocation = groupBy(records, (record) => record.locationName);
  for (const [locationName, locationRecords] of byLocation) {
    lines.push(locationName.toUpperCase());
    const byWord = groupBy(locationRecords, (record) => record.word);
    for (const [word, wordRecords] of byWord) {
      lines.push(`  ${word}`);
      const byDistance = groupBy(wordRecords, (record) => record.targetDistanceMeters);
      for (const [distance, repeats] of byDistance) {
        lines.push(`    ${distance}m`);
        lines.push(`      runs: ${repeats.length}`);
        for (const variant of GEOMETRY_VARIANTS_UNDER_TEST) {
          lines.push(`      ${variant}:`);
          lines.push(...variantBlock(repeats, variant).map((line) => `        ${line}`));
        }
      }
    }
    lines.push('');
  }

  lines.push('=== OVERALL BY VARIANT ===');
  for (const variant of GEOMETRY_VARIANTS_UNDER_TEST) {
    lines.push(`${variant}:`);
    lines.push(...variantBlock(records, variant).map((line) => `  ${line}`));
  }

  return lines.join('\n');
}

function variantBlock(records: GeometryBenchmarkRecord[], variant: string): string[] {
  const summaries = records
    .map((record) => record.geometryVariants?.[variant] ?? null)
    .filter((summary): summary is PerVariantHistorySummary => summary != null);
  if (summaries.length === 0) {
    return ['no data (request never reached the pipeline for this configuration)'];
  }
  const graphFeasible = summaries.map((s) => s.graphFeasibleCount);
  const routed = summaries.map((s) => s.routedCount);
  const accepted = summaries.map((s) => s.acceptedCount);
  const lines = [
    `graph feasible: total=${sum(graphFeasible)} mean=${fmt(mean(graphFeasible))} (n=${summaries.length} requests)`,
    `routed: total=${sum(routed)} mean=${fmt(mean(routed))}`,
    `accepted: total=${sum(accepted)} mean=${fmt(mean(accepted))}`,
    `shapeScore: median ${fmt(summarizeNumbers(summaries.map((s) => s.shapeScore.median).filter(isNumber)).median)}`,
    `coverage: median ${fmt(summarizeNumbers(summaries.map((s) => s.coverage.median).filter(isNumber)).median)}`,
    `order: median ${fmt(summarizeNumbers(summaries.map((s) => s.order.median).filter(isNumber)).median)}`,
    `backtrack: median ${fmt(summarizeNumbers(summaries.map((s) => s.backtrack.median).filter(isNumber)).median)}`,
    `largestGap: median ${fmt(summarizeNumbers(summaries.map((s) => s.largestGap.median).filter(isNumber)).median)}`,
    `targetSpan: median ${fmt(summarizeNumbers(summaries.map((s) => s.targetSpan.median).filter(isNumber)).median)}`,
    `shapeDistanceMeters: median ${fmt(summarizeNumbers(summaries.map((s) => s.shapeDistanceMeters.median).filter(isNumber)).median)}`,
    `routeDistanceMeters: median ${fmt(summarizeNumbers(summaries.map((s) => s.routeDistanceMeters.median).filter(isNumber)).median)}`,
    `shape/target: median ${fmt(summarizeNumbers(summaries.map((s) => s.shapeTargetRatio.median).filter(isNumber)).median)}`,
    `route/target: median ${fmt(summarizeNumbers(summaries.map((s) => s.routeTargetRatio.median).filter(isNumber)).median)}`,
  ];
  const wordy = summaries.filter((s) => s.wordTraversalPassRate != null);
  if (wordy.length > 0) {
    const passed = wordy.reduce((total, s) => total + (s.wordTraversalPassRate?.passed ?? 0), 0);
    const totalCount = wordy.reduce((total, s) => total + (s.wordTraversalPassRate?.total ?? 0), 0);
    lines.push(`wordTraversal: ${passed}/${totalCount} candidates`);
  }
  const ordered = summaries.filter((s) => s.lettersVisitedInOrderPassRate != null);
  if (ordered.length > 0) {
    const passed = ordered.reduce((total, s) => total + (s.lettersVisitedInOrderPassRate?.passed ?? 0), 0);
    const totalCount = ordered.reduce((total, s) => total + (s.lettersVisitedInOrderPassRate?.total ?? 0), 0);
    lines.push(`lettersVisitedInOrder: ${passed}/${totalCount} candidates`);
  }
  return lines;
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

function isNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fmt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(3);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return NaN;
  }
  return sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export { runGeometryBenchmark, writeRawResults, buildGeometrySummary };

if (import.meta.url === `file://${process.argv[1]}`) {
  const started = Date.now();
  const records = await runGeometryBenchmark();
  const generatedAt = new Date();
  const { timestampedPath, latestPath } = writeRawResults(records, generatedAt);
  const summaryText = buildGeometrySummary(records);
  const summaryPath = resolve(DIAGNOSTIC_DIR, 'experimental-benchmark-geometry-summary.txt');
  writeFileSync(summaryPath, summaryText, 'utf8');

  const succeeded = records.filter((record) => record.outcome === 'accepted' || record.outcome === 'no_viable_shape').length;
  console.log('');
  console.log(
    `[geometry-benchmark] done in ${Math.round((Date.now() - started) / 1000)}s — ${records.length} requests, ${succeeded} completed normally, ${records.length - succeeded} errored/timed out`,
  );
  console.log(`[geometry-benchmark] raw results: ${timestampedPath}`);
  console.log(`[geometry-benchmark] latest copy: ${latestPath}`);
  console.log(`[geometry-benchmark] summary: ${summaryPath}`);
}
