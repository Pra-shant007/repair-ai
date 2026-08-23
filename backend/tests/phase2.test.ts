/**
 * Phase 2 test suite — repair-step vision verification.
 *
 * No test framework: the repository has none, and dependencies cannot be
 * installed in this environment. This file is compiled together with the
 * backend sources and run with plain `node`. It exits non-zero on any failure.
 *
 * Determinism: no real network and no randomness. The mock provider's outcome
 * is fixed by AI_MOCK_STEP_OUTCOME, set per-case via resetProvider().
 */

import assert from 'assert';

import { demoScenarios } from '../src/data/demoScenarios';
import {
  evaluateStepProgress,
  stepConfidenceThreshold,
  DEFAULT_STEP_CONFIDENCE_THRESHOLD,
  findNextScenarioStep,
  toStepView
} from '../src/services/repairStepService';
import {
  normalizeStepObservation,
  emptyStepObservation
} from '../src/services/ai/normalizer';
import { StepObservation } from '../src/types/ai';
import {
  classifyFramePayload,
  verifyStepWithVision,
  resetProvider
} from '../src/services/aiService';
import { mockProvider } from '../src/services/ai/mockProvider';
import { buildStepPrompt } from '../src/services/ai/geminiProvider';
import { verifyStep } from '../src/controllers/aiController';

let passed = 0;
let failed = 0;
const failures: string[] = [];

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  PASS  ${name}`);
    })
    .catch((err) => {
      failed++;
      failures.push(name);
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err instanceof Error ? err.message : String(err)}`);
    });
};

/** Build a StepObservation directly, bypassing any provider. */
const obs = (over: Partial<StepObservation>): StepObservation => ({
  stepCompleted: false,
  confidence: null,
  observations: [],
  components: [],
  source: 'test',
  warnings: [],
  ...over
});

/** Minimal Express response double that records status + body. */
const makeRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
  return res;
};

/** A base64 string long enough to clear the placeholder cutoff. */
const bigBase64 = (chars: number): string => 'A'.repeat(chars);

const RAM = 'laptop_ram_upgrade'; // 4 steps
const SSD = 'ssd_installation'; // 4 steps
const scenario = demoScenarios[RAM];

