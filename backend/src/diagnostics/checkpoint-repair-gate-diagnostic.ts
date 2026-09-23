/**
 * DEVELOPMENT ONLY. The "do-no-harm" diagnostic gate for targeted
 * checkpoint repair (Step 6 of this task) — decides whether a repaired
 * route should be kept over baseline. These are diagnostic guardrails
 * only, never production thresholds, never wired anywhere.
 */
export type LetterQuality = { letter: string; rawInkCoverage: number; coverage: number; physicallyCovered: boolean };

export type RouteMetricsForGate = {
  shapeScore: number;
  coverage: number;
  backtrack: number;
  lengthRatio: number;
  continuityValid: boolean;
  letters: LetterQuality[];
};

export const REPAIR_GUARDRAILS = {
  maxShapeScoreDrop: 0.03,
  maxCoverageDrop: 0.05,
  maxBacktrackRise: 0.05,
  /** Relative decrease in lengthRatio considered a "worsening" — lengthRatio below 1.0 (route shorter than target) was already established as the dominant failure direction throughout this investigation, so "worsens" is interpreted as a relative DECREASE exceeding this fraction. Documented here, not assumed silently. */
  maxLengthRatioRelativeDrop: 0.25,
} as const;

export type GuardrailCheck = { name: string; passed: boolean; detail: string };

export type RepairGateResult = {
  targetLetterImproved: boolean;
  targetLetterCrossedThreshold: boolean;
  guardrails: GuardrailCheck[];
  allGuardrailsPassed: boolean;
  regressedLetters: string[]; // previously physicallyCovered=true, now false (ANY letter, not just the target)
  improvedLetters: string[];
  unchangedLetters: string[];
  accepted: boolean; // targetLetterImproved && allGuardrailsPassed
};

export type CombinedRepairGateResult = {
  targetedLettersImproved: boolean[]; // one per targetLetterIndex, in the same order
  allTargetedLettersImproved: boolean;
  targetedLettersCrossedThreshold: boolean[];
  guardrails: GuardrailCheck[];
  allGuardrailsPassed: boolean;
  regressedLetters: string[];
  improvedLetters: string[];
  unchangedLetters: string[];
  accepted: boolean; // allTargetedLettersImproved && allGuardrailsPassed
};

/** Step 8's combined multi-letter gate: the same global guardrails as evaluateRepairGate, PLUS a multi-letter-specific condition — EVERY targeted letter must individually improve, not just the aggregate metrics. */
export function evaluateCombinedRepairGate(baseline: RouteMetricsForGate, repaired: RouteMetricsForGate, targetLetterIndices: readonly number[]): CombinedRepairGateResult {
  const targetedLettersImproved = targetLetterIndices.map((index) => {
    const b = baseline.letters[index];
    const r = repaired.letters[index];
    return !!b && !!r && (r.rawInkCoverage > b.rawInkCoverage || r.coverage > b.coverage);
  });
  const targetedLettersCrossedThreshold = targetLetterIndices.map((index) => {
    const b = baseline.letters[index];
    const r = repaired.letters[index];
    return !!r && r.physicallyCovered && !(b?.physicallyCovered ?? false);
  });
  const allTargetedLettersImproved = targetedLettersImproved.every(Boolean);

  const guardrails: GuardrailCheck[] = [];
  const shapeScoreDrop = baseline.shapeScore - repaired.shapeScore;
  guardrails.push({ name: 'shapeScore', passed: shapeScoreDrop <= REPAIR_GUARDRAILS.maxShapeScoreDrop, detail: `drop=${shapeScoreDrop.toFixed(4)} (max ${REPAIR_GUARDRAILS.maxShapeScoreDrop})` });
  const coverageDrop = baseline.coverage - repaired.coverage;
  guardrails.push({ name: 'coverage', passed: coverageDrop <= REPAIR_GUARDRAILS.maxCoverageDrop, detail: `drop=${coverageDrop.toFixed(4)} (max ${REPAIR_GUARDRAILS.maxCoverageDrop})` });
  const backtrackRise = repaired.backtrack - baseline.backtrack;
  guardrails.push({ name: 'backtrack', passed: backtrackRise <= REPAIR_GUARDRAILS.maxBacktrackRise, detail: `rise=${backtrackRise.toFixed(4)} (max ${REPAIR_GUARDRAILS.maxBacktrackRise})` });
  const lengthRatioRelativeDrop = baseline.lengthRatio > 0 ? (baseline.lengthRatio - repaired.lengthRatio) / baseline.lengthRatio : 0;
  guardrails.push({ name: 'lengthRatio', passed: lengthRatioRelativeDrop <= REPAIR_GUARDRAILS.maxLengthRatioRelativeDrop, detail: `relativeDrop=${lengthRatioRelativeDrop.toFixed(4)} (max ${REPAIR_GUARDRAILS.maxLengthRatioRelativeDrop})` });
  guardrails.push({ name: 'continuity', passed: !(baseline.continuityValid && !repaired.continuityValid), detail: `baseline=${baseline.continuityValid} repaired=${repaired.continuityValid}` });

  const regressedLetters: string[] = [];
  const improvedLetters: string[] = [];
  const unchangedLetters: string[] = [];
  baseline.letters.forEach((baseLetter, index) => {
    const repairedLetter = repaired.letters[index];
    if (!repairedLetter) return;
    if (baseLetter.physicallyCovered && !repairedLetter.physicallyCovered) regressedLetters.push(baseLetter.letter);
    else if (!baseLetter.physicallyCovered && repairedLetter.physicallyCovered) improvedLetters.push(baseLetter.letter);
    else unchangedLetters.push(baseLetter.letter);
  });
  guardrails.push({ name: 'noNewlyUncoveredLetter', passed: regressedLetters.length === 0, detail: `regressed=${JSON.stringify(regressedLetters)}` });

  const allGuardrailsPassed = guardrails.every((g) => g.passed);
  return {
    targetedLettersImproved,
    allTargetedLettersImproved,
    targetedLettersCrossedThreshold,
    guardrails,
    allGuardrailsPassed,
    regressedLetters,
    improvedLetters,
    unchangedLetters,
    accepted: allTargetedLettersImproved && allGuardrailsPassed,
  };
}

