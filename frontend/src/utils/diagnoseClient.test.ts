/**
 * Unit tests for the PURE diagnose-response interpreter.
 *
 * Same conventions as verifyClient.test.ts: no test framework, no React, no DOM.
 * Compiled with tsc and run with plain node. Exits non-zero on any failure.
 *
 * These tests exist to pin the two rules that must never regress on the client:
 *   - a step-by-step repair is offered ONLY when the server confirmed a fault AND
 *     published a grounded procedure;
 *   - anything malformed fails safe (no hypotheses, no action, no hand-off).
 */

import assert from 'assert';

import {
  interpretDiagnosis,
  errorDiagnosisView,
  errorKindForStatus,
  canStartDiagnosis,
  handoff,
  DiagnosisView
} from '../utils/diagnoseClient';

let passed = 0;
let failed = 0;
const failures: string[] = [];

const test = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
};

/** A representative mid-diagnosis session body. */
const testingSession = (over: Record<string, unknown> = {}) => ({
  session: {
    sessionId: 'sess-1',
    status: 'NEEDS_USER_INPUT',
    device: { type: 'Laptop', brand: 'Dell', model: 'XPS 13', confidence: 0.9 },
    deviceType: 'Laptop',
    symptom: 'Screen stays black.',
    observations: [{ id: 'o1', source: 'camera', text: 'A closed laptop on a desk.', at: 1 }],
    hypotheses: [
      {
        code: 'display_backlight_fault',
        label: 'Display or backlight fault',
        confidence: 0.45,
        rationale: 'Powers on but no image.',
        supportedBy: []
      },
      {
        code: 'mainboard_no_post',
        label: 'Mainboard does not POST',
        confidence: 0.3,
        rationale: 'No boot activity reported.',
        supportedBy: []
      }
    ],
    testsPerformed: [],
    currentTestId: 'external_display_check',
    likelyFault: null,
    procedure: { status: 'UNAVAILABLE', reason: 'No confirmed fault yet.' },
    recommendation: null,
    nextBestAction: {
      kind: 'DIAGNOSTIC_TEST',
      testId: 'external_display_check',
      title: 'Connect an external display',
      instruction: 'Plug the laptop into an external monitor or TV.',
      question: 'Does an image appear on the external screen?',
      riskLevel: 'safe',
      observe: 'user'
    },
    linkedRepairId: null,
    updatedAt: 1,
    ...over
  },
  warnings: []
});

console.log('\n--- diagnoseClient: interpretation ---\n');

test('renders the four panels from a mid-diagnosis session', () => {
  const view = interpretDiagnosis(testingSession());

  assert.strictEqual(view.sessionId, 'sess-1');
  assert.strictEqual(view.deviceLabel, 'Dell XPS 13 (Laptop)');
  // What I see
  assert.deepStrictEqual(view.see, ['A closed laptop on a desk.']);
  // What I think
  assert.strictEqual(view.think.length, 2);
  assert.strictEqual(view.think[0].confidencePercent, '45');
  // What I need you to do
  assert.ok(view.action);
  assert.strictEqual(view.action!.kind, 'DIAGNOSTIC_TEST');
  assert.strictEqual(view.action!.testId, 'external_display_check');
  assert.strictEqual(view.action!.answerable, true);
  assert.strictEqual(view.action!.riskLevel, 'safe');
  // Why
  assert.ok(view.why && view.why.length > 0, 'a why line should be present');
  // Nothing confirmed, nothing to hand off.
  assert.strictEqual(view.confirmed, false);
  assert.strictEqual(view.procedureScenarioId, null);
  assert.strictEqual(handoff(view).kind, 'continue');
});

test('device label falls back to the bare type, then to null', () => {
  const typeOnly = interpretDiagnosis(
    testingSession({ device: { type: 'Smartphone', confidence: 0.8 } })
  );
  assert.strictEqual(typeOnly.deviceLabel, 'Smartphone');

  const none = interpretDiagnosis(testingSession({ device: null, deviceType: null }));
  assert.strictEqual(none.deviceLabel, null);
});

test('an unknown status is treated as DIAGNOSING, never CONFIRMED', () => {
  const view = interpretDiagnosis(testingSession({ status: 'TOTALLY_FINE' }));
  assert.strictEqual(view.status, 'DIAGNOSING');
  assert.strictEqual(view.confirmed, false);
  assert.strictEqual(handoff(view).kind, 'continue');
});

test('an unknown action kind yields no action at all', () => {
  const view = interpretDiagnosis(
    testingSession({ nextBestAction: { kind: 'CUT_THE_RED_WIRE', instruction: 'do it' } })
  );
  assert.strictEqual(view.action, null, 'an unrecognized action must never be rendered');
});

test('a DIAGNOSTIC_TEST without a testId is refused', () => {
  const view = interpretDiagnosis(
    testingSession({
      nextBestAction: { kind: 'DIAGNOSTIC_TEST', title: 'Do a thing', instruction: 'x' }
    })
  );
  assert.strictEqual(view.action, null, 'an unanswerable test must not be offered');
});

