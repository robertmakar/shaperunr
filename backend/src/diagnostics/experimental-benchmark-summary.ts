/**
 * DEVELOPMENT ONLY. Human-readable grouped summary for experimental-benchmark.ts.
 * Pure formatting/aggregation over already-captured BenchmarkRecord data —
 * reads no external state, calls no endpoint, changes no behavior.
 */
import { summarizeNumbers } from './stats';
import type { BenchmarkFailureStage, BenchmarkOutcome, BenchmarkRecord } from './experimental-benchmark';

const RATIO_BUCKETS: Array<{ label: string; test: (ratio: number) => boolean }> = [
  { label: 'within ±25%', test: (ratio) => ratio >= 0.75 && ratio <= 1.25 },
  { label: 'within 0.5x-1.5x', test: (ratio) => ratio >= 0.5 && ratio <= 1.5 },
  { label: 'within 0.45x-1.7x', test: (ratio) => ratio >= 0.45 && ratio <= 1.7 },
  { label: 'below 0.32x', test: (ratio) => ratio < 0.32 },
  { label: 'above 1.7x', test: (ratio) => ratio > 1.7 },
];

export function buildBenchmarkSummary(records: BenchmarkRecord[]): string {
  const lines: string[] = [
    'ShapeRunr experimental-pipeline benchmark (DEVELOPMENT ONLY)',
    'Measurement only — no route-generation behavior was changed to produce this data.',
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
      for (const [distance, repeats] of byDistance) {
        lines.push(`    ${distance}m`);
        lines.push(...configBlock(repeats).map((line) => `      ${line}`));
      }
    }
    lines.push('');
  }

  lines.push('=== OVERALL ===');
  lines.push(...overallSection(records));

  return lines.join('\n');
}

function configBlock(repeats: BenchmarkRecord[]): string[] {
  const lines: string[] = [];
  const accepted = repeats.filter((record) => record.outcome === 'accepted').length;
  lines.push(`runs: ${repeats.length}`);
  lines.push(`accepted: ${accepted}/${repeats.length}`);

  // --- funnel (section 9) ---
  const feasibleRankSamples = repeats
    .map((record) => record.history?.streetFitFunnel ?? null)
    .filter((funnel): funnel is NonNullable<typeof funnel> => funnel != null);
  if (feasibleRankSamples.length > 0) {
    const mins = feasibleRankSamples.map((funnel) => funnel.feasibleStreetFitRank.min).filter(isNumber);
    const maxes = feasibleRankSamples.map((funnel) => funnel.feasibleStreetFitRank.max).filter(isNumber);
    const medians = feasibleRankSamples.map((funnel) => funnel.feasibleStreetFitRank.median).filter(isNumber);
    const counts = feasibleRankSamples.map((funnel) => funnel.graphFeasibleCount);
    const feasibilityTop = feasibleRankSamples[0]?.feasibilityTop ?? null;
    lines.push(
      mins.length > 0
        ? `feasible ranks: min=${Math.min(...mins)} median=${fmt(mean(medians))} max=${Math.max(...maxes)} count-per-repeat=${counts.join(',')} (all necessarily <= feasibilityTop=${feasibilityTop}, since only the top ${feasibilityTop} placements are ever graph-searched)`
        : `feasible ranks: none feasible (0 of top ${feasibilityTop ?? '?'} evaluated)`,
    );
  } else {
    lines.push('feasible ranks: n/a (no correlated history — request never reached the pipeline)');
  }

  // --- distance (section 10) ---
  const shapeRatios = pool(repeats, (record) => record.history?.routeLength.samples.map((sample) => sample.shapeRouteRatio) ?? []);
  const totalRatios = pool(repeats, (record) => record.history?.routeLength.samples.map((sample) => sample.totalRatio) ?? []);
  lines.push(`shape/target ratio: ${distSummary(shapeRatios)}`);
  lines.push(`  buckets: ${bucketSummary(shapeRatios)}`);
  lines.push(`total/target ratio: ${distSummary(totalRatios)}`);
  lines.push(`  buckets: ${bucketSummary(totalRatios)}`);

  // --- shape quality (section 11) ---
  const candidates = pool(repeats, (record) => record.history?.productGate.candidates ?? []);
  if (candidates.length > 0) {
    lines.push(`shape score: median ${fmt(summarizeNumbers(candidates.map((candidate) => candidate.shapeScore)).median)}`);
    lines.push(`coverage: median ${fmt(summarizeNumbers(candidates.map((candidate) => candidate.coverage)).median)}`);
    lines.push(`order: median ${fmt(summarizeNumbers(candidates.map((candidate) => candidate.order)).median)}`);
    lines.push(`backtrack: median ${fmt(summarizeNumbers(candidates.map((candidate) => candidate.backtrack)).median)}`);
    const gaps = candidates.map((candidate) => candidate.largestGap).filter(isNumber);
    lines.push(`largestGap: median ${fmt(summarizeNumbers(gaps).median)}`);
    const spans = candidates.map((candidate) => candidate.targetSpan).filter(isNumber);
    lines.push(`targetSpan: median ${fmt(summarizeNumbers(spans).median)}`);
    const wordy = candidates.filter((candidate) => candidate.traversesMostOfWord != null);
    if (wordy.length > 0) {
      const passed = wordy.filter((candidate) => candidate.traversesMostOfWord === true).length;
      lines.push(`wordTraversal: ${passed}/${wordy.length} candidates`);
      const ordered = wordy.filter((candidate) => candidate.lettersVisitedInOrder === true).length;
      lines.push(`lettersVisitedInOrder: ${ordered}/${wordy.length} candidates`);
    }
  } else {
    lines.push('shape score: n/a (no routed candidates)');
  }

  // --- rejection / failure stage (section 12) ---
  lines.push(`rejection: ${failureStageSummary(repeats)}`);

  // --- determinism (section 13) ---
  const determinism = compareDeterminism(repeats);
  lines.push(
    determinism.deterministic
      ? 'determinism: deterministic'
      : `determinism: variable (${determinism.changedFields.join(', ')})`,
  );

  // --- performance (section 14) ---
  const durations = repeats.map((record) => record.durationMs);
  lines.push(
    `duration: total=${sum(durations)}ms avg=${fmt(mean(durations))}ms min=${Math.min(...durations)}ms max=${Math.max(...durations)}ms`,
  );

  return lines;
}

