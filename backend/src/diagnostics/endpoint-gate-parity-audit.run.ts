/**
 * DEVELOPMENT ONLY. Read-only audit: does the LIVE POST /generate-routes-
 * experimental endpoint's acceptance behavior exactly match a direct call
 * to experimentalProductRejectionReasons() on the SAME pipeline's own
 * native candidates?
 *
 * IMPORTANT METHODOLOGY NOTE: the 78-candidate corpus used throughout the
 * diagnostic investigation that designed this gate was built by taking
 * graph-feasible PLACEMENTS from runExperimentalPipelineMultiVariant and
 * then substituting checkpoint-v1's OWN reconstructed route
 * (generateCheckpointRoutes(...), the sanctioned-but-NOT-wired module) for
 * each one — this was a deliberate choice throughout the investigation to
 * exercise checkpoint-v1's route construction method. checkpoint-v1 is
 * confirmed (via import-graph search) NOT reachable from
 * routes/generate-routes-experimental.ts — the live endpoint only ever
 * returns runExperimentalPipelineMultiVariant's OWN native
 * `graph_constrained` routes (report.routes), never a checkpoint-v1
 * substitute. So a true endpoint-vs-direct-gate parity check must use
 * report.routes directly, NOT the checkpoint-v1 corpus — this script does
 * that, and separately reports whether the resulting accepted count
 * matches the diagnostic investigation's 8/78 figure (which used a
 * different candidate set by design, so an exact numeric match is not
 * expected here; what IS being verified is that the endpoint and a direct
 * in-process gate call agree with EACH OTHER on whichever candidates the
 * live pipeline actually produces).
 *
 * Pure observation — makes real HTTP calls to the already-running local
 * dev server (127.0.0.1:8787) and real in-process pipeline calls; modifies
 * nothing.
 *
 * Run with: npx tsx src/diagnostics/endpoint-gate-parity-audit.run.ts
 * (requires `npm run dev` or `npm start` already running on port 8787)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { experimentalProductRejectionReasons, meetsExperimentalProductThreshold } from '../generation/experimental-product';
import { runExperimentalPipelineMultiVariant } from '../generation/graph-constrained-pipeline';

const DIAGNOSTIC_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_URL = 'http://127.0.0.1:8787/generate-routes-experimental';

const ZAMALEK = { latitude: 30.0619, longitude: 31.2195 };
const ALEXANDRIA = { latitude: 31.227549356302422, longitude: 29.94947010481379 };

const CASES: Array<{ word: string; locationName: string; start: typeof ZAMALEK; targetDistanceMeters: number }> = [
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'ROBZ', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 4000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 2000 },
  { word: 'CAIRO', locationName: 'Zamalek', start: ZAMALEK, targetDistanceMeters: 4000 },
  { word: 'L', locationName: 'Alexandria', start: ALEXANDRIA, targetDistanceMeters: 2000 },
];

type CaseResult = {
  word: string;
  locationName: string;
  targetDistanceMeters: number;
  totalCandidates: number;
  directAcceptedIds: string[];
  directRejectedReasons: Record<string, string[]>;
  endpointAcceptedIds: string[];
  directOnlyIds: string[];
  endpointOnlyIds: string[];
  idSetsMatch: boolean;
};

async function callEndpoint(testCase: (typeof CASES)[number]): Promise<{ status: string; routeIds: string[] }> {
  const res = await fetch(SERVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      word: testCase.word,
      latitude: testCase.start.latitude,
      longitude: testCase.start.longitude,
      targetDistance: testCase.targetDistanceMeters,
    }),
  });
  const body = (await res.json()) as { status: string; routes?: Array<{ id: string }> };
  return { status: body.status, routeIds: (body.routes ?? []).map((r) => r.id) };
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseResult> {
  const report = await runExperimentalPipelineMultiVariant(
    { word: testCase.word, start: testCase.start, targetDistanceMeters: testCase.targetDistanceMeters },
    ['smooth'],
  );
  const context = { word: testCase.word, targetDistance: testCase.targetDistanceMeters };

  const directAcceptedIds: string[] = [];
  const directRejectedReasons: Record<string, string[]> = {};
  for (const route of report.routes) {
    if (meetsExperimentalProductThreshold(route, context)) {
      directAcceptedIds.push(route.id);
    } else {
      directRejectedReasons[route.id] = experimentalProductRejectionReasons(route, context);
    }
  }

  const endpoint = await callEndpoint(testCase);

  const directSet = new Set(directAcceptedIds);
  const endpointSet = new Set(endpoint.routeIds);
  const directOnlyIds = directAcceptedIds.filter((id) => !endpointSet.has(id));
  const endpointOnlyIds = endpoint.routeIds.filter((id) => !directSet.has(id));

  return {
    word: testCase.word,
    locationName: testCase.locationName,
    targetDistanceMeters: testCase.targetDistanceMeters,
    totalCandidates: report.routes.length,
    directAcceptedIds,
    directRejectedReasons,
    endpointAcceptedIds: endpoint.routeIds,
    directOnlyIds,
    endpointOnlyIds,
    idSetsMatch: directOnlyIds.length === 0 && endpointOnlyIds.length === 0 && directAcceptedIds.length === endpoint.routeIds.length,
  };
}

async function main() {
  const started = Date.now();
  const results: CaseResult[] = [];
  for (const testCase of CASES) {
    console.log(`[endpoint-gate-parity] running ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m...`);
    const result = await runCase(testCase);
    results.push(result);
    console.log(
      `[endpoint-gate-parity] ${testCase.word} ${testCase.locationName} ${testCase.targetDistanceMeters}m: totalCandidates=${result.totalCandidates} directAccepted=${result.directAcceptedIds.length} endpointAccepted=${result.endpointAcceptedIds.length} idSetsMatch=${result.idSetsMatch}`,
    );
    if (!result.idSetsMatch) {
      console.log(`  DISCREPANCY: directOnly=${JSON.stringify(result.directOnlyIds)} endpointOnly=${JSON.stringify(result.endpointOnlyIds)}`);
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  const totalDirect = results.reduce((s, r) => s + r.directAcceptedIds.length, 0);
  const totalEndpoint = results.reduce((s, r) => s + r.endpointAcceptedIds.length, 0);
  const totalCandidates = results.reduce((s, r) => s + r.totalCandidates, 0);
  const allMatch = results.every((r) => r.idSetsMatch);
  console.log(`Total native pipeline candidates across all 9 cases: ${totalCandidates}`);
  console.log(`Direct-gate accepted: ${totalDirect}`);
  console.log(`Endpoint accepted: ${totalEndpoint}`);
  console.log(`All cases' accepted-ID-sets match exactly: ${allMatch}`);

  mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const jsonPath = resolve(DIAGNOSTIC_DIR, 'endpoint-gate-parity-audit-results.json');
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), results, summary: { totalCandidates, totalDirect, totalEndpoint, allMatch } }, null, 2), 'utf8');
  console.log('');
  console.log(`[endpoint-gate-parity] done in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[endpoint-gate-parity] json: ${jsonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