test('a missing risk level is assumed HIGH, not safe', () => {
  const view = interpretDiagnosis(
    testingSession({
      nextBestAction: {
        kind: 'DIAGNOSTIC_TEST',
        testId: 't1',
        title: 'Something',
        instruction: 'x',
        question: 'y'
      }
    })
  );
  assert.ok(view.action);
  assert.strictEqual(view.action!.riskLevel, 'high', 'unknown risk must fail safe to high');
});

console.log('\n--- diagnoseClient: hand-off gating ---\n');

test('hands off ONLY when confirmed AND a grounded procedure is available', () => {
  const view = interpretDiagnosis(
    testingSession({
      status: 'CONFIRMED',
      likelyFault: 'charging_port_fault',
      procedure: { status: 'AVAILABLE', scenarioId: 'broken_charging_port' },
      recommendation: {
        summary: 'The charging port is the most likely fault.',
        likelyFault: 'charging_port_fault',
        confidence: 0.9,
        procedure: { status: 'AVAILABLE', scenarioId: 'broken_charging_port' },
        advice: ['A verified procedure is available for this device.']
      },
      nextBestAction: {
        kind: 'REPAIR_STEP',
        scenarioId: 'broken_charging_port',
        reason: 'A verified procedure covers this fault.'
      }
    })
  );

  assert.strictEqual(view.confirmed, true);
  assert.strictEqual(view.procedureScenarioId, 'broken_charging_port');
  assert.strictEqual(view.action, null, 'REPAIR_STEP is not an answerable diagnostic action');
  assert.strictEqual(view.finished, true);
  const decision = handoff(view);
  assert.strictEqual(decision.kind, 'repair');
  if (decision.kind === 'repair') {
    assert.strictEqual(decision.scenarioId, 'broken_charging_port');
  }
});

test('a confirmed fault with NO grounded procedure stays advisory', () => {
  const view = interpretDiagnosis(
    testingSession({
      status: 'CONFIRMED',
      likelyFault: 'power_adapter_fault',
      procedure: { status: 'UNAVAILABLE', reason: 'No verified procedure for an espresso machine.' },
      recommendation: {
        summary: 'The power adapter is the most likely fault.',
        likelyFault: 'power_adapter_fault',
        confidence: 0.9,
        procedure: { status: 'UNAVAILABLE', reason: 'No verified procedure.' },
        advice: ['Replace the adapter with a like-for-like unit.']
      },
      nextBestAction: {
        kind: 'COMPLETE',
        recommendation: {
          summary: 'The power adapter is the most likely fault.',
          likelyFault: 'power_adapter_fault',
          confidence: 0.9,
          procedure: { status: 'UNAVAILABLE', reason: 'No verified procedure.' },
          advice: []
        }
      }
    })
  );

  assert.strictEqual(view.confirmed, true);
  assert.strictEqual(view.procedureScenarioId, null);
  assert.ok(view.advice.length > 0, 'advice should still be rendered');
  const decision = handoff(view);
  assert.strictEqual(decision.kind, 'advice');
  if (decision.kind === 'advice') {
    assert.ok(decision.reason.length > 0, 'the user must be told why there is no procedure');
  }
});

test('an AVAILABLE procedure without a confirmed fault does NOT hand off', () => {
  const view = interpretDiagnosis(
    testingSession({
      status: 'DIAGNOSING',
      likelyFault: null,
      procedure: { status: 'AVAILABLE', scenarioId: 'broken_charging_port' }
    })
  );
  assert.strictEqual(view.confirmed, false);
  assert.strictEqual(handoff(view).kind, 'continue', 'an unconfirmed fault must not start a repair');
});

test('a malformed procedure block never yields a scenario id', () => {
  for (const procedure of [null, undefined, 'AVAILABLE', { status: 'AVAILABLE' }, {}]) {
    const view = interpretDiagnosis(
      testingSession({ status: 'CONFIRMED', likelyFault: 'battery_fault', procedure })
    );
    assert.strictEqual(
      view.procedureScenarioId,
      null,
      `procedure ${JSON.stringify(procedure)} must not produce a scenario`
    );
    assert.notStrictEqual(handoff(view).kind, 'repair');
  }
});

test('UNSAFE_TO_GUIDE renders the reason and offers no action to perform', () => {
  const view = interpretDiagnosis(
    testingSession({
      status: 'UNSAFE_TO_GUIDE',
      currentTestId: null,
      nextBestAction: {
        kind: 'STOP_UNSAFE',
        reason: 'The only remaining check requires opening the device.'
      }
    })
  );

  assert.ok(view.action);
  assert.strictEqual(view.action!.answerable, false, 'an unsafe stop is not answerable');
  assert.strictEqual(view.action!.kind, 'STOP_UNSAFE');
  assert.strictEqual(view.why, 'The only remaining check requires opening the device.');
  assert.strictEqual(view.finished, true);
  assert.notStrictEqual(handoff(view).kind, 'repair');
});

