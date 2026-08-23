/**
 * Deterministic diagnostic test selector.
 *
 * This module is AUTHORITATIVE over which test/action may be offered to the
 * user. The reasoning provider can propose hypotheses and confidences, but it
 * can never choose a physical action — that decision is made here, by pure
 * functions over the session snapshot, with an explicit safety gate.
 *
 * Safety-first policy, applied in this exact order (spec):
 *   1. lowest physical risk
 *   2. reversible before irreversible
 *   3. no disassembly before disassembly
 *   4. no power manipulation before power manipulation
 *   5. lower difficulty
 *   6. higher information value
 *
 * Hard gate: a high-risk test, a test that requires power manipulation, or a
 * test that requires disassembly is NEVER auto-selected. Such actions can still
 * be surfaced to the user as advice by higher layers, but this selector will
 * not put one in front of the user as "the next thing to do".
 */

import {
  DiagnosticTest,
  FaultCode,
  TestApplicabilityContext
} from '../../types/diagnostic';
import { DIAGNOSTIC_TESTS } from './diagnosticTests';

const RISK_RANK: Record<DiagnosticTest['riskLevel'], number> = {
  safe: 0,
  medium: 1,
  high: 2
};

/**
 * The safety gate: may this test be offered automatically as the next action?
 *
 * High-risk, power-manipulation, and disassembly tests are all excluded. This
 * is intentionally stricter than "not high risk": on an arbitrary, possibly
 * unsupported device we must not walk a user into opening the case or touching
 * live power, both of which edge into physical-repair territory that must be
 * grounded in a real procedure, not improvised from a diagnosis.
 */
export const isAutoSelectable = (test: DiagnosticTest): boolean =>
  test.riskLevel !== 'high' && !test.requiresPowerManipulation && !test.requiresDisassembly;

/**
 * Safety-first comparator. Returns <0 when `a` should be preferred over `b`.
 * Deterministic and total: ties fall through to a stable id comparison so the
 * same context always yields the same ordering.
 */
export const compareBySafety = (a: DiagnosticTest, b: DiagnosticTest): number => {
  if (RISK_RANK[a.riskLevel] !== RISK_RANK[b.riskLevel]) {
    return RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel];
  }
  const rev = Number(a.reversibility === 'irreversible') - Number(b.reversibility === 'irreversible');
  if (rev !== 0) return rev;
  const dis = Number(a.requiresDisassembly) - Number(b.requiresDisassembly);
  if (dis !== 0) return dis;
  const pow = Number(a.requiresPowerManipulation) - Number(b.requiresPowerManipulation);
  if (pow !== 0) return pow;
  if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty;
  if (a.informationValue !== b.informationValue) return b.informationValue - a.informationValue;
  return a.id.localeCompare(b.id);
};

/**
 * Tests that apply to the current session and have not been performed yet.
 * Applicability is a pure predicate on the context (the test's own `appliesTo`).
 */
export const applicableTests = (ctx: TestApplicabilityContext): DiagnosticTest[] =>
  DIAGNOSTIC_TESTS.filter(
    (test) => !ctx.testsPerformed.includes(test.id) && test.appliesTo(ctx)
  ).sort(compareBySafety);

/**
 * The selector's verdict about the next diagnostic step.
 *
 *   - TEST        a safe, auto-selectable test was chosen;
 *   - ONLY_UNSAFE applicable tests exist, but every one is gated (high risk /
 *                 power / disassembly) — none may be auto-offered;
 *   - NONE        no applicable, not-yet-performed test exists at all.
 */
export type SelectorDecision =
  | { kind: 'TEST'; test: DiagnosticTest }
  | { kind: 'ONLY_UNSAFE'; blocked: DiagnosticTest }
  | { kind: 'NONE' };

/**
 * Choose the next diagnostic step for a session context.
 *
 * Never returns a gated test as a TEST. When the only remaining discriminating
 * options are gated, it reports ONLY_UNSAFE (naming the highest-value blocked
 * test) so the caller can decline safely rather than guess.
 */
export const selectNextTest = (ctx: TestApplicabilityContext): SelectorDecision => {
  const applicable = applicableTests(ctx);
  if (applicable.length === 0) return { kind: 'NONE' };

  const safe = applicable.filter(isAutoSelectable);
  if (safe.length === 0) {
    // applicable is already safety-sorted; the first gated one is the least-bad,
    // highest-value blocked candidate — surfaced only to explain the block.
    return { kind: 'ONLY_UNSAFE', blocked: applicable[0] };
  }

  return { kind: 'TEST', test: safe[0] };
};

/** Convenience for callers building an applicability context from hypotheses. */
export const hypothesisCodesOf = (codes: FaultCode[]): FaultCode[] => [...new Set(codes)];
