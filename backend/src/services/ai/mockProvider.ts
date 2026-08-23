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
import {
  FAULT_LABELS,
  FaultCode,
  ProposeHypothesesInput,
  RawDiagnosticReasoning
} from '../../types/diagnostic';
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

/** One candidate the offline reasoner can emit, before shaping into output. */
interface MockHypothesisSeed {
  code: FaultCode;
  confidence: number;
  rationale: string;
}

/**
 * Deterministic, offline diagnostic reasoning.
 *
 * This is NOT a model. It matches a few keyword patterns in the symptom text
 * (and the perceived device type) to a small set of fault hypotheses, with
 * fixed confidences so tests are repeatable. It exists so the whole diagnostic
 * loop — including hypothesis generation — can run with AI_PROVIDER=mock and no
 * GEMINI_API_KEY, and so the mandated test cases have a deterministic source of
 * hypotheses.
 *
 * It only ever emits codes from the fixed FaultCode vocabulary, and it never
 * proposes a physical action — exactly the same contract the real provider is
 * held to. Output is still returned RAW for the normalizer to validate.
 */
export const mockDiagnosticReasoning = (input: ProposeHypothesesInput): RawDiagnosticReasoning => {
  const haystack = `${input.symptom} ${input.device?.type ?? ''} ${input.observations.join(' ')}`.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((n) => haystack.includes(n));

  const seeds: MockHypothesisSeed[] = [];

  // Not charging / no power at the battery.
  if (has('charg', 'not charging', "won't charge", 'no power', 'dead battery', 'plug')) {
    seeds.push({
      code: 'charging_port_fault',
      confidence: 0.5,
      rationale: 'A charging complaint often points at the port or connector not making contact.'
    });
    seeds.push({
      code: 'power_adapter_fault',
      confidence: 0.42,
      rationale: 'The external adapter or cable is a common cause of a device that will not charge.'
    });
    seeds.push({
      code: 'battery_fault',
      confidence: 0.35,
      rationale: 'A degraded battery can present as a device that no longer holds or takes charge.'
    });
  }

  // Black / blank screen while the device may still be running.
  if (has('black screen', 'blank screen', 'no display', 'screen is black', 'nothing on screen', 'no image')) {
    seeds.push({
      code: 'display_backlight_fault',
      confidence: 0.45,
      rationale: 'A black screen on a device that still powers on frequently indicates a panel or backlight fault.'
    });
    seeds.push({
      code: 'power_adapter_fault',
      confidence: 0.34,
      rationale: 'If the device is not actually powering on, the power source is a candidate before the display.'
    });
    seeds.push({
      code: 'mainboard_no_post',
      confidence: 0.3,
      rationale: 'A mainboard that will not complete power-on can also present as a black screen.'
    });
  }

  // Will not boot / power on / POST.
  if (has("won't boot", 'not boot', 'no boot', "won't turn on", 'not turning on', 'no post', "won't start", 'wont boot')) {
    seeds.push({
      code: 'mainboard_no_post',
      confidence: 0.4,
      rationale: 'A device that will not start at all commonly fails at mainboard power-on / POST.'
    });
    seeds.push({
      code: 'power_adapter_fault',
      confidence: 0.36,
      rationale: 'No power reaching the board from the adapter would also prevent boot.'
    });
    seeds.push({
      code: 'storage_fault',
      confidence: 0.24,
      rationale: 'If it powers but fails to load the OS, the storage drive is a candidate.'
    });
  }

  // Overheating.
  if (has('hot', 'overheat', 'thermal', 'shuts down', 'fan')) {
    seeds.push({
      code: 'thermal_fault',
      confidence: 0.38,
      rationale: 'Heat complaints and unexpected shutdowns point at a cooling or thermal fault.'
    });
  }

  // Wireless / connectivity.
  if (has('wifi', 'wi-fi', 'wireless', 'no internet', 'network', 'bluetooth', 'signal')) {
    seeds.push({
      code: 'wireless_fault',
      confidence: 0.4,
      rationale: 'Connectivity complaints point at the wireless radio, antenna, or adapter.'
    });
  }

  // Nothing matched: stay honest rather than guessing.
  if (seeds.length === 0) {
    seeds.push({
      code: 'unknown',
      confidence: 0.2,
      rationale: 'The offline reasoner has no keyword pattern for this symptom; cause is undetermined.'
    });
  }

  // Deduplicate by code keeping the highest confidence, sort by confidence
  // descending, and cap at five so the shape matches the real provider.
  const byCode = new Map<FaultCode, MockHypothesisSeed>();
  for (const seed of seeds) {
    const existing = byCode.get(seed.code);
    if (!existing || seed.confidence > existing.confidence) byCode.set(seed.code, seed);
  }
  const ranked = [...byCode.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 5);

  const deviceNote = input.device
    ? `Perceived device type: ${input.device.type}.`
    : 'No device was identified from an image; reasoning is from the symptom text only.';

  return {
    observations: [deviceNote],
    hypotheses: ranked.map((seed) => ({
      code: seed.code,
      label: FAULT_LABELS[seed.code],
      confidence: seed.confidence,
      rationale: seed.rationale,
      supportedBy: []
    }))
  };
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

  /**
   * Deterministic offline fault reasoning. Delegates to `mockDiagnosticReasoning`
   * so the same logic is reachable directly from tests without constructing the
   * provider. Returns raw output for the normalizer, exactly like the real
   * provider.
   */
  public async proposeHypotheses(input: ProposeHypothesesInput): Promise<RawDiagnosticReasoning> {
    return mockDiagnosticReasoning(input);
  }
}

export const mockProvider = new MockProvider();
