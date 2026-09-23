/**
 * DEVELOPMENT ONLY. Self-test for z-diagonal-direction-diagnostic.ts —
 * synthetic Z target (top, diagonal, bottom) with hand-built routes whose
 * directional category is known in advance.
 */
import type { Vec2 } from '@/lib/geometry';
import { buildShapeGraph } from '../generation/graph-shape';
import { buildDirected } from './letter-street-support-diagnostic';
import {
  analyzeStrokeTraversal,
  analyzeTransition,
  buildRoutePieces,
  classifyDirectionalTraversal,
  directionalFeasibilityShadow,
  summarizeGraphEdgesNearWindow,
  pointAtProgress,
  type StrokeWindow,
} from './z-diagonal-direction-diagnostic';

let failures = 0;
function check(label: string, condition: boolean, detail = '') {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${label} ${detail}`);
  } else console.log(`ok   ${label}`);
}

// Z of width 400m, height 300m: top (0,300)->(400,300), diagonal ->(0,0), bottom ->(400,0).
const target: Vec2[] = [{ x: 0, y: 300 }, { x: 400, y: 300 }, { x: 0, y: 0 }, { x: 400, y: 0 }];
const total = 400 + 500 + 400;
const top: StrokeWindow = { label: 'top', start: 0, end: 400 / total };
const diagonal: StrokeWindow = { label: 'diagonal', start: 400 / total, end: 900 / total };
const bottom: StrokeWindow = { label: 'bottom', start: 900 / total, end: 1 };

const offset = (p: Vec2, dx: number, dy: number) => ({ x: p.x + dx, y: p.y + dy });

// 1. Full forward Z traced with a 5m offset.
const forwardRoute = target.map((p) => offset(p, 3, 4));
const fwd = analyzeStrokeTraversal(buildRoutePieces(forwardRoute, target), target, diagonal);
check('forward diagonal -> A_correct', fwd.category === 'A_correct', JSON.stringify({ c: fwd.category, r: fwd.categoryReason }));
check('forward diagonal signed agreement ~ +1', (fwd.signedAgreement ?? 0) > 0.9, `${fwd.signedAgreement}`);
check('forward diagonal coverage ~ 1', fwd.coverage > 0.9, `${fwd.coverage}`);
check('forward diagonal forwardT ~ 1 (no acute-corner projection jumps)', fwd.forwardT > 0.85 && fwd.forwardT < 1.15, `${fwd.forwardT}`);
check('forward diagonal no reversals', fwd.directionReversals === 0, `${fwd.directionReversals}`);
check('forward diagonal all 8 bins entered once', fwd.bins.every((b) => b.entries >= 1), JSON.stringify(fwd.bins.map((b) => b.entries)));

// 2. Diagonal walked backwards: route goes top, then jumps to bottom-left and walks the diagonal up, then bottom.
const reverseRoute: Vec2[] = [{ x: 0, y: 300 }, { x: 400, y: 300 }, { x: 420, y: 150 }, { x: 60, y: -60 }, { x: 0, y: 0 }, { x: 400, y: 300 }, { x: 480, y: 250 }, { x: 400, y: 0 }];
const rev = analyzeStrokeTraversal(buildRoutePieces(reverseRoute, target), target, diagonal);
check('reverse diagonal -> B_reverse', rev.category === 'B_reverse', JSON.stringify({ c: rev.category, r: rev.categoryReason }));
check('reverse diagonal signed agreement < 0', (rev.signedAgreement ?? 0) < -0.5, `${rev.signedAgreement}`);

// 3. Crossing: a route perpendicular to the diagonal through its middle.
const mid = pointAtProgress(target, (diagonal.start + diagonal.end) / 2);
const crossRoute: Vec2[] = [offset(mid, -120, 160), offset(mid, 120, -160)];
const cross = analyzeStrokeTraversal(buildRoutePieces(crossRoute, target), target, diagonal);
check('perpendicular crossing -> C_crossing_grazing', cross.category === 'C_crossing_grazing', JSON.stringify({ c: cross.category, r: cross.categoryReason }));

// 4. Missing: route only on the top stroke.
const topOnly: Vec2[] = [{ x: 0, y: 302 }, { x: 330, y: 302 }];
const miss = analyzeStrokeTraversal(buildRoutePieces(topOnly, target), target, diagonal);
check('top-only route -> D_missing', miss.category === 'D_missing', JSON.stringify({ c: miss.category, r: miss.categoryReason }));

// 5. Mixed: forward over the first 60%, then back 40%.
const pA = pointAtProgress(target, diagonal.start);
const p60 = pointAtProgress(target, diagonal.start + 0.6 * (diagonal.end - diagonal.start));
const p20 = pointAtProgress(target, diagonal.start + 0.2 * (diagonal.end - diagonal.start));
const mixed = analyzeStrokeTraversal(buildRoutePieces([pA, p60, p20], target), target, diagonal);
check('forward 0.6 then back 0.4 -> E_mixed', mixed.category === 'E_mixed_ambiguous', JSON.stringify({ c: mixed.category, r: mixed.categoryReason }));
check('mixed has one reversal', mixed.directionReversals === 1, `${mixed.directionReversals}`);

// 6. Pure classifier boundaries.
check('classifier: dominant forward', classifyDirectionalTraversal({ inWindowPathMeters: 500, targetLengthMeters: 500, coverage: 0.9, forwardT: 0.9, reverseT: 0.1, longestForwardRunT: 0.8, longestReverseRunT: 0.05 }).category === 'A_correct');
check('classifier: missing', classifyDirectionalTraversal({ inWindowPathMeters: 10, targetLengthMeters: 500, coverage: 0.02, forwardT: 0.02, reverseT: 0, longestForwardRunT: 0.05, longestReverseRunT: 0 }).category === 'D_missing');

// 7. Transitions on the forward route.
const pieces = buildRoutePieces(forwardRoute, target);
const t1 = analyzeTransition(pieces, target, top, diagonal);
const t2 = analyzeTransition(pieces, target, diagonal, bottom);
check('transition1 reached + continues', t1.reachedCorner && t1.continuesIntoOutgoing, JSON.stringify(t1));
check('transition2 reached + continues', t2.reachedCorner && t2.continuesIntoOutgoing, JSON.stringify(t2));
check('transition2 outgoing agreement positive', (t2.outgoingSignedAgreement ?? 0) > 0.5, `${t2.outgoingSignedAgreement}`);
const t2top = analyzeTransition(buildRoutePieces(topOnly, target), target, diagonal, bottom);
check('top-only route never reaches corner2', !t2top.reachedCorner && !t2top.continuesIntoOutgoing);

// 8. Directional shadow on a synthetic graph: a staircase along the diagonal + a stub.
const stair: Vec2[] = [{ x: 400, y: 300 }];
for (let i = 1; i <= 4; i += 1) {
  stair.push({ x: 400 - 100 * i, y: 300 - 75 * (i - 1) });
  stair.push({ x: 400 - 100 * i, y: 300 - 75 * i });
}
const graph = buildShapeGraph([
  { id: 's', wayId: 's', points: stair },
  { id: 'top', wayId: 'top', points: [{ x: 0, y: 300 }, { x: 400, y: 300 }] },
  { id: 'bot', wayId: 'bot', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] },
]);
const { directed } = buildDirected(graph, target, 'generic', false);
const shadow = directionalFeasibilityShadow(directed, graph.nodes, target, diagonal);
check('staircase diagonal is directionally supported', shadow.directionallySupported, JSON.stringify(shadow));
check('staircase detour ~ 1.4', (shadow.directionalDetourRatio ?? 0) > 1.2 && (shadow.directionalDetourRatio ?? 9) < 1.5, `${shadow.directionalDetourRatio}`);
const edgeSummary = summarizeGraphEdgesNearWindow(directed, target, diagonal);
check('graph edges near diagonal are bidirectional', edgeSummary.allBidirectional && edgeSummary.undirectedEdgesNearWindow > 0, JSON.stringify(edgeSummary));

const graphNoDiag = buildShapeGraph([
  { id: 'top', wayId: 'top', points: [{ x: 0, y: 300 }, { x: 400, y: 300 }] },
  { id: 'right', wayId: 'right', points: [{ x: 400, y: 300 }, { x: 400, y: 0 }] },
  { id: 'bot', wayId: 'bot', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] },
]);
const shadowNo = directionalFeasibilityShadow(buildDirected(graphNoDiag, target, 'generic', false).directed, graphNoDiag.nodes, target, diagonal);
check('graph without diagonal corridor is not directionally supported', !shadowNo.directionallySupported, JSON.stringify(shadowNo));

// 9. Shadow must span the window: a staircase covering only the middle half is not support.
const halfStair = buildShapeGraph([{ id: 'h', wayId: 'h', points: stair.slice(2, 7) }]);
const shadowHalf = directionalFeasibilityShadow(buildDirected(halfStair, target, 'generic', false).directed, halfStair.nodes, target, diagonal);
check('partial-span path is not directionally supported', !shadowHalf.directionallySupported, JSON.stringify(shadowHalf));

if (failures > 0) {
  console.error(`z-diagonal-direction-diagnostic self-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('z-diagonal-direction-diagnostic self-test: all checks passed');
