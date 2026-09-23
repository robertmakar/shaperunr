/**
 * DEVELOPMENT ONLY. Route-generation benchmark runner.
 *
 * Systematically exercises the real, unmodified `POST /generate-routes-experimental`
 * HTTP endpoint across a fixed location × word × distance × repeat matrix, and
 * writes a compact dataset for later algorithmic-decision analysis.
 *
 * This file calls only the HTTP endpoint — never `runExperimentalPipeline` or
 * any other generation function directly — and never changes any placement,
 * search, scoring, or product-gate constant. It measures the current
 * baseline; it does not alter it.
 *
 * The endpoint's own HTTP response only carries `ExperimentalViabilityDiagnostics`
 * (the same object the app itself receives). The richer funnel/graph-search/
 * route-length data (added for baseline instrumentation) is written by the
 * endpoint, as a side effect of every request, to
 * `experimental-history.ndjson`. Because this runner calls requests strictly
 * sequentially (never concurrently — see BENCHMARK constants below) and that
 * file append happens synchronously before the HTTP response is sent, the
 * single new ndjson line that appears immediately after each request's
 * `fetch()` resolves is guaranteed to be that exact request's record. This
 * runner reads it back that way rather than reconstructing anything from
 * the returned routes, and never writes benchmark output into that file.
 *
 * Run with: npm run benchmark:experimental --prefix backend
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExperimentalGenerateRoutesResponse } from '@/lib/experimental-routes-client';

import { config } from '../config';
import type {
  ExperimentalHistoryRecord,
  ExperimentalViabilityDiagnostics,
} from '../generation/experimental-diagnostics';
import { ZAMALEK_CONTROL } from '../generation/experimental-diagnostics';
import { readExperimentalHistory } from './experimental-history';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration — locations, word/distance matrix, and run parameters are
// all explicit, top-level constants rather than buried in loop logic.
// ---------------------------------------------------------------------------

export type BenchmarkLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};

/**
 * Reused verbatim from the existing regression fixtures, not invented here:
 * Alexandria matches `identity-regression.run.ts`'s "L Alexandria 2km" case
 * (also used identically in identity-nearby-alex.run.ts / identity-alex-letters.run.ts).
 * Zamalek reuses the exported ZAMALEK_CONTROL constant already shared across
 * experimental-diagnostics.ts and feasibility-pool-diagnostic.run.ts.
 */
export const BENCHMARK_LOCATIONS: BenchmarkLocation[] = [
  { id: 'alexandria', name: 'Alexandria', latitude: 31.227549356302422, longitude: 29.94947010481379 },
  { id: 'zamalek', name: 'Zamalek', latitude: ZAMALEK_CONTROL.latitude, longitude: ZAMALEK_CONTROL.longitude },
];

/** word -> target distances (meters), exactly the matrix requested. */
export const BENCHMARK_WORD_DISTANCES: Record<string, number[]> = {
  I: [1000, 2000, 4000, 6000],
  L: [1000, 2000, 4000, 6000],
  O: [1000, 2000, 4000, 6000],
  R: [1000, 2000, 4000, 6000],
  ROBZ: [2000, 4000, 6000],
  CAIRO: [2000, 4000, 6000],
};

export const BENCHMARK_REPEATS = 3;
/**
 * Same value as the real app client's EXPERIMENTAL_ROUTES_REQUEST_TIMEOUT_MS
 * (src/lib/experimental-routes-client.ts) — not re-derived from an import of
 * that module, since it transitively pulls in React Native (fine inside
 * Expo/Metro, not resolvable by tsx running this file directly in Node).
 * Keep this in sync if that constant ever changes.
 */
export const BENCHMARK_REQUEST_TIMEOUT_MS = 45_000;

export type BenchmarkConfig = {
  location: BenchmarkLocation;
  word: string;
  targetDistanceMeters: number;
};