test('advice never claims "no procedure exists" when one actually does', () => {
  // Finished without a confirmation, but the backend did publish a grounded
  // procedure. The reason must be about confidence, not about availability.
  const view = interpretDiagnosis(
    testingSession({
      status: 'INSUFFICIENT_EVIDENCE',
      likelyFault: 'charging_port_fault',
      currentTestId: null,
      procedure: { status: 'AVAILABLE', scenarioId: 'broken_charging_port' },
      nextBestAction: {
        kind: 'COMPLETE',
        recommendation: {
          summary: 'The charging port is the leading theory.',
          likelyFault: 'charging_port_fault',
          confidence: 0.4,
          procedure: { status: 'AVAILABLE', scenarioId: 'broken_charging_port' },
          advice: []
        }
      }
    })
  );

  assert.strictEqual(view.confirmed, false, 'INSUFFICIENT_EVIDENCE is not a confirmation');
  const decision = handoff(view);
  assert.strictEqual(decision.kind, 'advice', 'an unconfirmed fault must not start a repair');
  if (decision.kind === 'advice') {
    assert.ok(
      !/no verified step-by-step procedure/i.test(decision.reason),
      `must not deny a procedure that exists, got: ${decision.reason}`
    );
    assert.ok(/confiden/i.test(decision.reason), `should explain the real reason, got: ${decision.reason}`);
  }
});

console.log('\n--- diagnoseClient: malformed and error handling ---\n');

test('a malformed body fails safe with no hypotheses and no action', () => {
  for (const body of [{}, { session: null }, { session: 'nope' }, { session: [] }]) {
    const view = interpretDiagnosis(body as any);
    assert.strictEqual(view.status, 'ERROR');
    assert.strictEqual(view.think.length, 0);
    assert.strictEqual(view.action, null);
    assert.strictEqual(view.confirmed, false);
    assert.strictEqual(view.procedureScenarioId, null);
    assert.strictEqual(handoff(view).kind, 'continue');
  }
});

test('unusable hypotheses are dropped and confidences are clamped', () => {
  const view = interpretDiagnosis(
    testingSession({
      hypotheses: [
        { code: 'battery_fault', label: 'Battery', confidence: 5, rationale: 'x' },
        { code: 'no_confidence', label: 'Nope' },
        { label: 'no code', confidence: 0.5 },
        'not an object',
        null
      ]
    })
  );

  assert.strictEqual(view.think.length, 1, 'only the usable hypothesis should survive');
  assert.strictEqual(view.think[0].confidence, 1, 'out-of-range confidence must clamp to 1');
  assert.strictEqual(view.think[0].confidencePercent, '100');
});

test('observations that are not usable text are dropped', () => {
  const view = interpretDiagnosis(
    testingSession({ observations: [{ text: '  ' }, { text: 'A real note.' }, 42, null, 'plain'] })
  );
  assert.deepStrictEqual(view.see, ['A real note.', 'plain']);
});

test('every error view holds position: no action, no hand-off', () => {
  const kinds = [
    'bad_request',
    'not_found',
    'conflict',
    'unavailable',
    'network',
    'camera_unavailable',
    'malformed'
  ] as const;
  for (const kind of kinds) {
    const view: DiagnosisView = errorDiagnosisView(kind);
    assert.strictEqual(view.status, 'ERROR');
    assert.strictEqual(view.action, null);
    assert.strictEqual(view.confirmed, false);
    assert.strictEqual(view.procedureScenarioId, null);
    assert.ok(view.message.length > 0, `${kind} must have a message`);
    assert.strictEqual(handoff(view).kind, 'continue');
  }
  const detailed = errorDiagnosisView('network', 'timed out');
  assert.ok(detailed.message.includes('timed out'), 'detail should be surfaced');
});

test('HTTP statuses map onto the right error kinds', () => {
  assert.strictEqual(errorKindForStatus(400), 'bad_request');
  assert.strictEqual(errorKindForStatus(404), 'not_found');
  assert.strictEqual(errorKindForStatus(409), 'conflict');
  assert.strictEqual(errorKindForStatus(500), 'unavailable');
  assert.strictEqual(errorKindForStatus(503), 'unavailable');
});

test('a diagnosis needs a symptom or a real frame', () => {
  assert.strictEqual(canStartDiagnosis('', null), false);
  assert.strictEqual(canStartDiagnosis('   ', null), false);
  assert.strictEqual(canStartDiagnosis('screen is black', null), true);
  assert.strictEqual(canStartDiagnosis('', 'data:image/jpeg;base64,AAAA'), true);
  // A non-data-URL is not a real capture.
  assert.strictEqual(canStartDiagnosis('', 'blob:http://x/y'), false);
  assert.strictEqual(canStartDiagnosis('', 'null'), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
