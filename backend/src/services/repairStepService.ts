/**
 * Deterministic repair step evaluator — the REPAIR STATE MACHINE half of the
 * Phase 2 architecture.
 *
 * The hard rule this file exists to enforce:
 *
 *     the vision layer decides what is VISIBLE
 *     this file decides what the user is TOLD TO DO NEXT
 *
 * Every instruction returned from here comes verbatim out of the existing
 * `demoScenarios` data. Nothing is generated, paraphrased, or inferred, and no
 * model output can influence which step is selected — only whether the current
 * step is considered finished.
 *
 * Everything here is pure and synchronous: no network, no database, no model.
 * The same inputs always produce the same output, which is what makes the
 * safety behaviour testable.
 *
 * Relationship to the existing repair engine
 * ------------------------------------------
 * `controllers/repairController.ts#updateRepairStep` remains the ONLY writer of
 * persisted repair state, and its conventions are deliberately not duplicated
 * here. This module answers "given this step and this evidence, is the step
 * done and what is the next one?" and returns `persistenceHint` describing the
 * call the client should make to that existing endpoint.
 *
 * Index conventions in this repository (easy to get wrong):
 *   - `DemoScenarioStep.stepIndex` is 1-BASED (1..N), and the existing
 *     /api/ai/verify and PATCH /api/repairs/:repairId/step APIs both use it.
 *   - `Repair.currentStep` is a COUNT of completed steps (starts at 0), which
 *     happens to equal the 0-based array position of the next step to perform.
 * This module speaks the 1-based `stepIndex` dialect, because that is what the
 * API and the frontend already exchange.
 */

import { DemoScenario, DemoScenarioStep } from '../data/demoScenarios';
import { StepObservation } from '../types/ai';

/**
 * Explicit tri-state. A boolean cannot express "the model answered but the
 * evidence was too weak to act on", which is precisely the case that must not
 * advance a repair.
 */
export type RepairStepStatus = 'COMPLETED' | 'NOT_COMPLETED' | 'UNCERTAIN';

/**
 * Minimum confidence required to act on a verdict — in EITHER direction.
 * Below this the answer is UNCERTAIN regardless of what the model claimed.
 */
export const DEFAULT_STEP_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Read the threshold from the environment so it can be tuned per deployment
 * without a code change. Accepts a 0..1 fraction or a 0..100 percentage.
 * Anything unparseable falls back to the default rather than to 0, so a typo
 * can never disable the safety gate.
 */
