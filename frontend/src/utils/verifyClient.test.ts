/**
 * Unit tests for the pure verification interpreter and the decision helpers that
 * gate camera capture, step advancement, and completion persistence.
 *
 * These use Node's built-in test runner and assertions ONLY (`node:test`,
 * `node:assert/strict`) so they need no extra dependencies. Run with:
 *
 *   npx tsc --noEmit -p tsconfig.json        # typecheck (part of `next build`)
 *   node --test  (after compiling this file + verifyClient.ts to JS)
 *
 * or with any test runner (vitest/jest) once one is added to the frontend.
 *
 * verifyClient.ts is deliberately free of React/DOM/fetch, so the safety-
 * critical logic — "when may the repair advance / be marked complete?" — is
 * tested here in isolation, without a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  interpretVerification,
  errorView,
  canVerifyWithFrame,
  nextTransition,
  resolveCompletion,
  UNCERTAIN_GUIDANCE,
  VerifyResponse,
  VerificationView,
  RepairStepView,
} from './verifyClient';

// --- Fixtures -------------------------------------------------------------

const step = (index: number, title: string): RepairStepView => ({
  index,
  title,
  instruction: `Do step ${index}`,
});

/** Build a VerificationView the way interpretVerification would for a verdict. */
const view = (over: Partial<VerificationView> & { status: VerificationView['status'] }): VerificationView => ({
  verified: over.status === 'COMPLETED',
  shouldAdvance: false,
  repairComplete: false,
  confidencePercent: null,
  message: 'msg',
  guidance: null,
  nextStep: null,
  currentStep: null,
  observations: [],
  components: [],
  warnings: [],
  ...over,
});

// =========================================================================
// Existing interpreter behavior (regression guard for the tri-state gate).
// =========================================================================

test('interpret: COMPLETED with a nextStep verifies and may advance', () => {
  const data: VerifyResponse = {
    status: 'COMPLETED',
    verified: true,
    nextStep: step(2, 'Remove screws'),
  };
  const v = interpretVerification(data);
  assert.equal(v.status, 'COMPLETED');
  assert.equal(v.verified, true);
  assert.equal(v.shouldAdvance, true);
  assert.deepEqual(v.nextStep, step(2, 'Remove screws'));
});

test('interpret: COMPLETED final step (repairComplete) may advance to finish', () => {
  const v = interpretVerification({ status: 'COMPLETED', repairComplete: true, nextStep: null });
  assert.equal(v.verified, true);
  assert.equal(v.repairComplete, true);
  assert.equal(v.shouldAdvance, true);
});

test('interpret: COMPLETED with no nextStep and not complete refuses to advance', () => {
  const v = interpretVerification({ status: 'COMPLETED', repairComplete: false, nextStep: null });
  assert.equal(v.verified, true);
  assert.equal(v.shouldAdvance, false); // contradictory verdict -> hold
});

test('interpret: NOT_COMPLETED holds and never verifies', () => {
  const v = interpretVerification({ status: 'NOT_COMPLETED', nextStep: step(2, 'x') });
  assert.equal(v.verified, false);
  assert.equal(v.shouldAdvance, false);
});

test('interpret: UNCERTAIN holds and surfaces guidance', () => {
  const v = interpretVerification({ status: 'UNCERTAIN' });
  assert.equal(v.verified, false);
  assert.equal(v.shouldAdvance, false);
  assert.equal(v.guidance, UNCERTAIN_GUIDANCE);
});

test('interpret: unknown/missing status fails safe to UNCERTAIN, never COMPLETED', () => {
  const bogus = interpretVerification({ status: 'DONE?', nextStep: step(2, 'x') });
  assert.equal(bogus.status, 'UNCERTAIN');
  assert.equal(bogus.verified, false);
  assert.equal(bogus.shouldAdvance, false);

  const missing = interpretVerification({});
  assert.equal(missing.status, 'UNCERTAIN');
  assert.equal(missing.shouldAdvance, false);
});

test('errorView: every error holds position (never verified, never advances)', () => {
  for (const kind of ['invalid_image', 'not_found', 'unavailable', 'network'] as const) {
    const v = errorView(kind);
    assert.equal(v.status, 'ERROR');
    assert.equal(v.verified, false);
    assert.equal(v.shouldAdvance, false);
  }
});

