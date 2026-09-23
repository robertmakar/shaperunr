/**
 * DEVELOPMENT ONLY. Confirms the benchmark runner's request pattern is
 * structurally sequential — the next request's fetch() is never issued
 * before the previous one's response (or timeout) has resolved.
 *
 * Mocks global fetch with a controllable delay; does not touch the real
 * server or ndjson history file.
 */
import { callWithStatus } from './experimental-benchmark-shared-budget';

type SelfTest = { name: string; passed: boolean; detail: string };

const originalFetch = globalThis.fetch;
const callWindows: Array<{ start: number; end: number }> = [];

// Simulates a slow server: each call takes ~40ms and records its own start/end.
globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
  const start = Date.now();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  const end = Date.now();
  callWindows.push({ start, end });
  return new Response(JSON.stringify({ status: 'no_viable_shape', word: 'I', targetDistance: 1000, routes: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

async function runSequentially(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    // Mirrors the runner's own loop shape: await before moving to the next iteration.
    await callWithStatus({
      baseUrl: 'http://127.0.0.1:0',
      word: 'I',
      latitude: 0,
      longitude: 0,
      targetDistanceMeters: 1000,
      variants: ['smooth'],
    });
  }
}

await runSequentially(4);
globalThis.fetch = originalFetch;

const overlaps: string[] = [];
for (let index = 1; index < callWindows.length; index += 1) {
  const previous = callWindows[index - 1]!;
  const current = callWindows[index]!;
  if (current.start < previous.end) {
    overlaps.push(`call ${index} started at ${current.start} before call ${index - 1} ended at ${previous.end}`);
  }
}

const tests: SelfTest[] = [
  {
    name: 'all 4 mocked requests were actually issued',
    passed: callWindows.length === 4,
    detail: `issued ${callWindows.length}`,
  },
  {
    name: 'no request started before the previous one finished (never overlaps)',
    passed: overlaps.length === 0,
    detail: overlaps.length === 0 ? 'sequential' : overlaps.join('; '),
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