export const stepConfidenceThreshold = (): number => {
  const raw = Number(process.env.AI_STEP_CONFIDENCE_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STEP_CONFIDENCE_THRESHOLD;
  if (raw <= 1) return raw;
  if (raw <= 100) return raw / 100;
  return DEFAULT_STEP_CONFIDENCE_THRESHOLD;
};

/**
 * A repair step as exposed over the API.
 *
 * `title` and `instruction` both carry the scenario's `stepTitle` verbatim: the
 * repository has no separate instruction field, and inventing prose for one
 * would mean generating repair guidance. `warningText` reuses the wording the
 * frontend already renders for risky steps rather than introducing new copy.
 */
export interface RepairStepView {
  /** 1-based `stepIndex` from the scenario. */
  index: number;
  title: string;
  instruction: string;
  safetyRisk: 'safe' | 'medium' | 'high';
  /** null for 'safe' steps. Static UI label, never model output. */
  warningText: string | null;
  /** The scenario's own verification key, useful to the client for logging. */
  verificationTrigger: string;
}

/** What the client should PATCH to the existing repair endpoint, if anything. */
export interface PersistenceHint {
  /** true only when status is COMPLETED. */
  shouldPersist: boolean;
  /** 1-based step index to mark complete, matching the existing PATCH body. */
  stepIndex: number;
  isCompleted: boolean;
}

export interface StepDecision {
  status: RepairStepStatus;
  /** true only when the repair may move on. Mirrors status === 'COMPLETED'. */
  advanced: boolean;
  /** 0..1, or null when no trustworthy value was reported. */
  confidence: number | null;
  /** The gate the confidence was compared against, echoed for transparency. */
  threshold: number;
  /** The step that was evaluated. Always present. */
  currentStep: RepairStepView;
  /** The step to show next, or null when the repair holds or is finished. */
  nextStep: RepairStepView | null;
  /** true when the final step of the scenario has just been completed. */
  repairComplete: boolean;
  totalSteps: number;
  /** Backend-authored explanation. Never model text and never an instruction. */
  reason: string;
  persistenceHint: PersistenceHint;
}

const WARNING_TEXT: Record<DemoScenarioStep['safetyRisk'], string | null> = {
  safe: null,
  // Matches the copy frontend/src/app/diagnose/page.tsx already displays.
  medium: 'MEDIUM RISK STEP WARNING',
  high: 'HIGH RISK STEP WARNING'
};

/** Scenario steps ordered by their 1-based index, defensively copied. */
const orderedSteps = (scenario: DemoScenario): DemoScenarioStep[] =>
  [...scenario.steps].sort((a, b) => a.stepIndex - b.stepIndex);

/** Project a scenario step onto the API shape. Copies data, never creates it. */
export const toStepView = (step: DemoScenarioStep): RepairStepView => ({
  index: step.stepIndex,
  title: step.stepTitle,
  instruction: step.stepTitle,
  safetyRisk: step.safetyRisk,
  warningText: WARNING_TEXT[step.safetyRisk] ?? null,
  verificationTrigger: step.verificationTrigger
});

/** Find a step by its 1-based index. Returns undefined when out of range. */
export const findScenarioStep = (
  scenario: DemoScenario,
  stepIndex: number
): DemoScenarioStep | undefined => scenario.steps.find((step) => step.stepIndex === stepIndex);

/**
 * The step that follows the given one, by position rather than by arithmetic,
 * so a scenario with non-contiguous indexes still behaves correctly.
 * Returns null when the given step is the last one.
 */
export const findNextScenarioStep = (
  scenario: DemoScenario,
  stepIndex: number
): DemoScenarioStep | null => {
  const steps = orderedSteps(scenario);
  const position = steps.findIndex((step) => step.stepIndex === stepIndex);
  if (position === -1) return null;
  return steps[position + 1] ?? null;
};

export interface EvaluateStepProgressInput {
  scenario: DemoScenario;
  /** 1-based index of the step the user is currently on. */
  stepIndex: number;
  observation: StepObservation;
  /** Override for tests; defaults to the configured threshold. */
  threshold?: number;
}

/**
 * Decide the repair state from visual evidence.
 *
 * The decision table, in evaluation order:
 *
 *   confidence missing or < threshold ....... UNCERTAIN     hold the step
 *   confident and stepCompleted = false ..... NOT_COMPLETED hold the step
 *   confident and stepCompleted = true ...... COMPLETED     advance
 *   COMPLETED on the final step ............. COMPLETED     repairComplete
 *
 * Note the deliberate asymmetry: high confidence is required to trust EITHER
 * verdict. A model that says "not done" at 0.42 confidence has not established
 * that the step is incomplete, it has established that it cannot see properly —
 * so the user is asked to fix the camera rather than told to keep working.
 *
 * Only COMPLETED ever advances. UNCERTAIN and NOT_COMPLETED both return the
 * current step unchanged, and `nextStep` is null so a client cannot mistake a
 * preview for an instruction to proceed.
 */
export const evaluateStepProgress = (input: EvaluateStepProgressInput): StepDecision => {
  const { scenario, stepIndex, observation } = input;
  const threshold = input.threshold ?? stepConfidenceThreshold();

  const step = findScenarioStep(scenario, stepIndex);
  if (!step) {
    // Callers validate the index first; this is a defensive guard so the
    // service can never be coaxed into inventing a step.
    throw new Error(`Step ${stepIndex} does not exist in this scenario.`);
  }

  const currentStep = toStepView(step);
  const totalSteps = scenario.steps.length;
  const confidence = observation.confidence;

  const hold = (status: RepairStepStatus, reason: string): StepDecision => ({
    status,
    advanced: false,
    confidence,
    threshold,
    currentStep,
    nextStep: null,
    repairComplete: false,
    totalSteps,
    reason,
    persistenceHint: { shouldPersist: false, stepIndex, isCompleted: false }
  });

  if (confidence === null) {
    return hold(
      'UNCERTAIN',
      'No trustworthy confidence value was reported, so the step was left unchanged.'
    );
  }

  if (confidence < threshold) {
    return hold(
      'UNCERTAIN',
      `Confidence ${confidence.toFixed(2)} is below the ${threshold.toFixed(2)} threshold, so the step was left unchanged.`
    );
  }

  if (!observation.stepCompleted) {
    return hold(
      'NOT_COMPLETED',
      'Visual evidence indicates this step is not finished yet.'
    );
  }

  const next = findNextScenarioStep(scenario, stepIndex);

  return {
    status: 'COMPLETED',
    advanced: true,
    confidence,
    threshold,
    currentStep,
    // null on the final step: there is no next step to look up, and none is
    // fabricated to fill the field.
    nextStep: next ? toStepView(next) : null,
    repairComplete: next === null,
    totalSteps,
    reason: next
      ? 'Visual evidence indicates this step is complete; advanced to the next step.'
      : 'Visual evidence indicates the final step is complete; the repair checklist is finished.',
    persistenceHint: { shouldPersist: true, stepIndex, isCompleted: true }
  };
};

/**
 * Backend-authored, user-facing wording for a decision.
 *
 * Kept separate from model output on purpose: `observations` carries what the
 * model said, and this carries what the system says. Nothing here is a repair
 * instruction — the UNCERTAIN text is camera guidance only.
 */
export const describeDecision = (decision: StepDecision): string => {
  switch (decision.status) {
    case 'COMPLETED':
      return decision.repairComplete
        ? 'Step verified. That was the final step in this repair.'
        : 'Step verified from the camera frame. You can move on to the next step.';
    case 'NOT_COMPLETED':
      return 'This step does not look complete yet. Finish the current step, then verify again.';
    case 'UNCERTAIN':
    default:
      return 'Not enough visual evidence to confirm this step. Move the camera closer or improve the lighting so the relevant component is clearly visible, then verify again.';
  }
};