// =========================================================================
// (a) captureFrame() returns null  ->  NO verify request is made.
// The page calls the verifier iff canVerifyWithFrame(frame) is true.
// =========================================================================

test('(a) null / empty / non-image frame is NOT verifiable — no request would be sent', () => {
  assert.equal(canVerifyWithFrame(null), false);
  assert.equal(canVerifyWithFrame(''), false);
  assert.equal(canVerifyWithFrame('not-a-data-url'), false);
  assert.equal(canVerifyWithFrame('data:text/plain;base64,QQ=='), false);
});

test('(a) a real data:image frame IS verifiable — the only path that sends a request', () => {
  assert.equal(canVerifyWithFrame('data:image/jpeg;base64,/9j/abc'), true);
  assert.equal(canVerifyWithFrame('data:image/png;base64,iVBORw0KGgo='), true);
});

test('(a) an unavailable camera produces a fail-safe ERROR view (step stays active)', () => {
  const v = errorView('camera_unavailable');
  assert.equal(v.status, 'ERROR');
  assert.equal(v.verified, false);
  assert.equal(v.shouldAdvance, false);
  assert.match(v.message, /Camera frame unavailable/i);
});

// =========================================================================
// (b) COMPLETED + nextStep  ->  advance to the backend-supplied step.
// =========================================================================

test('(b) nextTransition advances to the backend nextStep index on COMPLETED', () => {
  const v = view({ status: 'COMPLETED', verified: true, nextStep: step(3, 'Seat the RAM') });
  const t = nextTransition(v);
  assert.equal(t.kind, 'advance');
  assert.equal(t.kind === 'advance' && t.toIndex, 3);
});

test('(b) nextTransition finishes when the backend reports repairComplete', () => {
  const v = view({ status: 'COMPLETED', verified: true, repairComplete: true });
  assert.equal(nextTransition(v).kind, 'finish');
});

// =========================================================================
// (c) COMPLETED + no nextStep + repairComplete false  ->  do NOT advance.
// (No local "+1" fallback exists; the transition must hold.)
// =========================================================================

test('(c) nextTransition holds on COMPLETED with no nextStep and not complete', () => {
  const v = view({ status: 'COMPLETED', verified: true, nextStep: null, repairComplete: false });
  const t = nextTransition(v);
  assert.equal(t.kind, 'hold');
  assert.equal(t.kind === 'hold' && typeof t.reason, 'string');
});

test('(c) nextTransition holds for unverified verdicts and for a null view', () => {
  assert.equal(nextTransition(view({ status: 'NOT_COMPLETED' })).kind, 'hold');
  assert.equal(nextTransition(view({ status: 'UNCERTAIN' })).kind, 'hold');
  assert.equal(nextTransition(null).kind, 'hold');
});

// =========================================================================
// (d) Persistence failure  ->  current step remains active (not marked done).
// =========================================================================

test('(d) resolveCompletion withholds completion and surfaces an error when persistence fails', () => {
  const completed = view({ status: 'COMPLETED', verified: true, nextStep: step(2, 'x') });
  const r = resolveCompletion(completed, 'failed');
  assert.equal(r.markStepComplete, false); // step stays active
  assert.equal(r.view.status, 'ERROR'); // swapped to persist_failed
  assert.equal(r.view.shouldAdvance, false);
  assert.match(r.view.message, /saving progress to the server failed/i);
});

test('(d) resolveCompletion marks the step complete when persistence succeeds or is skipped', () => {
  const completed = view({ status: 'COMPLETED', verified: true, nextStep: step(2, 'x') });
  const ok = resolveCompletion(completed, 'ok');
  assert.equal(ok.markStepComplete, true);
  assert.equal(ok.view, completed); // unchanged view, ready to advance

  const skipped = resolveCompletion(completed, 'skipped');
  assert.equal(skipped.markStepComplete, true); // guest session: local-only completion
});

test('(d) resolveCompletion never marks non-COMPLETED verdicts complete, regardless of persistence', () => {
  for (const status of ['NOT_COMPLETED', 'UNCERTAIN', 'ERROR'] as const) {
    const v = view({ status });
    for (const p of ['ok', 'failed', 'skipped'] as const) {
      assert.equal(resolveCompletion(v, p).markStepComplete, false);
    }
  }
});
