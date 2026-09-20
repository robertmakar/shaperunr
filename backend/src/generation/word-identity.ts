/**
 * DEVELOPMENT ONLY. Multi-letter identity audit.
 *
 * Distinguishes a good local shape match from a global word traversal
 * without changing generation. Downtown Cairo only.
 */
import type { Coordinate } from '@/lib/geo';

import { DOWNTOWN_CONTROL } from './experimental-diagnostics';
import { meetsExperimentalProductThreshold } from './experimental-product';
import {
  runExperimentalPipeline,
  type ExperimentalPipelineReport,
} from './graph-constrained-pipeline';
import { collectNeighborhoodShapeGraph } from './graph-shape-router';
import { getPlacementRingsForTargetDistance, getSearchRadiusForTargetDistance } from './search-radius';
import { searchOriginFromSnap, snapSearchOrigin } from './snap-search-origin';
import { buildStreetFitPlacements } from './street-fit-search';
import {
  analyzeGeneratedRouteIdentity,
  type TargetIdentity,
} from './target-identity';

export const WORD_IDENTITY_WORDS = ['L', 'O', 'RO', 'ROB', 'ROBZ'] as const;
export const WORD_IDENTITY_DISTANCES = [2000, 2500, 4000] as const;

export type WordIdentityCandidate = {
  id: string;
  shapeScore: number;
  coverage: number;
  order: number;
  productAcceptedBeforeIdentity: boolean;
  identity: TargetIdentity;
};

export type WordIdentityCase = {
  word: string;
  targetDistanceMeters: number;
  graphFeasible: number;
  routed: number;
  candidates: WordIdentityCandidate[];
  best: WordIdentityCandidate | null;
  localShapeMatch: boolean;
  globalWordMatch: boolean;
};

export type WordIdentityReport = {
  developmentOnly: true;
  location: Coordinate;
  generatedAt: string;
  elapsedMs: number;
  cases: WordIdentityCase[];
  textReport: string;
};

export async function runWordIdentityAudit(
  options: {
    words?: readonly string[];
    distances?: readonly number[];
    start?: Coordinate;
  } = {},
): Promise<WordIdentityReport> {
  const started = Date.now();
  const start = options.start ?? DOWNTOWN_CONTROL;
  const words = options.words ?? WORD_IDENTITY_WORDS;
  const distances = options.distances ?? WORD_IDENTITY_DISTANCES;
  const snap = await snapSearchOrigin(start);
  const cases: WordIdentityCase[] = [];

  for (const targetDistanceMeters of distances) {
    const collection = await collectNeighborhoodShapeGraph(searchOriginFromSnap(snap), {
      radiusMeters: getSearchRadiusForTargetDistance(targetDistanceMeters),
    });
    const placements = buildStreetFitPlacements({
      translationRingsMeters: getPlacementRingsForTargetDistance(targetDistanceMeters),
    });
    for (const word of words) {
      const report = await runPipelineQuietly({
        word,
        start,
        targetDistanceMeters,
      }, {
        collection,
        placements,
        searchOriginSnap: snap,
        connectStart: false,
      });
      cases.push(buildWordIdentityCase(word, targetDistanceMeters, report));
    }
  }

  const reportWithoutText = {
    developmentOnly: true as const,
    location: start,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    cases,
  };
  return {
    ...reportWithoutText,
    textReport: formatWordIdentityReport(reportWithoutText),
  };
}

export function buildWordIdentityCase(
  word: string,
  targetDistanceMeters: number,
  report: ExperimentalPipelineReport,
): WordIdentityCase {
  const candidates = report.routes.map((route) => {
    const identity = analyzeGeneratedRouteIdentity(route, {
      word,
      targetDistance: targetDistanceMeters,
    });
    return {
      id: route.id,
      shapeScore: route.shapeScore,
      coverage: route.coverage,
      order: route.scoreBreakdown.order,
      productAcceptedBeforeIdentity: meetsExperimentalProductThreshold(route, {
        word,
        targetDistance: targetDistanceMeters,
        skipIdentity: true,
      }),
      identity,
    };
  });
  const best =
    [...candidates].sort(
      (a, b) =>
        Number(b.identity.traversesMostOfWord) - Number(a.identity.traversesMostOfWord) ||
        b.shapeScore - a.shapeScore,
    )[0] ?? null;
  return {
    word,
    targetDistanceMeters,
    graphFeasible: report.diagnostics.graphFeasible,
    routed: report.routes.length,
    candidates,
    best,
    localShapeMatch: Boolean(best && best.productAcceptedBeforeIdentity),
    globalWordMatch: Boolean(best?.identity.traversesMostOfWord && best.productAcceptedBeforeIdentity),
  };
}

export function formatWordIdentityReport(
  report: Omit<WordIdentityReport, 'textReport'>,
): string {
  const lines = [
    'DEVELOPMENT / word identity audit',
    `location ${report.location.latitude},${report.location.longitude}`,
    `generated ${report.generatedAt}  runtime ${report.elapsedMs} ms`,
    '',
  ];
  for (const item of report.cases) {
    const best = item.best;
    lines.push(
      `${item.word.padEnd(4)} ${item.targetDistanceMeters}m  graph=${item.graphFeasible} routed=${item.routed} local=${item.localShapeMatch} global=${item.globalWordMatch}`,
    );
    if (!best) {
      lines.push('  best=none');
      continue;
    }
    const idn = best.identity;
    lines.push(
      `  best ${best.id} shape=${best.shapeScore.toFixed(3)} cov=${best.coverage.toFixed(3)} order=${best.order.toFixed(3)} productBefore=${best.productAcceptedBeforeIdentity}`,
    );
    lines.push(
      `  targetLen=${Math.round(idn.targetLengthMeters)} routeLen=${Math.round(idn.routeLengthMeters)} boxT=${fmt(idn.targetBox.width)}x${fmt(idn.targetBox.height)} boxR=${fmt(idn.routeBox.width)}x${fmt(idn.routeBox.height)}`,
    );
    lines.push(
      `  progress ${fmt(idn.onTargetProgressMin)}→${fmt(idn.onTargetProgressMax)} start=${fmt(idn.startProgress)} end=${fmt(idn.endProgress)} naiveSpan=${fmt(idn.naiveSpan)} span=${fmt(idn.targetSpan)} occ=${fmt(idn.spanOccupancy)} gap=${fmt(idn.largestTargetGap)} meanDist=${fmt(idn.meanRouteToTargetMeters)}`,
    );
    lines.push(
      `  ratioReq=${fmt(idn.lengthRatioRequested)} ratioProj=${fmt(idn.lengthRatioProjected)} letters=${idn.lettersVisited}/${idn.letters.length} inOrder=${idn.lettersVisitedInOrder} trav=${fmt(idn.wordTraversal)} mostOfWord=${idn.traversesMostOfWord}`,
    );
    if (idn.letters.length > 0) {
      lines.push(
        `  per-letter ${idn.letters.map((letter) => `${letter.letter} cov=${letter.coverage.toFixed(2)} ord=${letter.order.toFixed(2)} p=${letter.startProgress.toFixed(2)}-${letter.endProgress.toFixed(2)} ${letter.meaningfullyVisited ? 'YES' : 'no'}`).join(' | ')}`,
      );
    }
  }
  return lines.join('\n');
}

async function runPipelineQuietly(
  input: Parameters<typeof runExperimentalPipeline>[0],
  options: Parameters<typeof runExperimentalPipeline>[1],
): Promise<ExperimentalPipelineReport> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await runExperimentalPipeline(input, options);
  } finally {
    console.log = originalLog;
  }
}

function fmt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(3);
}