export function buildBenchmarkConfigs(): BenchmarkConfig[] {
  const configs: BenchmarkConfig[] = [];
  for (const location of BENCHMARK_LOCATIONS) {
    for (const [word, distances] of Object.entries(BENCHMARK_WORD_DISTANCES)) {
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

export type BenchmarkOutcome =
  | 'accepted'
  | 'no_viable_shape'
  | 'invalid_request'
  | 'server_error'
  | 'timeout'
  | 'unexpected_error';

export type BenchmarkFailureStage =
  | 'invalid_request'
  | 'no_street_graph'
  | 'no_graph_feasible_candidate'
  | 'graph_feasible_but_quality_rejected'
  | 'routed_but_product_gate_rejected'
  | 'accepted'
  | 'unknown_failure_stage';

/** One HTTP call — one location × word × distance × repeat. */
export type BenchmarkRecord = {
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
  /** Exactly what the real app receives over HTTP — never reconstructed. */
  responseDiagnostics: ExperimentalViabilityDiagnostics | null;
  /** The richer server-side record correlated from experimental-history.ndjson (see file header) — null when the request never reached the pipeline (invalid_request/server_error/timeout/unexpected_error before generation ran). */
  history: ExperimentalHistoryRecord | null;
};

// ---------------------------------------------------------------------------
// HTTP call + outcome classification
// ---------------------------------------------------------------------------

type RawCallResult = {
  httpStatus: number | null;
  outcome: BenchmarkOutcome;
  errorMessage: string | null;
  payload: (ExperimentalGenerateRoutesResponse & { diagnostics?: ExperimentalViabilityDiagnostics }) | null;
};

async function callExperimentalEndpoint(input: {
  baseUrl: string;
  word: string;
  latitude: number;
  longitude: number;
  targetDistanceMeters: number;
}): Promise<RawCallResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BENCHMARK_REQUEST_TIMEOUT_MS);
  try {
    // Same request body shape as generateExperimentalRoutesFromBackend in
    // src/lib/experimental-routes-client.ts — reused exactly, not redefined.
    const response = await fetch(`${input.baseUrl}/generate-routes-experimental`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        word: input.word,
        latitude: input.latitude,
        longitude: input.longitude,
        targetDistance: input.targetDistanceMeters,
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
        payload: null,
      };
    }

    if (response.status === 400) {
      return { httpStatus: response.status, outcome: 'invalid_request', errorMessage: readApiErrorMessage(payload), payload: null };
    }
    if (response.status >= 500) {
      return { httpStatus: response.status, outcome: 'server_error', errorMessage: readApiErrorMessage(payload), payload: null };
    }
    if (!response.ok) {
      return { httpStatus: response.status, outcome: 'unexpected_error', errorMessage: readApiErrorMessage(payload), payload: null };
    }

    const body = payload as ExperimentalGenerateRoutesResponse & { diagnostics?: ExperimentalViabilityDiagnostics };
    if (body.status === 'ok') {
      return { httpStatus: response.status, outcome: 'accepted', errorMessage: null, payload: body };
    }
    if (body.status === 'no_viable_shape') {
      return { httpStatus: response.status, outcome: 'no_viable_shape', errorMessage: null, payload: body };
    }
    return {
      httpStatus: response.status,
      outcome: 'unexpected_error',
      errorMessage: `Unrecognized response status: ${String((payload as { status?: unknown } | null)?.status)}`,
      payload: body,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { httpStatus: null, outcome: 'timeout', errorMessage: `Request exceeded ${BENCHMARK_REQUEST_TIMEOUT_MS} ms`, payload: null };
    }
    return {
      httpStatus: null,
      outcome: 'unexpected_error',
      errorMessage: error instanceof Error ? error.message : String(error),
      payload: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function readApiErrorMessage(payload: unknown): string {
  if (payload != null && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: { message?: string; code?: string } }).error;
    return error?.message ?? error?.code ?? 'Unknown API error';
  }
  return 'Unknown API error';
}

function classifyFailureStage(outcome: BenchmarkOutcome, history: ExperimentalHistoryRecord | null): BenchmarkFailureStage {
  if (outcome === 'invalid_request') {
    return 'invalid_request';
  }
  if (outcome === 'accepted') {
    return 'accepted';
  }
  if (outcome !== 'no_viable_shape') {
    return 'unknown_failure_stage';
  }
  if (!history) {
    return 'unknown_failure_stage';
  }
  if (history.neighborhood.graphEdgeCount === 0) {
    return 'no_street_graph';
  }
  if (history.outcomeCounts.graphFeasible === 0) {
    return 'no_graph_feasible_candidate';
  }
  if (history.outcomeCounts.routedBeforeProduct === 0) {
    return 'graph_feasible_but_quality_rejected';
  }
  if (history.outcomeCounts.finalAccepted === 0) {
    return 'routed_but_product_gate_rejected';
  }
  return 'unknown_failure_stage';
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

async function runBenchmark(): Promise<BenchmarkRecord[]> {
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const configs = buildBenchmarkConfigs();
  const totalRequests = configs.length * BENCHMARK_REPEATS;
  console.log(
    `[benchmark] ${configs.length} configurations × ${BENCHMARK_REPEATS} repeats = ${totalRequests} requests, sequential, timeout ${BENCHMARK_REQUEST_TIMEOUT_MS} ms`,
  );

  const records: BenchmarkRecord[] = [];
  let requestNumber = 0;

  for (const benchmarkConfig of configs) {
    for (let repeatIndex = 1; repeatIndex <= BENCHMARK_REPEATS; repeatIndex += 1) {
      requestNumber += 1;
      const historyBefore = readExperimentalHistory(Number.MAX_SAFE_INTEGER);
      const startedAt = Date.now();
      const result = await callExperimentalEndpoint({
        baseUrl,
        word: benchmarkConfig.word,
        latitude: benchmarkConfig.location.latitude,
        longitude: benchmarkConfig.location.longitude,
        targetDistanceMeters: benchmarkConfig.targetDistanceMeters,
      });
      const durationMs = Date.now() - startedAt;
      const historyAfter = readExperimentalHistory(Number.MAX_SAFE_INTEGER);
      // Sequential execution (never concurrent — see file header) guarantees
      // at most one new line belongs to this exact request.
      const newHistoryRecords = historyAfter.slice(historyBefore.length) as ExperimentalHistoryRecord[];
      const history = newHistoryRecords.length > 0 ? (newHistoryRecords[newHistoryRecords.length - 1] ?? null) : null;
      const failureStage = classifyFailureStage(result.outcome, history);

      const record: BenchmarkRecord = {
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
        routesReturned: result.payload?.routes?.length ?? 0,
        responseDiagnostics: result.payload?.diagnostics ?? null,
        history,
      };
      records.push(record);

      console.log(
        `[benchmark] ${requestNumber}/${totalRequests} ${benchmarkConfig.location.name} ${benchmarkConfig.word} ${benchmarkConfig.targetDistanceMeters}m repeat${repeatIndex} -> ${result.outcome} (${durationMs} ms)${result.errorMessage ? ` [${result.errorMessage}]` : ''}`,
      );
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Output — raw JSON (timestamped, never overwritten, plus a "latest" copy)
// and a human-readable grouped summary.
// ---------------------------------------------------------------------------

function ensureDiagnosticDir(): void {
  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
}

function writeRawResults(records: BenchmarkRecord[], generatedAt: Date): { timestampedPath: string; latestPath: string } {
  ensureDiagnosticDir();
  const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  const timestampedPath = resolve(DIAGNOSTIC_DIR, `experimental-benchmark-${stamp}.json`);
  const latestPath = resolve(DIAGNOSTIC_DIR, 'experimental-benchmark-results.json');
  const payload = {
    generatedAt: generatedAt.toISOString(),
    locations: BENCHMARK_LOCATIONS,
    wordDistances: BENCHMARK_WORD_DISTANCES,
    repeats: BENCHMARK_REPEATS,
    totalRequests: records.length,
    records,
  };
  const json = JSON.stringify(payload, null, 2);
  if (existsSync(timestampedPath)) {
    // Extremely unlikely (same-second re-run), but never silently clobber.
    throw new Error(`Refusing to overwrite existing benchmark file: ${timestampedPath}`);
  }
  writeFileSync(timestampedPath, json, 'utf8');
  writeFileSync(latestPath, json, 'utf8');
  return { timestampedPath, latestPath };
}

export { runBenchmark, writeRawResults, classifyFailureStage, readApiErrorMessage };

// Executed only when run directly (`tsx experimental-benchmark.ts`), not on import —
// lets the summary/output helpers below be unit-tested without hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  const started = Date.now();
  const records = await runBenchmark();
  const generatedAt = new Date();
  const { timestampedPath, latestPath } = writeRawResults(records, generatedAt);
  const summaryText = (await import('./experimental-benchmark-summary')).buildBenchmarkSummary(records);
  const summaryPath = resolve(DIAGNOSTIC_DIR, 'experimental-benchmark-summary.txt');
  writeFileSync(summaryPath, summaryText, 'utf8');

  const succeeded = records.filter((record) => record.outcome === 'accepted' || record.outcome === 'no_viable_shape').length;
  const failed = records.length - succeeded;
  console.log('');
  console.log(`[benchmark] done in ${Math.round((Date.now() - started) / 1000)}s — ${records.length} requests, ${succeeded} completed normally, ${failed} errored/timed out`);
  console.log(`[benchmark] raw results: ${timestampedPath}`);
  console.log(`[benchmark] latest copy: ${latestPath}`);
  console.log(`[benchmark] summary: ${summaryPath}`);
}