function overallSection(records: BenchmarkRecord[]): string[] {
  const lines: string[] = [];
  const outcomeCounts = countBy(records, (record) => record.outcome);
  lines.push(`total requests: ${records.length}`);
  for (const [outcome, count] of outcomeCounts) {
    lines.push(`  ${outcome}: ${count}`);
  }
  const durations = records.map((record) => record.durationMs);
  lines.push(
    `duration across all requests: total=${sum(durations)}ms avg=${fmt(mean(durations))}ms min=${Math.min(...durations)}ms max=${Math.max(...durations)}ms`,
  );
  const byConfigKey = groupBy(records, (record) => `${record.locationId}|${record.word}|${record.targetDistanceMeters}`);
  let deterministicConfigs = 0;
  let variableConfigs = 0;
  for (const [, repeats] of byConfigKey) {
    if (repeats.length < 2) {
      continue;
    }
    if (compareDeterminism(repeats).deterministic) {
      deterministicConfigs += 1;
    } else {
      variableConfigs += 1;
    }
  }
  lines.push(`configurations with 2+ repeats: ${deterministicConfigs} deterministic, ${variableConfigs} variable`);
  return lines;
}

// ---------------------------------------------------------------------------
// Determinism comparison (section 13)
// ---------------------------------------------------------------------------

function compareDeterminism(repeats: BenchmarkRecord[]): { deterministic: boolean; changedFields: string[] } {
  if (repeats.length < 2) {
    return { deterministic: true, changedFields: [] };
  }
  const changed = new Set<string>();
  const first = repeats[0]!;
  for (const record of repeats.slice(1)) {
    if (record.outcome !== first.outcome) changed.add('outcome');
    if ((record.history?.neighborhood.graphEdgeCount ?? null) !== (first.history?.neighborhood.graphEdgeCount ?? null)) {
      changed.add('graphEdgeCount');
    }
    if ((record.history?.neighborhood.graphNodeCount ?? null) !== (first.history?.neighborhood.graphNodeCount ?? null)) {
      changed.add('graphNodeCount');
    }
    if ((record.history?.outcomeCounts.graphFeasible ?? null) !== (first.history?.outcomeCounts.graphFeasible ?? null)) {
      changed.add('graphFeasibleCount');
    }
    const a = first.history?.streetFitFunnel?.feasibleStreetFitRank;
    const b = record.history?.streetFitFunnel?.feasibleStreetFitRank;
    if ((a?.min ?? null) !== (b?.min ?? null) || (a?.max ?? null) !== (b?.max ?? null) || (a?.median ?? null) !== (b?.median ?? null)) {
      changed.add('feasibleRanks');
    }
    if ((first.history?.bestRoutedBeforeProduct?.shapeScore ?? null) !== (record.history?.bestRoutedBeforeProduct?.shapeScore ?? null)) {
      changed.add('bestShapeScore');
    }
    if (
      (first.history?.routeLength.bestRoutedBeforeProduct?.shapeRouteRatio ?? null) !==
      (record.history?.routeLength.bestRoutedBeforeProduct?.shapeRouteRatio ?? null)
    ) {
      changed.add('bestShapeRouteRatio');
    }
  }
  return { deterministic: changed.size === 0, changedFields: [...changed] };
}

// ---------------------------------------------------------------------------
// Small formatting/aggregation helpers
// ---------------------------------------------------------------------------

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

function countBy<T, K>(items: T[], key: (item: T) => K): Map<K, number> {
  const map = new Map<K, number>();
  for (const item of items) {
    const groupKey = key(item);
    map.set(groupKey, (map.get(groupKey) ?? 0) + 1);
  }
  return map;
}

function pool<T>(records: BenchmarkRecord[], values: (record: BenchmarkRecord) => T[]): T[] {
  return records.flatMap(values);
}

function distSummary(values: number[]): string {
  const distribution = summarizeNumbers(values);
  if (distribution.count === 0) {
    return 'n/a (no routed candidates)';
  }
  return `median ${fmt(distribution.median)} p25 ${fmt(distribution.p25)} p75 ${fmt(distribution.p75)} min ${fmt(distribution.min)} max ${fmt(distribution.max)} (n=${distribution.count})`;
}

function bucketSummary(values: number[]): string {
  if (values.length === 0) {
    return 'n/a';
  }
  return RATIO_BUCKETS.map((bucket) => {
    const count = values.filter(bucket.test).length;
    return `${bucket.label}=${count}/${values.length} (${Math.round((count / values.length) * 100)}%)`;
  }).join(', ');
}

function failureStageSummary(repeats: BenchmarkRecord[]): string {
  const counts = countBy(repeats, (record) => record.failureStage);
  return [...counts.entries()].map(([stage, count]) => (repeats.length === count ? stage : `${stage}(${count})`)).join(', ');
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
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
