/**
 * Offline AI provider used when no GEMINI_API_KEY is configured, when
 * AI_PROVIDER=mock, or as a fallback when a real provider call fails.
 *
 * It reuses the repository's existing `demoScenarios` data — the scenario
 * dictionary is NOT duplicated here. It only reshapes that data into the
 * provider-neutral contract; it never invents a device or a scenario.
 */

import { DEMO_BBOX_REFERENCE, demoScenarios } from '../../data/demoScenarios';
import {
  AnalyzeFrameInput,
  RawProviderDetection,
  RawStepVerification,
  VerifyStepInput
} from '../../types/ai';
import { AiProvider } from './aiProvider';

/**
 * Reshape an existing demo scenario into provider-shaped output.
 *
 * Exported so the legacy (no-image) code path can produce the same normalized
 * `detectedComponents` without pretending an AI call happened. Returns an empty
 * result for an unknown or missing scenario id — a device is never guessed.
 */
export const scenarioDetection = (scenarioId?: string): RawProviderDetection => {
  const scenario = scenarioId ? demoScenarios[scenarioId] : undefined;
  if (!scenario) {
    return { device: null, components: [] };
  }

  const components = scenario.components.map((component) => {
    const [x, y, width, height] = component.bbox;
    return {
      name: component.name,
      confidence: component.confidence,
      // Demo boxes are absolute pixels against the reference canvas the
      // frontend already assumes; convert them to 0..1 fractions.
      boundingBox: {
        x: x / DEMO_BBOX_REFERENCE.width,
        y: y / DEMO_BBOX_REFERENCE.height,
        width: width / DEMO_BBOX_REFERENCE.width,
        height: height / DEMO_BBOX_REFERENCE.height
      }
    };
  });

  return {
    device: {
      type: scenario.deviceType,
      model: scenario.deviceName,
      confidence: scenario.confidenceScore / 100
    },
    components
  };
};

/**
 * The three outcomes Phase 2 has to be able to exercise without Gemini.
 *
 * Chosen by the AI_MOCK_STEP_OUTCOME environment variable, NEVER by anything in
 * the request body: letting a client pick its own verification outcome would be
 * a trivial way to force a repair to advance.
 */
export type MockStepOutcome = 'completed' | 'not_completed' | 'uncertain';

/**
 * Fixed values, no randomness anywhere, so tests are repeatable.
 *
 * `uncertain` reports a real (low) confidence rather than omitting it, because
 * that is the harder case for the evaluator: a confident-sounding
 * `stepCompleted: true` paired with 0.42 confidence must still refuse to
 * advance the repair.
 */
const MOCK_STEP_OUTCOMES: Record<MockStepOutcome, { stepCompleted: boolean; confidence: number }> = {
  completed: { stepCompleted: true, confidence: 0.93 },
  not_completed: { stepCompleted: false, confidence: 0.88 },
  uncertain: { stepCompleted: true, confidence: 0.42 }
};

/** Read the configured outcome, defaulting to `completed` for demo runs. */
export const mockStepOutcome = (): MockStepOutcome => {
  const requested = (process.env.AI_MOCK_STEP_OUTCOME || '').trim().toLowerCase();
  if (requested === 'not_completed' || requested === 'uncertain' || requested === 'completed') {
    return requested;
  }
  return 'completed';
};

export class MockProvider implements AiProvider {
  public readonly name = 'mock';

  /**
   * Returns scenario data shaped like provider output. The result still goes
   * through the normalizer so the mock path and the real path are validated
   * identically.
   */
  public async analyzeFrame(input: AnalyzeFrameInput): Promise<RawProviderDetection> {
    return scenarioDetection(input.scenarioId);
  }

  /**
   * Deterministic stand-in for real visual step verification.
   *
   * It performs no visual analysis at all — the frame is accepted and ignored —
   * so every response carries a warning saying so. That warning is what stops a
   * demo run (no GEMINI_API_KEY configured) from being mistaken for a real
   * verification.
   *
   * Components come from the existing scenario data, which keeps the bounding
   * box path exercised end to end without inventing coordinates.
   */
  public async verifyStep(input: VerifyStepInput): Promise<RawStepVerification> {
    const outcome = mockStepOutcome();
    const { stepCompleted, confidence } = MOCK_STEP_OUTCOMES[outcome];

    const detection = scenarioDetection(input.scenarioId) as {
      components?: unknown[];
    };

    const trigger = input.step.verificationTrigger;
    const observations = [
      `Mock provider returned the fixed "${outcome}" outcome for step ${input.step.stepIndex}${
        trigger ? ` (trigger "${trigger}")` : ''
      }.`
    ];

    return {
      stepCompleted,
      confidence,
      observations,
      components: detection.components ?? [],
      warnings: [
        'Mock provider: this outcome is preconfigured, not the result of looking at the frame.'
      ]
    };
  }
}

export const mockProvider = new MockProvider();