export function evaluateRepairGate(baseline: RouteMetricsForGate, repaired: RouteMetricsForGate, targetLetterIndex: number): RepairGateResult {
  const targetBaseline = baseline.letters[targetLetterIndex];
  const targetRepaired = repaired.letters[targetLetterIndex];
  const targetLetterImproved = !!targetBaseline && !!targetRepaired && (targetRepaired.rawInkCoverage > targetBaseline.rawInkCoverage || targetRepaired.coverage > targetBaseline.coverage);
  const targetLetterCrossedThreshold = !!targetRepaired && targetRepaired.physicallyCovered && !(targetBaseline?.physicallyCovered ?? false);

  const guardrails: GuardrailCheck[] = [];
  const shapeScoreDrop = baseline.shapeScore - repaired.shapeScore;
  guardrails.push({ name: 'shapeScore', passed: shapeScoreDrop <= REPAIR_GUARDRAILS.maxShapeScoreDrop, detail: `drop=${shapeScoreDrop.toFixed(4)} (max ${REPAIR_GUARDRAILS.maxShapeScoreDrop})` });

  const coverageDrop = baseline.coverage - repaired.coverage;
  guardrails.push({ name: 'coverage', passed: coverageDrop <= REPAIR_GUARDRAILS.maxCoverageDrop, detail: `drop=${coverageDrop.toFixed(4)} (max ${REPAIR_GUARDRAILS.maxCoverageDrop})` });

  const backtrackRise = repaired.backtrack - baseline.backtrack;
  guardrails.push({ name: 'backtrack', passed: backtrackRise <= REPAIR_GUARDRAILS.maxBacktrackRise, detail: `rise=${backtrackRise.toFixed(4)} (max ${REPAIR_GUARDRAILS.maxBacktrackRise})` });

  const lengthRatioRelativeDrop = baseline.lengthRatio > 0 ? (baseline.lengthRatio - repaired.lengthRatio) / baseline.lengthRatio : 0;
  guardrails.push({ name: 'lengthRatio', passed: lengthRatioRelativeDrop <= REPAIR_GUARDRAILS.maxLengthRatioRelativeDrop, detail: `relativeDrop=${lengthRatioRelativeDrop.toFixed(4)} (max ${REPAIR_GUARDRAILS.maxLengthRatioRelativeDrop})` });

  guardrails.push({ name: 'continuity', passed: !(baseline.continuityValid && !repaired.continuityValid), detail: `baseline=${baseline.continuityValid} repaired=${repaired.continuityValid}` });

  const regressedLetters: string[] = [];
  const improvedLetters: string[] = [];
  const unchangedLetters: string[] = [];
  baseline.letters.forEach((baseLetter, index) => {
    const repairedLetter = repaired.letters[index];
    if (!repairedLetter) return;
    if (baseLetter.physicallyCovered && !repairedLetter.physicallyCovered) regressedLetters.push(baseLetter.letter);
    else if (!baseLetter.physicallyCovered && repairedLetter.physicallyCovered) improvedLetters.push(baseLetter.letter);
    else unchangedLetters.push(baseLetter.letter);
  });
  guardrails.push({ name: 'noNewlyUncoveredLetter', passed: regressedLetters.length === 0, detail: `regressed=${JSON.stringify(regressedLetters)}` });

  const allGuardrailsPassed = guardrails.every((g) => g.passed);
  return {
    targetLetterImproved,
    targetLetterCrossedThreshold,
    guardrails,
    allGuardrailsPassed,
    regressedLetters,
    improvedLetters,
    unchangedLetters,
    accepted: targetLetterImproved && allGuardrailsPassed,
  };
}
