/**
 * Diagnostic copilot test suite — the 14 mandated cases.
 *
 * Same conventions as discovery.test.ts / phase2.test.ts: no test framework (the
 * repo has none and dependencies cannot be installed here), compiled with the
 * backend sources and run with plain `node`. Exits non-zero on any failure.
 *
 * Determinism: no real network and no randomness anywhere.
 *   - AI_PROVIDER is forced to `mock` and GEMINI_API_KEY removed, so the offline
 *     deterministic reasoner answers instead of Gemini;
 *   - where a specific device identification or a specific set of hypotheses is
 *     needed, mockProvider.analyzeFrame / mockProvider.proposeHypotheses are
 *     temporarily replaced with fixed stubs and restored in `finally`;
 *   - the selector and normalizer are pure, so their tests call them directly.
 */

import assert from 'assert';

import { DIAGNOSTIC_TESTS, getTestById } from '../src/services/diagnostic/diagnosticTests';
import {
  applicableTests,
  compareBySafety,
  isAutoSelectable,
  selectNextTest
} from '../src/services/diagnostic/diagnosticTestSelector';
import {
  createSession,
  getSession,
  resetStoreForTests,
  sessionCount,
  setSessionTtlMsForTests,
  sweepExpired
} from '../src/services/diagnostic/diagnosticSessionStore';
import { mockDiagnosticReasoning, mockProvider } from '../src/services/ai/mockProvider';
import { normalizeDiagnosticReasoning } from '../src/services/ai/normalizer';
import { resetProvider } from '../src/services/aiService';
import { diagnose, linkDiagnosisRepair, submitDiagnosisResult } from '../src/controllers/diagnosticController';
import { DiagnosisSessionView, FAULT_CODES, FaultCode } from '../src/types/diagnostic';
import { connectDB } from '../src/config/db';

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

// ---------- builders ----------

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

/** A large, valid base64 JPEG data URL — passes parseImagePayload. */
const IMAGE = 'data:image/jpeg;base64,' + 'A'.repeat(2000);
/** Too short to be a real frame — classified as `placeholder`. */
const TINY_IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

/** Raw provider-shaped detection for a device the demo catalog does not cover. */
const rawDevice = (
  type: string,
  extra: Record<string, unknown> = {},
  components: unknown[] = []
) => ({
  device: { type, confidence: 0.9, ...extra },
  components
});

const box = { x: 0.4, y: 0.35, width: 0.3, height: 0.1 };
const rawComp = (name: string, confidence = 0.9) => ({ name, confidence, boundingBox: box });

/**
 * Run `fn` with the offline provider forced on, and optionally with
 * analyzeFrame / proposeHypotheses replaced by fixed stubs. Everything is
 * restored in `finally` so tests cannot leak state into each other.
 */
