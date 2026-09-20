/**
 * DEVELOPMENT ONLY. Nearby Alexandria L 2km + all graph-feasible identity counts.
 */
import {
  EXPERIMENTAL_PRODUCT,
  experimentalProductRejectionReasons,
} from './experimental-product';
import { runExperimentalPipeline } from './graph-constrained-pipeline';
import { scorePolylines, shapeScoreBreakdown } from '../scoring/shape-match';
import { analyzeTargetIdentity } from './target-identity';
import { snapSearchOrigin } from './snap-search-origin';

const POINTS = [
  { name: 'diagnostic', latitude: 31.227549356302422, longitude: 29.94947010481379 },
  { name: '+40m east', latitude: 31.227549356302422, longitude: 29.94989 },
  { name: '+80m north', latitude: 31.22827, longitude: 29.94947010481379 },
  { name: '+150m west', latitude: 31.227549356302422, longitude: 29.9479 },
] as const;

for (const point of POINTS) {
  const snap = await snapSearchOrigin({ latitude: point.latitude, longitude: point.longitude });
  const report = await runExperimentalPipeline({
    word: 'L',
    start: { latitude: point.latitude, longitude: point.longitude },
    targetDistanceMeters: 2000,
  });
  const feasible = report.diagnostics.feasibility.filter((item) => item.feasible);
  const feasibleIdentity = feasible.map((item) => {
    const scored = item.pathPoints.length >= 2 ? scorePolylines(item.pathPoints, item.target) : null;
    const identity =
      item.pathPoints.length >= 2
        ? analyzeTargetIdentity({
            route: item.pathPoints,
            target: item.target,
            word: 'L',
            requestedDistanceMeters: 2000,
          })
        : null;
    const stubReasons =
      scored && identity
        ? [
            ...(scored.score < EXPERIMENTAL_PRODUCT.minShapeScore ? ['shapeScore'] : []),
            ...(scored.coverage < EXPERIMENTAL_PRODUCT.minCoverage ? ['coverage'] : []),
            ...(shapeScoreBreakdown(scored).order < EXPERIMENTAL_PRODUCT.minOrder ? ['order'] : []),
            ...(item.backtracking > EXPERIMENTAL_PRODUCT.maxBacktrack ? ['backtrack'] : []),
            ...(item.largestGap > EXPERIMENTAL_PRODUCT.maxLargestGap ? ['largestGap'] : []),
            ...(identity.targetSpan < EXPERIMENTAL_PRODUCT.minTargetSpan ? ['targetSpan'] : []),
            ...((identity.lengthRatioRequested ?? identity.lengthRatioProjected) <
            EXPERIMENTAL_PRODUCT.minLengthRatio
              ? ['lengthRatio']
              : []),
          ]
        : ['unscored'];
    return { id: item.placementId, span: identity?.targetSpan, naive: identity?.naiveSpan, reasons: stubReasons };
  });
  const routed = report.routes.map((route) => ({
    id: route.id,
    reasons: experimentalProductRejectionReasons(route, { word: 'L', targetDistance: 2000 }),
  }));
  console.log(
    `\n${point.name} snap=${snap.snappedLatitude},${snap.snappedLongitude} d=${snap.snapDistanceMeters.toFixed(1)} way=${snap.wayId ?? 'none'}`,
  );
  console.log(
    `graphFeasible=${feasible.length} identityPassAmongFeasible=${feasibleIdentity.filter((item) => item.reasons.length === 0).length} routed=${report.routes.length} product=${routed.filter((item) => item.reasons.length === 0).length}`,
  );
  console.log(
    `feasible spans: ${feasibleIdentity.map((item) => `${item.span?.toFixed(3)}/${item.naive?.toFixed(3)}:${item.reasons.join(',') || 'PASS'}`).join(' | ')}`,
  );
  console.log(`routed: ${routed.map((item) => `${item.id}:${item.reasons.join(',') || 'PASS'}`).join(' | ')}`);
}
