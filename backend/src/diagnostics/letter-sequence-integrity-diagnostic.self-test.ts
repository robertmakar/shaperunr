/**
 * DEVELOPMENT ONLY. Tests for the letter visitation & sequence integrity
 * diagnostic (letter-sequence-integrity-diagnostic.ts).
 *
 * A. assignRouteSamplesToLetters: a route that visits R then O then B
 *    then Z in that chronological order produces assignments whose
 *    non-null letters, in sample order, are R...O...B...Z (no reordering).
 * B. deriveVisitationBlocks/deriveObservedSequence: a route that visits
 *    R -> O -> R -> B -> Z (a legitimate local revisit) preserves the
 *    repeat as a real, distinct block — never collapsed.
 * C. evaluateSequenceIntegrity: perfect sequence -> valid, no missing, no reorder.
 * D. evaluateSequenceIntegrity: a missing letter -> invalid, reported in missingLetters.
 * E. evaluateSequenceIntegrity: a reordered sequence -> invalid, reorderedPairs populated.
 * F. evaluateSequenceIntegrity: a legitimate revisit (R->O->R->B->Z) is
 *    STILL valid (first-occurrence order is still correct) with hasRevisit=true.
 * G. computeVisitationConfidence: a single fleeting sample does not count
 *    as "visited" under the default minimum block size; a real multi-sample
 *    block does.
 * H. read-only / production isolation.
 */
import { buildWalkableWordShape } from '../generation/walkable-target';
import { analyzeTargetIdentity } from '../generation/target-identity';
import {
  assignRouteSamplesToLetters,
  deriveVisitationBlocks,
  deriveObservedSequence,
  evaluateSequenceIntegrity,
  computeVisitationConfidence,
  wordLetters,
} from './letter-sequence-integrity-diagnostic';
import type { Vec2 } from '@/lib/geometry';

type SelfTest = { name: string; passed: boolean; detail: string };
const tests: SelfTest[] = [];

const robzShape = buildWalkableWordShape('ROBZ', { letterVariant: 'smooth' });