const withStubs = async (
  stubs: { detection?: unknown; reasoning?: unknown },
  fn: () => Promise<void>
) => {
  const prevProvider = process.env.AI_PROVIDER;
  const prevKey = process.env.GEMINI_API_KEY;
  const originalAnalyze = mockProvider.analyzeFrame;
  const originalPropose = mockProvider.proposeHypotheses;

  process.env.AI_PROVIDER = 'mock';
  delete process.env.GEMINI_API_KEY;
  if (stubs.detection !== undefined) {
    (mockProvider as any).analyzeFrame = async () => stubs.detection;
  }
  if (stubs.reasoning !== undefined) {
    (mockProvider as any).proposeHypotheses = async () => stubs.reasoning;
  }
  resetProvider();

  try {
    await fn();
  } finally {
    (mockProvider as any).analyzeFrame = originalAnalyze;
    (mockProvider as any).proposeHypotheses = originalPropose;
    if (prevProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = prevProvider;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    resetProvider();
  }
};

/** POST /api/ai/diagnose and return the session view (asserting HTTP 200). */
const startDiagnose = async (body: Record<string, unknown>): Promise<DiagnosisSessionView> => {
  const res = makeRes();
  await diagnose({ body } as any, res);
  assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  return res.body.session as DiagnosisSessionView;
};

/** POST a test result and return the updated session view (asserting HTTP 200). */
const postResult = async (
  sessionId: string,
  answer: string
): Promise<DiagnosisSessionView> => {
  const res = makeRes();
  await submitDiagnosisResult({ params: { sessionId }, body: { answer } } as any, res);
  assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  return res.body.session as DiagnosisSessionView;
};

/** Confidence of a specific hypothesis in a view, or null when absent. */
const confidenceOf = (view: DiagnosisSessionView, code: FaultCode): number | null =>
  view.hypotheses.find((h) => h.code === code)?.confidence ?? null;

/** A minimal session seed for store-level tests. */
const seedSession = () =>
  createSession({
    device: null,
    deviceType: null,
    symptomText: 'test',
    observations: [],
    hypotheses: [],
    testsPerformed: [],
    currentTestId: null,
    testResults: [],
    status: 'DIAGNOSING',
    likelyFault: null,
    repairRecommendation: null,
    procedure: { status: 'UNAVAILABLE', reason: 'test' },
    nextBestAction: { kind: 'ASK_USER', prompt: 'test' },
    linkedRepairId: null
  });

async function main() {
  // Force the in-memory DB so nothing dials a real MongoDB.
  delete process.env.MONGODB_URI;
  await connectDB();

  console.log('\n--- 1-3. symptom-driven diagnosis on real device types ---\n');

  await test('1. laptop black-screen symptom produces display/power hypotheses and a safe next action', async () => {
    await withStubs({ detection: rawDevice('Laptop') }, async () => {
      const view = await startDiagnose({
        image: IMAGE,
        userDescription: 'My laptop turns on but the screen is black.'
      });

      assert.ok(view.hypotheses.length > 0, 'expected at least one hypothesis');
      const codes = view.hypotheses.map((h) => h.code);
      assert.ok(
        codes.includes('display_backlight_fault'),
        `expected a display hypothesis, got ${codes.join(', ')}`
      );
      // Not confident yet -> must be asking for a test, not claiming a diagnosis.
      assert.strictEqual(view.nextBestAction.kind, 'DIAGNOSTIC_TEST');
      assert.strictEqual(view.likelyFault, null);
      if (view.nextBestAction.kind === 'DIAGNOSTIC_TEST') {
        assert.strictEqual(view.nextBestAction.riskLevel, 'safe');
      }
      assert.strictEqual(view.deviceType, 'Laptop');
    });
  });

  await test('2. phone not charging produces port/adapter/battery hypotheses', async () => {
    await withStubs({ detection: rawDevice('Smartphone') }, async () => {
      const view = await startDiagnose({
        image: IMAGE,
        userDescription: 'My phone is not charging when I plug it in.'
      });

      const codes = view.hypotheses.map((h) => h.code);
      assert.ok(codes.includes('charging_port_fault'), `got ${codes.join(', ')}`);
      assert.ok(codes.includes('power_adapter_fault'), `got ${codes.join(', ')}`);
      assert.strictEqual(view.nextBestAction.kind, 'DIAGNOSTIC_TEST');
    });
  });

  await test("3. desktop won't boot produces no-POST/power hypotheses", async () => {
    await withStubs({ detection: rawDevice('Desktop PC') }, async () => {
      const view = await startDiagnose({
        image: IMAGE,
        userDescription: "My desktop won't boot at all."
      });

      const codes = view.hypotheses.map((h) => h.code);
      assert.ok(codes.includes('mainboard_no_post'), `got ${codes.join(', ')}`);
      assert.strictEqual(view.nextBestAction.kind, 'DIAGNOSTIC_TEST');
    });
  });

  console.log('\n--- 4-5. arbitrary devices and weak evidence ---\n');

  await test('4. unknown device still diagnoses, but no grounded procedure is offered', async () => {
    await withStubs({ detection: rawDevice('Espresso Machine') }, async () => {
      const view = await startDiagnose({
        image: IMAGE,
        userDescription: 'It is not charging and shows no lights.'
      });

      // Diagnosis still happens for a device outside the demo catalog...
      assert.ok(view.hypotheses.length > 0, 'expected hypotheses for an unsupported device');
      assert.strictEqual(view.deviceType, 'Espresso Machine');
      // ...but no step-by-step procedure is ever offered for it.
      assert.strictEqual(view.procedure.status, 'UNAVAILABLE');
      assert.notStrictEqual(view.nextBestAction.kind, 'REPAIR_STEP');
    });
  });

  await test('5. insufficient visual evidence: unusable frame + no symptom asks for a better frame', async () => {
    await withStubs({}, async () => {
      const view = await startDiagnose({ image: TINY_IMAGE, userDescription: '   ' });

      assert.strictEqual(view.status, 'NEEDS_VISUAL_EVIDENCE');
      assert.strictEqual(view.nextBestAction.kind, 'RETRY_CAMERA');
      assert.strictEqual(view.hypotheses.length, 0, 'no hypotheses without any evidence');
      assert.strictEqual(view.likelyFault, null);
      assert.strictEqual(view.procedure.status, 'UNAVAILABLE');
    });
  });

  await test('5b. unusable frame WITH a symptom still diagnoses generically', async () => {
    await withStubs({}, async () => {
      const view = await startDiagnose({
        image: TINY_IMAGE,
        userDescription: 'The screen is black but I hear the fan.'
      });

      assert.ok(view.hypotheses.length > 0, 'a symptom alone must be enough to reason');
      assert.strictEqual(view.device, null, 'no device should be invented from an unusable frame');
      assert.strictEqual(view.procedure.status, 'UNAVAILABLE');
    });
  });

  console.log('\n--- 6-7. safety gate and weak hypotheses ---\n');

  await test('6. unsafe action rejection: gated tests are never auto-selected', () => {
    const disassembly = getTestById('reseat_internal_module');
    const livePower = getTestById('measure_adapter_output');
    assert.ok(disassembly && livePower, 'both gated tests must exist in the catalog');
    assert.strictEqual(isAutoSelectable(disassembly!), false, 'disassembly must be gated');
    assert.strictEqual(isAutoSelectable(livePower!), false, 'power manipulation must be gated');

    // A context whose ONLY applicable tests are gated must not yield a TEST.
    const decision = selectNextTest({
      deviceType: 'Laptop',
      hypothesisCodes: ['loose_connection'],
      testsPerformed: []
    });
    assert.strictEqual(decision.kind, 'ONLY_UNSAFE', `got ${decision.kind}`);
    if (decision.kind === 'ONLY_UNSAFE') {
      assert.ok(
        decision.blocked.requiresDisassembly || decision.blocked.requiresPowerManipulation,
        'the blocked test must be gated for a physical reason'
      );
    }

    // And no auto-selected test anywhere in the catalog may be high risk.
    for (const t of DIAGNOSTIC_TESTS.filter(isAutoSelectable)) {
      assert.notStrictEqual(t.riskLevel, 'high', `${t.id} is high risk but auto-selectable`);
      assert.strictEqual(t.requiresPowerManipulation, false, `${t.id} manipulates power`);
      assert.strictEqual(t.requiresDisassembly, false, `${t.id} requires disassembly`);
    }
  });

  await test('6b. service-level: only-gated evidence stops instead of guiding', async () => {
    await withStubs(
      {
        detection: rawDevice('Laptop'),
        reasoning: {
          observations: [],
          // loose_connection is only testable by the disassembly test.
          hypotheses: [{ code: 'loose_connection', confidence: 0.4, rationale: 'stub', label: 'Loose' }]
        }
      },
      async () => {
        const view = await startDiagnose({ image: IMAGE, userDescription: 'Something is loose inside.' });

        assert.strictEqual(view.status, 'UNSAFE_TO_GUIDE');
        assert.strictEqual(view.nextBestAction.kind, 'STOP_UNSAFE');
        assert.strictEqual(view.currentTestId, null, 'no gated test may be pending');
        // The stated reason must match why the check was actually gated. This
        // one is gated by disassembly, not by live power.
        if (view.nextBestAction.kind === 'STOP_UNSAFE') {
          assert.ok(
            /opening the device/i.test(view.nextBestAction.reason),
            `reason should name disassembly, got: ${view.nextBestAction.reason}`
          );
          assert.ok(
            !/electrical power/i.test(view.nextBestAction.reason),
            'must not claim live power for a disassembly-gated check'
          );
        }
      }
    );
  });

  await test('7. low-confidence hypothesis is never reported as a confirmed diagnosis', async () => {
    await withStubs(
      {
        detection: rawDevice('Laptop'),
        reasoning: {
          observations: [],
          hypotheses: [{ code: 'thermal_fault', confidence: 0.08, rationale: 'stub', label: 'Thermal' }]
        }
      },
      async () => {
        const view = await startDiagnose({ image: IMAGE, userDescription: 'It feels warm sometimes.' });

        assert.notStrictEqual(view.status, 'CONFIRMED');
        assert.strictEqual(view.likelyFault, null, 'a weak hypothesis must not become the diagnosis');
      }
    );
  });

  console.log('\n--- 8-9. deterministic hypothesis updates and test ordering ---\n');

  await test('8. a test result deterministically updates hypothesis confidences', async () => {
    await withStubs(
      {
        detection: rawDevice('Smartphone'),
        reasoning: {
          observations: [],
          hypotheses: [
            { code: 'power_adapter_fault', confidence: 0.4, rationale: 'stub', label: 'Adapter' },
            { code: 'charging_port_fault', confidence: 0.4, rationale: 'stub', label: 'Port' }
          ]
        }
      },
      async () => {
        const start = await startDiagnose({
          image: IMAGE,
          userDescription: 'The phone is not charging.'
        });
        assert.strictEqual(start.nextBestAction.kind, 'DIAGNOSTIC_TEST');
        const testId = start.currentTestId!;
        const chosen = getTestById(testId)!;
        const before = confidenceOf(start, 'power_adapter_fault')!;

        const after = await postResult(start.sessionId, 'yes');

        // The catalog's own interpretation is the source of truth for the delta.
        const expectedDelta =
          chosen.interpret('yes').find((e) => e.code === 'power_adapter_fault')?.delta ?? 0;
        const actual = confidenceOf(after, 'power_adapter_fault');
        if (expectedDelta === 0) {
          assert.strictEqual(actual, before, 'no delta means no change');
        } else {
          assert.notStrictEqual(actual, before, 'confidence should have moved');
          assert.ok(
            expectedDelta > 0 ? actual! > before : actual! < before,
            `expected movement in the direction of ${expectedDelta}, ${before} -> ${actual}`
          );
        }
        assert.ok(after.testsPerformed.includes(testId), 'the test must be recorded as performed');
        assert.notStrictEqual(after.currentTestId, testId, 'the same test must not be re-asked');
      }
    );
  });

  await test('8b. answering the same test twice is rejected, not double-counted', async () => {
    await withStubs({ detection: rawDevice('Smartphone') }, async () => {
      const start = await startDiagnose({
        image: IMAGE,
        userDescription: 'The phone is not charging.'
      });
      const first = await postResult(start.sessionId, 'yes');
      assert.ok(first.testsPerformed.length === 1);

      // A replay of the same answer for the now-resolved test must be refused.
      const res = makeRes();
      await submitDiagnosisResult(
        { params: { sessionId: start.sessionId }, body: { answer: 'yes', testId: start.currentTestId } } as any,
        res
      );
      assert.strictEqual(res.statusCode, 409, `expected 409, got ${res.statusCode}`);
    });
  });

  await test('9. selector is deterministic and safety-first ordered', () => {
    const ctx = {
      deviceType: 'Laptop',
      hypothesisCodes: ['display_backlight_fault', 'mainboard_no_post', 'power_adapter_fault'] as FaultCode[],
      testsPerformed: [] as string[]
    };

    // Same input, same output, every time.
    const first = selectNextTest(ctx);
    for (let i = 0; i < 5; i++) {
      const again = selectNextTest(ctx);
      assert.strictEqual(again.kind, first.kind);
      if (first.kind === 'TEST' && again.kind === 'TEST') {
        assert.strictEqual(again.test.id, first.test.id, 'selection must be stable');
      }
    }

    assert.strictEqual(first.kind, 'TEST');
    if (first.kind === 'TEST') {
      assert.strictEqual(first.test.riskLevel, 'safe', 'the safest test must win');
      assert.strictEqual(first.test.requiresDisassembly, false);
      assert.strictEqual(first.test.requiresPowerManipulation, false);
    }

    // The ordering itself: risk dominates, then reversibility, then disassembly,
    // then power, then difficulty, then information value.
    const ordered = applicableTests(ctx);
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(
        compareBySafety(ordered[i - 1], ordered[i]) <= 0,
        `${ordered[i - 1].id} should not rank after ${ordered[i].id}`
      );
    }
    const risks = ordered.map((t) => ({ safe: 0, medium: 1, high: 2 })[t.riskLevel]);
    for (let i = 1; i < risks.length; i++) {
      assert.ok(risks[i - 1] <= risks[i], 'risk must be non-decreasing across the ranking');
    }
  });

  console.log('\n--- 10-11. grounded procedure vs. no procedure ---\n');

  await test('10. confirmed fault on a supported device hands off to the existing procedure', async () => {
    await withStubs(
      {
        // A Samsung Galaxy S21 with a visible USB-C charging board resolves to
        // the existing broken_charging_port scenario.
        detection: rawDevice(
          'Smartphone',
          { brand: 'Samsung', model: 'Galaxy S21' },
          [rawComp('USB-C Charging Board'), rawComp('Charging Flex')]
        ),
        reasoning: {
          observations: [],
          hypotheses: [
            { code: 'charging_port_fault', confidence: 0.95, rationale: 'stub', label: 'Port' }
          ]
        }
      },
      async () => {
        const view = await startDiagnose({
          image: IMAGE,
          userDescription: 'The charging port is damaged and it will not charge.'
        });

        assert.strictEqual(view.status, 'CONFIRMED');
        assert.strictEqual(view.likelyFault, 'charging_port_fault');
        assert.strictEqual(view.procedure.status, 'AVAILABLE');
        if (view.procedure.status === 'AVAILABLE') {
          assert.strictEqual(view.procedure.scenarioId, 'broken_charging_port');
        }
        assert.strictEqual(view.nextBestAction.kind, 'REPAIR_STEP');
        if (view.nextBestAction.kind === 'REPAIR_STEP') {
          assert.strictEqual(view.nextBestAction.scenarioId, 'broken_charging_port');
        }
      }
    );
  });

  await test('11. no grounded procedure: confirmed fault on an unsupported device stays advisory', async () => {
    await withStubs(
      {
        detection: rawDevice('Espresso Machine'),
        reasoning: {
          observations: [],
          hypotheses: [
            { code: 'power_adapter_fault', confidence: 0.95, rationale: 'stub', label: 'Adapter' }
          ]
        }
      },
      async () => {
        const view = await startDiagnose({
          image: IMAGE,
          userDescription: 'No power at all when plugged in.'
        });

        assert.strictEqual(view.status, 'CONFIRMED');
        assert.strictEqual(view.procedure.status, 'UNAVAILABLE');
        assert.strictEqual(view.nextBestAction.kind, 'COMPLETE');
        assert.ok(view.recommendation, 'an advisory recommendation should still be produced');
        // Advice must be generic, never step-by-step disassembly.
        assert.ok(
          view.recommendation!.advice.some((a) => /no verified step-by-step procedure/i.test(a)),
          `expected an explicit "no procedure" note, got: ${JSON.stringify(view.recommendation!.advice)}`
        );
      }
    );
  });

  await test('11b. supported device but a fault the procedure does not cover stays UNAVAILABLE', async () => {
    await withStubs(
      {
        detection: rawDevice(
          'Smartphone',
          { brand: 'Samsung', model: 'Galaxy S21' },
          [rawComp('USB-C Charging Board')]
        ),
        reasoning: {
          observations: [],
          // The charging-port procedure does not address a thermal fault.
          hypotheses: [{ code: 'thermal_fault', confidence: 0.95, rationale: 'stub', label: 'Thermal' }]
        }
      },
      async () => {
        const view = await startDiagnose({ image: IMAGE, userDescription: 'It gets extremely hot.' });

        assert.strictEqual(view.likelyFault, 'thermal_fault');
        assert.strictEqual(view.procedure.status, 'UNAVAILABLE', 'must not offer an unrelated procedure');
        assert.notStrictEqual(view.nextBestAction.kind, 'REPAIR_STEP');
      }
    );
  });

  console.log('\n--- 12-14. store lifetime, offline reasoning, malformed output ---\n');

  await test('12. session TTL expires sessions and cleanup is bounded', () => {
    resetStoreForTests();
    try {
      setSessionTtlMsForTests(20_000);
      const fresh = seedSession();
      assert.ok(getSession(fresh.sessionId), 'a fresh session must be retrievable');

      // Age the session past its TTL without waiting in real time.
      fresh.updatedAt = Date.now() - 60_000;
      assert.strictEqual(getSession(fresh.sessionId), null, 'an expired session must not be returned');
      assert.strictEqual(sessionCount(), 0, 'reading an expired session must evict it');

      // sweepExpired removes expired sessions in bulk and reports the count.
      const a = seedSession();
      const b = seedSession();
      a.updatedAt = Date.now() - 60_000;
      assert.strictEqual(sweepExpired(), 1, 'exactly the expired session should be swept');
      assert.strictEqual(sessionCount(), 1);
      assert.ok(getSession(b.sessionId), 'the live session must survive the sweep');
    } finally {
      setSessionTtlMsForTests(null);
      resetStoreForTests();
    }
  });

  await test('13. mock provider diagnostic reasoning is deterministic and in-vocabulary', async () => {
    const input = {
      symptom: 'The laptop screen is black but it powers on.',
      device: { type: 'Laptop', confidence: 0.9 },
      observations: [],
      candidateFaults: FAULT_CODES
    };

    const a = mockDiagnosticReasoning(input);
    const b = mockDiagnosticReasoning(input);
    assert.deepStrictEqual(a, b, 'the offline reasoner must be deterministic');

    const viaProvider = await mockProvider.proposeHypotheses(input);
    assert.deepStrictEqual(viaProvider, a, 'the provider method must delegate to the same logic');

    const normalized = normalizeDiagnosticReasoning(a, 'mock');
    assert.ok(normalized.hypotheses.length > 0, 'expected hypotheses');
    for (const h of normalized.hypotheses) {
      assert.ok(FAULT_CODES.includes(h.code), `${h.code} is outside the fault vocabulary`);
      assert.ok(h.confidence >= 0 && h.confidence <= 1, `confidence ${h.confidence} out of range`);
    }
    // Confidence must be ranked highest-first.
    for (let i = 1; i < normalized.hypotheses.length; i++) {
      assert.ok(
        normalized.hypotheses[i - 1].confidence >= normalized.hypotheses[i].confidence,
        'hypotheses must be ranked by confidence'
      );
    }
    // An unrecognised symptom must not be forced into a confident answer.
    const vague = normalizeDiagnosticReasoning(
      mockDiagnosticReasoning({ ...input, symptom: 'it is being weird', device: null }),
      'mock'
    );
    assert.strictEqual(vague.hypotheses[0].code, 'unknown');
    assert.ok(vague.hypotheses[0].confidence < 0.5, 'a vague symptom must stay low-confidence');
  });

  await test('14. malformed model output is rejected without inventing a diagnosis', () => {
    // Not an object at all.
    for (const raw of [null, undefined, 'nonsense', 42, []]) {
      const out = normalizeDiagnosticReasoning(raw, 'gemini');
      assert.strictEqual(out.hypotheses.length, 0, `raw ${JSON.stringify(raw)} produced hypotheses`);
      assert.ok(out.warnings.length > 0, 'a warning must explain the rejection');
    }

    // Object, but every hypothesis is unusable: unknown code, missing
    // confidence, wrong types, non-object entries.
    const messy = normalizeDiagnosticReasoning(
      {
        observations: [123, '', 'the device is a laptop'],
        hypotheses: [
          { code: 'alien_ray_fault', confidence: 0.9 },
          { code: 'battery_fault' },
          { code: 'battery_fault', confidence: 'not a number' },
          'not an object',
          null
        ]
      },
      'gemini'
    );
    assert.strictEqual(messy.hypotheses.length, 0, 'no hypothesis in that payload is usable');
    assert.deepStrictEqual(messy.observations, ['the device is a laptop'], 'only usable text survives');
    assert.ok(messy.warnings.some((w) => /dropped/i.test(w)), 'drops must be reported');

    // Out-of-range and duplicated codes are clamped/collapsed, not trusted.
    const clamped = normalizeDiagnosticReasoning(
      {
        hypotheses: [
          { code: 'battery_fault', confidence: 5 },
          { code: 'battery_fault', confidence: 40 },
          { code: 'thermal_fault', confidence: -3 }
        ]
      },
      'gemini'
    );
    const codes = clamped.hypotheses.map((h) => h.code);
    assert.strictEqual(new Set(codes).size, codes.length, 'duplicate codes must collapse');
    for (const h of clamped.hypotheses) {
      assert.ok(h.confidence >= 0 && h.confidence <= 1, `confidence ${h.confidence} not clamped`);
    }
  });

  await test('14b. a session built on malformed reasoning asks for more detail', async () => {
    await withStubs(
      { detection: rawDevice('Laptop'), reasoning: { hypotheses: 'not an array' } },
      async () => {
        const view = await startDiagnose({ image: IMAGE, userDescription: 'It is broken somehow.' });

        assert.strictEqual(view.hypotheses.length, 0);
        assert.strictEqual(view.likelyFault, null, 'no fault may be invented');
        assert.strictEqual(view.status, 'INSUFFICIENT_EVIDENCE');
        assert.strictEqual(view.nextBestAction.kind, 'ASK_USER');
        assert.strictEqual(view.procedure.status, 'UNAVAILABLE');
      }
    );
  });

  console.log('\n--- end-to-end loop ---\n');

  await test('15. full loop: symptom -> tests -> confirmed diagnosis, with no extra AI calls', async () => {
    let analyzeCalls = 0;
    let reasonCalls = 0;

    const prevProvider = process.env.AI_PROVIDER;
    const prevKey = process.env.GEMINI_API_KEY;
    const originalAnalyze = mockProvider.analyzeFrame;
    const originalPropose = mockProvider.proposeHypotheses;

    process.env.AI_PROVIDER = 'mock';
    delete process.env.GEMINI_API_KEY;
    (mockProvider as any).analyzeFrame = async () => {
      analyzeCalls++;
      return rawDevice('Laptop');
    };
    (mockProvider as any).proposeHypotheses = async (input: any) => {
      reasonCalls++;
      return mockDiagnosticReasoning(input);
    };
    resetProvider();

    try {
      let view = await startDiagnose({
        image: IMAGE,
        userDescription: 'The laptop screen is black but I can hear the fan running.'
      });
      assert.strictEqual(analyzeCalls, 1, 'exactly one perception call');
      assert.strictEqual(reasonCalls, 1, 'exactly one reasoning call');

      // Walk the loop until it stops asking for tests (bounded so a bug in the
      // selector cannot hang the suite).
      let guard = 0;
      while (view.nextBestAction.kind === 'DIAGNOSTIC_TEST' && guard++ < 12) {
        view = await postResult(view.sessionId, 'yes');
      }

      assert.ok(guard < 12, 'the loop must terminate');
      assert.ok(
        ['CONFIRMED', 'UNSAFE_TO_GUIDE', 'INSUFFICIENT_EVIDENCE'].includes(view.status),
        `unexpected terminal status ${view.status}`
      );
      assert.ok(view.testsPerformed.length > 0, 'tests should have been performed');
      // The whole loop after the first request costs ZERO model calls.
      assert.strictEqual(analyzeCalls, 1, 'no extra perception calls during the loop');
      assert.strictEqual(reasonCalls, 1, 'no extra reasoning calls during the loop');
    } finally {
      (mockProvider as any).analyzeFrame = originalAnalyze;
      (mockProvider as any).proposeHypotheses = originalPropose;
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
      resetProvider();
    }
  });

  await test('16. re-issuing /diagnose with a sessionId returns state without a new AI call', async () => {
    let analyzeCalls = 0;
    const prevProvider = process.env.AI_PROVIDER;
    const prevKey = process.env.GEMINI_API_KEY;
    const originalAnalyze = mockProvider.analyzeFrame;

    process.env.AI_PROVIDER = 'mock';
    delete process.env.GEMINI_API_KEY;
    (mockProvider as any).analyzeFrame = async () => {
      analyzeCalls++;
      return rawDevice('Laptop');
    };
    resetProvider();

    try {
      const first = await startDiagnose({ image: IMAGE, userDescription: 'Screen is black.' });
      assert.strictEqual(analyzeCalls, 1);

      const again = await startDiagnose({
        image: IMAGE,
        userDescription: 'Screen is black.',
        sessionId: first.sessionId
      });
      assert.strictEqual(again.sessionId, first.sessionId, 'the same session must be returned');
      assert.strictEqual(analyzeCalls, 1, 'a re-issued request must not call the model again');

      // An unknown session id is a 404, not a silent new session.
      const res = makeRes();
      await diagnose({ body: { sessionId: 'does-not-exist', userDescription: 'x' } } as any, res);
      assert.strictEqual(res.statusCode, 404);
    } finally {
      (mockProvider as any).analyzeFrame = originalAnalyze;
      if (prevProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prevProvider;
      if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevKey;
      resetProvider();
    }
  });

  await test('17. an empty request is rejected before any AI call', async () => {
    const res = makeRes();
    await diagnose({ body: {} } as any, res);
    assert.strictEqual(res.statusCode, 400);
  });

  console.log('\n--- hand-off gate hardening ---\n');

  await test('18. running out of safe checks never counts as a confirmed diagnosis', async () => {
    await withStubs(
      {
        // A device+fault pair that DOES have a grounded procedure, so the only
        // thing standing between this session and a physical repair hand-off is
        // the confirmation gate itself.
        detection: rawDevice(
          'Smartphone',
          { brand: 'Samsung', model: 'Galaxy S21' },
          [rawComp('USB-C Charging Board')]
        ),
        reasoning: {
          observations: [],
          hypotheses: [
            { code: 'charging_port_fault', confidence: 0.4, rationale: 'stub', label: 'Port' }
          ]
        }
      },
      async () => {
        let view = await startDiagnose({
          image: IMAGE,
          userDescription: 'It will not charge.'
        });

        // Answer every check "unclear", which yields no evidence either way, until
        // the selector runs out of applicable checks.
        let guard = 0;
        while (view.nextBestAction.kind === 'DIAGNOSTIC_TEST' && guard++ < 8) {
          view = await postResult(view.sessionId, 'unclear');
        }
        assert.ok(guard < 8, 'the loop must terminate');
        assert.ok(view.testsPerformed.length > 0, 'checks should have been offered and answered');

        // Exhaustion is not evidence. A 0.40 belief must not be dressed up as a
        // confirmed fault, and must not open the guided repair by itself.
        assert.strictEqual(view.status, 'INSUFFICIENT_EVIDENCE');
        assert.notStrictEqual(view.nextBestAction.kind, 'REPAIR_STEP');
        assert.strictEqual(view.nextBestAction.kind, 'COMPLETE');
        // The procedure genuinely exists — this is what makes the assertion sharp.
        assert.strictEqual(view.procedure.status, 'AVAILABLE');
        // The leading theory is still reported honestly, just not as a diagnosis.
        assert.strictEqual(view.likelyFault, 'charging_port_fault');
      }
    );
  });

  await test('19. "unknown" is never confirmed as the fault, however confident the model is', async () => {
    // Sole hypothesis: unsupported, and no fault is named.
    await withStubs(
      {
        detection: rawDevice('Laptop'),
        reasoning: {
          observations: [],
          hypotheses: [{ code: 'unknown', confidence: 0.99, rationale: 'stub', label: 'Unknown' }]
        }
      },
      async () => {
        const view = await startDiagnose({ image: IMAGE, userDescription: 'It behaves oddly.' });
        assert.notStrictEqual(view.status, 'CONFIRMED');
        assert.strictEqual(view.likelyFault, null);
        assert.notStrictEqual(view.nextBestAction.kind, 'REPAIR_STEP');
      }
    );

    // Outranking a real fault: "cause not determined" wins the ranking but must
    // neither become the diagnosis nor let the weaker real fault be confirmed.
    await withStubs(
      {
        detection: rawDevice(
          'Smartphone',
          { brand: 'Samsung', model: 'Galaxy S21' },
          [rawComp('USB-C Charging Board')]
        ),
        reasoning: {
          observations: [],
          hypotheses: [
            { code: 'unknown', confidence: 0.95, rationale: 'stub', label: 'Unknown' },
            { code: 'charging_port_fault', confidence: 0.5, rationale: 'stub', label: 'Port' }
          ]
        }
      },
      async () => {
        const view = await startDiagnose({ image: IMAGE, userDescription: 'It will not charge.' });
        assert.notStrictEqual(view.status, 'CONFIRMED');
        assert.notStrictEqual(view.likelyFault, 'unknown', '"unknown" must never be a diagnosis');
        assert.notStrictEqual(view.nextBestAction.kind, 'REPAIR_STEP');
      }
    );
  });

  await test('20. a repair can only be linked to a diagnosis with a grounded procedure', async () => {
    // Advisory-only session (unsupported device): linking must be refused.
    await withStubs(
      {
        detection: rawDevice('Espresso Machine'),
        reasoning: {
          observations: [],
          hypotheses: [
            { code: 'power_adapter_fault', confidence: 0.95, rationale: 'stub', label: 'Adapter' }
          ]
        }
      },
      async () => {
        const advisory = await startDiagnose({
          image: IMAGE,
          userDescription: 'No power at all when plugged in.'
        });
        assert.strictEqual(advisory.procedure.status, 'UNAVAILABLE');

        const res = makeRes();
        await linkDiagnosisRepair(
          { params: { sessionId: advisory.sessionId }, body: { repairId: 'repair-123' } } as any,
          res
        );
        assert.strictEqual(res.statusCode, 409, 'an advisory diagnosis must not accept a repair link');

        const after = makeRes();
        await diagnose({ body: { sessionId: advisory.sessionId } } as any, after);
        assert.strictEqual(after.body.session.linkedRepairId, null, 'nothing may have been recorded');
      }
    );

    // Grounded session: linking is bookkeeping and is allowed.
    await withStubs(
      {
        detection: rawDevice(
          'Smartphone',
          { brand: 'Samsung', model: 'Galaxy S21' },
          [rawComp('USB-C Charging Board')]
        ),
        reasoning: {
          observations: [],
          hypotheses: [
            { code: 'charging_port_fault', confidence: 0.95, rationale: 'stub', label: 'Port' }
          ]
        }
      },
      async () => {
        const grounded = await startDiagnose({
          image: IMAGE,
          userDescription: 'The charging port is damaged.'
        });
        assert.strictEqual(grounded.procedure.status, 'AVAILABLE');

        const res = makeRes();
        await linkDiagnosisRepair(
          { params: { sessionId: grounded.sessionId }, body: { repairId: 'repair-456' } } as any,
          res
        );
        assert.strictEqual(res.statusCode, 200, `expected 200, got ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.session.linkedRepairId, 'repair-456');
      }
    );

    // An unknown session is still a 404, not a 409.
    const missing = makeRes();
    await linkDiagnosisRepair(
      { params: { sessionId: 'no-such-session' }, body: { repairId: 'r' } } as any,
      missing
    );
    assert.strictEqual(missing.statusCode, 404);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