async function main() {
  console.log('\n=== repairStepService — the deterministic state machine ===');

  // ---- Case 1: NOT_COMPLETED holds the current step ----
  await test('Case 1: confident stepCompleted=false -> NOT_COMPLETED, step unchanged', () => {
    const d = evaluateStepProgress({
      scenario,
      stepIndex: 1,
      observation: obs({ stepCompleted: false, confidence: 0.9 })
    });
    assert.strictEqual(d.status, 'NOT_COMPLETED');
    assert.strictEqual(d.advanced, false);
    assert.strictEqual(d.currentStep.index, 1);
    assert.strictEqual(d.nextStep, null, 'nextStep must be null so it cannot be mistaken for advance');
    assert.strictEqual(d.persistenceHint.shouldPersist, false);
    assert.strictEqual(d.repairComplete, false);
  });

  // ---- Case 2: COMPLETED returns the next step ----
  await test('Case 2: confident stepCompleted=true -> COMPLETED, next step returned', () => {
    const d = evaluateStepProgress({
      scenario,
      stepIndex: 1,
      observation: obs({ stepCompleted: true, confidence: 0.93 })
    });
    assert.strictEqual(d.status, 'COMPLETED');
    assert.strictEqual(d.advanced, true);
    assert.ok(d.nextStep, 'nextStep must be present');
    assert.strictEqual(d.nextStep!.index, 2);
    // The next step text must come verbatim from the scenario, not be invented.
    assert.strictEqual(d.nextStep!.title, scenario.steps[1].stepTitle);
    assert.strictEqual(d.nextStep!.instruction, scenario.steps[1].stepTitle);
    assert.strictEqual(d.persistenceHint.shouldPersist, true);
    assert.strictEqual(d.persistenceHint.stepIndex, 1);
    assert.strictEqual(d.persistenceHint.isCompleted, true);
  });

  // ---- Case 3: low confidence -> UNCERTAIN, no advancement ----
  await test('Case 3: stepCompleted=true but confidence 0.42 < 0.75 -> UNCERTAIN, no advance', () => {
    const d = evaluateStepProgress({
      scenario,
      stepIndex: 1,
      observation: obs({ stepCompleted: true, confidence: 0.42 })
    });
    assert.strictEqual(d.status, 'UNCERTAIN');
    assert.strictEqual(d.advanced, false);
    assert.strictEqual(d.nextStep, null);
    assert.strictEqual(d.persistenceHint.shouldPersist, false);
  });

  await test('Case 3b: the 0.51 danger case must NOT advance', () => {
    const d = evaluateStepProgress({
      scenario,
      stepIndex: 1,
      observation: obs({ stepCompleted: true, confidence: 0.51 })
    });
    assert.strictEqual(d.status, 'UNCERTAIN');
    assert.strictEqual(d.advanced, false);
  });

  await test('Case 3c: null confidence -> UNCERTAIN even if stepCompleted=true', () => {
    const d = evaluateStepProgress({
      scenario,
      stepIndex: 1,
      observation: obs({ stepCompleted: true, confidence: null })
    });
    assert.strictEqual(d.status, 'UNCERTAIN');
    assert.strictEqual(d.advanced, false);
  });

  // ---- Case 4: last step completed -> repair complete, no phantom next step ----
  await test('Case 4: COMPLETED on final step -> repairComplete, nextStep null, no crash', () => {
    const last = scenario.steps.length; // 4
    const d = evaluateStepProgress({
      scenario,
      stepIndex: last,
      observation: obs({ stepCompleted: true, confidence: 0.95 })
    });
    assert.strictEqual(d.status, 'COMPLETED');
    assert.strictEqual(d.repairComplete, true);
    assert.strictEqual(d.nextStep, null, 'no next step must be fabricated past the end');
    assert.strictEqual(d.persistenceHint.shouldPersist, true);
    // Confirm accessing "next" past the end genuinely yields null, not a throw.
    assert.strictEqual(findNextScenarioStep(scenario, last), null);
  });

  await test('threshold is configurable via AI_STEP_CONFIDENCE_THRESHOLD', () => {
    const original = process.env.AI_STEP_CONFIDENCE_THRESHOLD;
    try {
      process.env.AI_STEP_CONFIDENCE_THRESHOLD = '0.5';
      assert.strictEqual(stepConfidenceThreshold(), 0.5);
      // 0.6 now clears the lowered gate.
      const d = evaluateStepProgress({
        scenario,
        stepIndex: 1,
        observation: obs({ stepCompleted: true, confidence: 0.6 })
      });
      assert.strictEqual(d.status, 'COMPLETED');

      // percentage form accepted
      process.env.AI_STEP_CONFIDENCE_THRESHOLD = '80';
      assert.strictEqual(stepConfidenceThreshold(), 0.8);

      // garbage falls back to the default, never to 0
      process.env.AI_STEP_CONFIDENCE_THRESHOLD = 'not-a-number';
      assert.strictEqual(stepConfidenceThreshold(), DEFAULT_STEP_CONFIDENCE_THRESHOLD);
      process.env.AI_STEP_CONFIDENCE_THRESHOLD = '-5';
      assert.strictEqual(stepConfidenceThreshold(), DEFAULT_STEP_CONFIDENCE_THRESHOLD);
    } finally {
      if (original === undefined) delete process.env.AI_STEP_CONFIDENCE_THRESHOLD;
      else process.env.AI_STEP_CONFIDENCE_THRESHOLD = original;
    }
  });

  await test('non-contiguous next-step lookup is positional, and warningText matches risk', () => {
    // Step 2 of the RAM scenario is high risk in the data.
    const step2 = scenario.steps.find((s) => s.stepIndex === 2)!;
    const view = toStepView(step2);
    assert.strictEqual(view.safetyRisk, 'high');
    assert.strictEqual(view.warningText, 'HIGH RISK STEP WARNING');
    const safeStep = scenario.steps.find((s) => s.safetyRisk === 'safe')!;
    assert.strictEqual(toStepView(safeStep).warningText, null);
  });

  console.log('\n=== normalizer — untrusted step output ===');

  await test('non-object response fails closed', () => {
    const o = normalizeStepObservation('nonsense', 'gemini');
    assert.strictEqual(o.stepCompleted, false);
    assert.strictEqual(o.confidence, null);
    assert.ok(o.warnings.length > 0);
  });

  await test('missing verdict -> stepCompleted false with warning (never guessed true)', () => {
    const o = normalizeStepObservation({ confidence: 0.9 }, 'gemini');
    assert.strictEqual(o.stepCompleted, false);
    assert.ok(o.warnings.some((w) => /verdict/i.test(w)));
  });

  await test('percentage confidence is rescaled to 0..1', () => {
    const o = normalizeStepObservation({ stepCompleted: true, confidence: 91 }, 'gemini');
    assert.strictEqual(o.confidence, 0.91);
  });

  await test('string "true"/"false" verdicts are accepted', () => {
    assert.strictEqual(normalizeStepObservation({ stepCompleted: 'true', confidence: 0.9 }, 'x').stepCompleted, true);
    assert.strictEqual(normalizeStepObservation({ stepCompleted: 'false', confidence: 0.9 }, 'x').stepCompleted, false);
  });

  await test('out-of-range confidence is rejected to null', () => {
    assert.strictEqual(normalizeStepObservation({ stepCompleted: true, confidence: 150 }, 'x').confidence, null);
    assert.strictEqual(normalizeStepObservation({ stepCompleted: true, confidence: -1 }, 'x').confidence, null);
  });

  await test('observations flood is capped and a single string is accepted', () => {
    const many = Array.from({ length: 50 }, (_, i) => `note ${i}`);
    const o = normalizeStepObservation({ stepCompleted: true, confidence: 0.9, observations: many }, 'x');
    assert.ok(o.observations.length <= 8);
    const single = normalizeStepObservation({ stepCompleted: true, confidence: 0.9, observations: 'just one' }, 'x');
    assert.deepStrictEqual(single.observations, ['just one']);
  });

  await test('components with box_2d-mapped boxes survive normalization; junk is dropped', () => {
    const o = normalizeStepObservation(
      {
        stepCompleted: true,
        confidence: 0.9,
        components: [
          { name: 'battery connector', confidence: 0.93, boundingBox: { x: 0.42, y: 0.31, width: 0.12, height: 0.08 } },
          { name: 'no box here', confidence: 0.5 },
          'garbage'
        ]
      },
      'gemini'
    );
    assert.strictEqual(o.components.length, 1);
    assert.strictEqual(o.components[0].name, 'battery connector');
    assert.ok(o.components[0].boundingBox.x > 0.41 && o.components[0].boundingBox.x < 0.43);
  });

  await test('emptyStepObservation is fail-closed', () => {
    const o = emptyStepObservation('gemini', ['boom']);
    assert.strictEqual(o.stepCompleted, false);
    assert.strictEqual(o.confidence, null);
  });

  await test("provider's own warnings are carried through, not discarded", () => {
    const o = normalizeStepObservation(
      { stepCompleted: false, confidence: 0.4, warnings: ['The relevant component is not clearly visible.'] },
      'gemini'
    );
    assert.ok(
      o.warnings.some((w) => /not clearly visible/i.test(w)),
      'a model-supplied warning must reach the caller'
    );
  });

  console.log('\n=== aiService.classifyFramePayload — frame transport ===');

  await test('absent frame -> absent', () => {
    assert.strictEqual(classifyFramePayload(undefined).kind, 'absent');
    assert.strictEqual(classifyFramePayload('').kind, 'absent');
    assert.strictEqual(classifyFramePayload('   ').kind, 'absent');
  });

  await test("frontend's truncated literal is a placeholder, not an error", () => {
    // This is exactly what frontend/diagnose posts today.
    const c = classifyFramePayload('data:image/png;base64,iVBORw0KGgo...');
    assert.strictEqual(c.kind, 'placeholder');
  });

  await test("CameraFeed's 1x1 PNG simulation frame is a placeholder", () => {
    const oneByOne =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    assert.strictEqual(classifyFramePayload(oneByOne).kind, 'placeholder');
  });

  await test('a large but non-base64 payload is invalid (400 material)', () => {
    const c = classifyFramePayload('data:image/jpeg;base64,' + '!@#$'.repeat(400));
    assert.strictEqual(c.kind, 'invalid');
  });

  await test('a large valid-base64 JPEG is accepted as an image', () => {
    const c = classifyFramePayload('data:image/jpeg;base64,' + bigBase64(2000));
    assert.strictEqual(c.kind, 'image');
    if (c.kind === 'image') assert.strictEqual(c.image.mimeType, 'image/jpeg');
  });

  console.log('\n=== aiService.verifyStepWithVision — mock provider outcomes (deterministic) ===');

  const withMockOutcome = async (
    outcome: string,
    fn: () => Promise<void>
  ): Promise<void> => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevOutcome = process.env.AI_MOCK_STEP_OUTCOME;
    process.env.AI_PROVIDER = 'mock';
    process.env.AI_MOCK_STEP_OUTCOME = outcome;
    resetProvider();
    try {
      await fn();
    } finally {
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      if (prevOutcome === undefined) delete process.env.AI_MOCK_STEP_OUTCOME;
      else process.env.AI_MOCK_STEP_OUTCOME = prevOutcome;
      resetProvider();
    }
  };

  const image = { data: bigBase64(2000), mimeType: 'image/jpeg' };

  await test('mock "completed" -> COMPLETED via evaluator, timings recorded', async () => {
    await withMockOutcome('completed', async () => {
      const { observation, timings } = await verifyStepWithVision({
        image,
        step: { stepIndex: 1, stepTitle: scenario.steps[0].stepTitle, verificationTrigger: 'screws_removed' },
        scenarioId: RAM
      });
      assert.strictEqual(observation.stepCompleted, true);
      assert.strictEqual(observation.source, 'mock');
      assert.ok(observation.warnings.some((w) => /mock/i.test(w)), 'mock output must announce itself');
      const d = evaluateStepProgress({ scenario, stepIndex: 1, observation });
      assert.strictEqual(d.status, 'COMPLETED');
      assert.strictEqual(typeof timings.totalMs, 'number');
      assert.ok(timings.totalMs >= 0);
    });
  });

  await test('mock "not_completed" -> NOT_COMPLETED', async () => {
    await withMockOutcome('not_completed', async () => {
      const { observation } = await verifyStepWithVision({
        image,
        step: { stepIndex: 1 },
        scenarioId: RAM
      });
      const d = evaluateStepProgress({ scenario, stepIndex: 1, observation });
      assert.strictEqual(d.status, 'NOT_COMPLETED');
    });
  });

  await test('mock "uncertain" -> UNCERTAIN, no advance', async () => {
    await withMockOutcome('uncertain', async () => {
      const { observation } = await verifyStepWithVision({
        image,
        step: { stepIndex: 1 },
        scenarioId: RAM
      });
      assert.ok(observation.confidence !== null && observation.confidence < 0.75);
      const d = evaluateStepProgress({ scenario, stepIndex: 1, observation });
      assert.strictEqual(d.status, 'UNCERTAIN');
      assert.strictEqual(d.advanced, false);
    });
  });

  console.log('\n=== Case 6: real provider failure is controlled and never advances ===');

  await test('Case 6: Gemini failure -> fail-closed observation, no throw, UNCERTAIN', async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevKey = process.env.GEMINI_API_KEY;
    // Force the real Gemini provider with an obviously fake key. Network egress
    // is blocked here, so the call fails fast without contacting anything real
    // and without consuming any quota.
    delete process.env.AI_PROVIDER;
    process.env.GEMINI_API_KEY = 'AIzaFAKE_key_for_failure_path_only_000000';
    resetProvider();
    try {
      const { observation, timings } = await verifyStepWithVision({
        image,
        step: { stepIndex: 1, stepTitle: scenario.steps[0].stepTitle },
        scenarioId: RAM
      });
      assert.strictEqual(observation.source, 'gemini');
      assert.strictEqual(observation.stepCompleted, false, 'a failed call must never report completion');
      assert.strictEqual(observation.confidence, null);
      assert.ok(observation.warnings.length > 0);
      assert.ok(typeof timings.totalMs === 'number');
      const d = evaluateStepProgress({ scenario, stepIndex: 1, observation });
      assert.strictEqual(d.status, 'UNCERTAIN');
      assert.strictEqual(d.advanced, false);
    } finally {
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
      resetProvider();
    }
  });

  await test('secret hygiene: a fake key never appears in a thrown/logged failure detail', async () => {
    // Re-run the failure path and confirm the key is not surfaced anywhere in
    // the observation we return to callers.
    const prevProvider = process.env.AI_PROVIDER;
    const prevKey = process.env.GEMINI_API_KEY;
    const fake = 'AIzaSECRETmustnotleak12345678901234567890';
    delete process.env.AI_PROVIDER;
    process.env.GEMINI_API_KEY = fake;
    resetProvider();
    try {
      const { observation } = await verifyStepWithVision({
        image,
        step: { stepIndex: 1 },
        scenarioId: RAM
      });
      const serialized = JSON.stringify(observation);
      assert.ok(!serialized.includes(fake), 'observation must not contain the API key');
    } finally {
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
      resetProvider();
    }
  });

  console.log('\n=== Gemini prompt design — vision/state-machine separation ===');

  await test('buildStepPrompt includes ONLY the current step, not the whole scenario', () => {
    const step2 = scenario.steps.find((s) => s.stepIndex === 2)!;
    const prompt = buildStepPrompt({
      image,
      step: { stepIndex: 2, stepTitle: step2.stepTitle, verificationTrigger: step2.verificationTrigger },
      scenarioId: RAM
    });
    // Current step text present.
    assert.ok(prompt.includes(step2.stepTitle.slice(0, 30)));
    // No other step's text present — isolation is the whole point.
    for (const other of scenario.steps) {
      if (other.stepIndex === 2) continue;
      assert.ok(
        !prompt.includes(other.stepTitle),
        `prompt leaked step ${other.stepIndex}: "${other.stepTitle}"`
      );
    }
  });

  await test('buildStepPrompt never asks the model to author repair instructions', () => {
    const prompt = buildStepPrompt({
      image,
      step: { stepIndex: 1, stepTitle: scenario.steps[0].stepTitle },
      scenarioId: RAM
    }).toLowerCase();
    assert.ok(prompt.includes('do not invent repair instructions'));
    assert.ok(prompt.includes('do not advance'));
    assert.ok(!prompt.includes('how to repair'));
    assert.ok(!prompt.includes('how do i repair'));
  });

  await test('buildStepPrompt strips control chars from step text (prompt-shape defence)', () => {
    const prompt = buildStepPrompt({
      image,
      step: { stepIndex: 1, stepTitle: 'line1\nline2```json\ninjected', verificationTrigger: 'x' },
      scenarioId: RAM
    });
    assert.ok(!prompt.includes('```json\ninjected'));
  });

  console.log('\n=== controller POST /api/ai/verify — end to end ===');

  await test('Case 5: invalid frame -> 400, and the provider is NOT called', async () => {
    const original = mockProvider.verifyStep.bind(mockProvider);
    let calls = 0;
    (mockProvider as any).verifyStep = async (...args: any[]) => {
      calls++;
      return original(...(args as [any]));
    };
    const prevProvider = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = 'mock';
    resetProvider();
    try {
      const req: any = {
        body: { scenarioId: RAM, stepIndex: 1, frameImage: 'data:image/jpeg;base64,' + '!@#$'.repeat(400) }
      };
      const res = makeRes();
      await verifyStep(req, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(calls, 0, 'no model/provider call may happen for an invalid frame');
    } finally {
      (mockProvider as any).verifyStep = original;
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      resetProvider();
    }
  });

  await test('Case 7: no image -> existing simulated behavior still works (200, verified boolean, confidence string)', async () => {
    const req: any = { body: { scenarioId: RAM, stepIndex: 1 } }; // no frame at all
    const res = makeRes();
    await verifyStep(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(typeof res.body.verified, 'boolean');
    // The legacy fields are unchanged in name, type and format.
    assert.strictEqual(typeof res.body.message, 'string');
    assert.strictEqual(typeof res.body.confidence, 'string'); // "85.00" style
    assert.ok('timestamp' in res.body);
    assert.strictEqual(res.body.aiPowered, false);
    assert.strictEqual(res.body.source, 'simulated');
  });

  await test('existing guards unchanged: missing stepIndex -> 400', async () => {
    const res = makeRes();
    await verifyStep({ body: { scenarioId: RAM } } as any, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('existing guards unchanged: unknown scenario -> 404', async () => {
    const res = makeRes();
    await verifyStep({ body: { scenarioId: 'nope', stepIndex: 1 } } as any, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('existing guards unchanged: step out of range -> 404', async () => {
    const res = makeRes();
    await verifyStep({ body: { scenarioId: RAM, stepIndex: 99 } } as any, res);
    assert.strictEqual(res.statusCode, 404);
  });

  await test('real-frame path (mock provider, completed) -> 200 with nextStep + additive fields', async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevOutcome = process.env.AI_MOCK_STEP_OUTCOME;
    process.env.AI_PROVIDER = 'mock';
    process.env.AI_MOCK_STEP_OUTCOME = 'completed';
    resetProvider();
    try {
      const req: any = {
        body: { scenarioId: SSD, stepIndex: 1, frameImage: 'data:image/jpeg;base64,' + bigBase64(2000) }
      };
      const res = makeRes();
      await verifyStep(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.verified, true);
      assert.strictEqual(res.body.status, 'COMPLETED');
      assert.strictEqual(res.body.aiPowered, true);
      assert.ok(res.body.nextStep, 'nextStep present on completion');
      assert.strictEqual(res.body.nextStep.index, 2);
      assert.strictEqual(res.body.nextStep.title, demoScenarios[SSD].steps[1].stepTitle);
      assert.ok(Array.isArray(res.body.observations));
      assert.ok(Array.isArray(res.body.components));
      assert.ok(res.body.persistenceHint.shouldPersist);
      assert.ok(res.body.timings && typeof res.body.timings.totalMs === 'number');
      // legacy fields still present and correctly typed
      assert.strictEqual(typeof res.body.confidence, 'string');
    } finally {
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      if (prevOutcome === undefined) delete process.env.AI_MOCK_STEP_OUTCOME;
      else process.env.AI_MOCK_STEP_OUTCOME = prevOutcome;
      resetProvider();
    }
  });

  await test('real-frame path (mock provider, uncertain) -> 200, verified false, no nextStep', async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevOutcome = process.env.AI_MOCK_STEP_OUTCOME;
    process.env.AI_PROVIDER = 'mock';
    process.env.AI_MOCK_STEP_OUTCOME = 'uncertain';
    resetProvider();
    try {
      const req: any = {
        body: { scenarioId: SSD, stepIndex: 1, frameImage: 'data:image/jpeg;base64,' + bigBase64(2000) }
      };
      const res = makeRes();
      await verifyStep(req, res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'UNCERTAIN');
      assert.strictEqual(res.body.verified, false);
      assert.strictEqual(res.body.nextStep, null);
      assert.strictEqual(res.body.persistenceHint.shouldPersist, false);
    } finally {
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      if (prevOutcome === undefined) delete process.env.AI_MOCK_STEP_OUTCOME;
      else process.env.AI_MOCK_STEP_OUTCOME = prevOutcome;
      resetProvider();
    }
  });

  console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