function densify(points: readonly Vec2[], factor: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (let s = 0; s < factor; s += 1) {
      const t = s / factor;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}
const goodRoute = densify(robzShape.points, 6);

// --- A. chronological assignment order ---
{
  const { assignments } = assignRouteSamplesToLetters('ROBZ', robzShape.points, goodRoute, 'smooth');
  const nonNull = assignments.filter((a) => a.letter !== null).map((a) => a.letter!);
  const firstOccurrence: string[] = [];
  for (const letter of nonNull) if (!firstOccurrence.includes(letter)) firstOccurrence.push(letter);
  tests.push({
    name: 'A. a route that visits letters in the correct order produces chronological assignments whose first-occurrence order is R,O,B,Z',
    passed: JSON.stringify(firstOccurrence) === JSON.stringify(['R', 'O', 'B', 'Z']),
    detail: `firstOccurrence=${JSON.stringify(firstOccurrence)}`,
  });
}

// --- B. legitimate revisit preserved as a distinct block ---
{
  const rRoute = densify(robzShape.letters[0]!.points, 6);
  const oRoute = densify(robzShape.letters[1]!.points, 6);
  const bRoute = densify(robzShape.letters[2]!.points, 6);
  const zRoute = densify(robzShape.letters[3]!.points, 6);
  const revisitRoute = [...rRoute, ...oRoute, ...rRoute, ...bRoute, ...zRoute];
  const { assignments } = assignRouteSamplesToLetters('ROBZ', robzShape.points, revisitRoute, 'smooth');
  const blocks = deriveVisitationBlocks(assignments);
  const sequence = deriveObservedSequence(blocks);
  const rCount = sequence.filter((l) => l === 'R').length;
  tests.push({
    name: 'B. a route that revisits R after O (R->O->R->B->Z) preserves TWO distinct R blocks in the observed sequence, never collapsed into one',
    passed: rCount >= 2,
    detail: `observedSequence=${JSON.stringify(sequence)}`,
  });
}

// --- C/D/E/F. evaluateSequenceIntegrity ---
{
  const intended = ['R', 'O', 'B', 'Z'];
  const perfect = evaluateSequenceIntegrity(['R', 'O', 'B', 'Z'], intended);
  tests.push({ name: 'C. perfect sequence -> sequenceValid=true, no missing, no reordered pairs', passed: perfect.sequenceValid && perfect.missingLetters.length === 0 && perfect.reorderedPairs.length === 0, detail: JSON.stringify(perfect) });

  const missing = evaluateSequenceIntegrity(['R', 'B', 'Z'], intended);
  tests.push({ name: 'D. a sequence missing O -> sequenceValid=false, missingLetters=["O"]', passed: !missing.sequenceValid && missing.missingLetters.includes('O'), detail: JSON.stringify(missing) });

  const reordered = evaluateSequenceIntegrity(['R', 'B', 'O', 'Z'], intended);
  tests.push({ name: 'E. a reordered sequence (B before O) -> sequenceValid=false, reorderedPairs reports O/B', passed: !reordered.sequenceValid && reordered.reorderedPairs.length > 0, detail: JSON.stringify(reordered) });

  const revisit = evaluateSequenceIntegrity(['R', 'O', 'R', 'B', 'Z'], intended);
  tests.push({ name: 'F. a legitimate revisit (R->O->R->B->Z) is STILL sequenceValid=true (first-occurrence order unaffected), with hasRevisit=true', passed: revisit.sequenceValid && revisit.hasRevisit && revisit.revisitedLetters.includes('R'), detail: JSON.stringify(revisit) });
}

// --- G. visitation confidence: fleeting sample vs real block ---
{
  const boundaries = [{ letter: 'R', index: 0, projectedStartProgress: 0, projectedEndProgress: 0.2, lengthStartProgress: 0, lengthEndProgress: 0.2, letterLength: 1 }];
  const fleetingBlocks = [{ letter: 'R', letterIndex: 0, startSampleIndex: 5, endSampleIndex: 5, sampleCount: 1, routeDistanceUnits: 0 }];
  const realBlocks = [{ letter: 'R', letterIndex: 0, startSampleIndex: 5, endSampleIndex: 8, sampleCount: 4, routeDistanceUnits: 1.2 }];
  const fleetingConfidence = computeVisitationConfidence(boundaries, fleetingBlocks);
  const realConfidence = computeVisitationConfidence(boundaries, realBlocks);
  tests.push({
    name: 'G. a single fleeting sample (sampleCount=1) does not count as "visited" under the default minBlockSampleCount=2, while a real 4-sample block does',
    passed: !fleetingConfidence[0]!.visited && realConfidence[0]!.visited,
    detail: `fleeting.visited=${fleetingConfidence[0]!.visited} real.visited=${realConfidence[0]!.visited}`,
  });
}

// --- H. read-only / production isolation ---
{
  const targetSnapshot = JSON.stringify(robzShape.points);
  const routeSnapshot = JSON.stringify(goodRoute);
  assignRouteSamplesToLetters('ROBZ', robzShape.points, goodRoute, 'smooth');
  tests.push({
    name: 'H1. read-only: target and route arrays are byte-identical before and after the diagnostic runs',
    passed: JSON.stringify(robzShape.points) === targetSnapshot && JSON.stringify(goodRoute) === routeSnapshot,
    detail: 'no mutation detected',
  });

  const identityBefore = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  assignRouteSamplesToLetters('ROBZ', robzShape.points, goodRoute, 'smooth');
  const identityAfter = analyzeTargetIdentity({ route: goodRoute, target: robzShape.points, word: 'ROBZ', geometryVariant: 'smooth' });
  tests.push({
    name: 'H2. production isolation: running the diagnostic does not change a subsequent real analyzeTargetIdentity() result',
    passed: JSON.stringify(identityBefore) === JSON.stringify(identityAfter),
    detail: `before.traversesMostOfWord=${identityBefore.traversesMostOfWord} after=${identityAfter.traversesMostOfWord}`,
  });

  const letters = wordLetters('ROBZ', 'smooth');
  tests.push({ name: 'H3. wordLetters("ROBZ") returns exactly ["R","O","B","Z"]', passed: JSON.stringify(letters) === JSON.stringify(['R', 'O', 'B', 'Z']), detail: JSON.stringify(letters) });
}

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
