/**
 * Diagnostic service — the orchestrator for the diagnostic copilot loop.
 *
 * Responsibilities and, just as importantly, non-responsibilities:
 *
 *   - it calls PERCEPTION (aiService.analyzeFrame) and REASONING
 *     (aiService.reasonAboutFault) as two separate, sequential steps. It never
 *     imports a provider or the Gemini SDK, never sees an API key, and never
 *     builds a prompt;
 *   - it owns the STRUCTURED session state (via diagnosticSessionStore) — the
 *     state is typed data, never a blob of model prose;
 *   - it NEVER decides a physical action. Every "what should the user do next"
 *     answer comes from the deterministic selector, and hypothesis updates after
 *     a test come from the test's own hand-written `interpret` function — not
 *     from another model call;
 *   - it NEVER authors a repair procedure. Step-by-step physical repair is only
 *     ever a hand-off to an existing grounded demoScenario; otherwise the
 *     procedure status stays UNAVAILABLE and the advice stays generic.
 *
 * Gemini cost: at most TWO model calls for an entire session (one perception
 * call if an image was supplied, one reasoning call), and ZERO for every
 * subsequent test result — those are pure, deterministic state updates.
 */

import { randomUUID } from 'crypto';
import { demoScenarios } from '../../data/demoScenarios';
import { DetectionResult } from '../../types/ai';
import {
  DiagnosisSession,
  DiagnosisSessionView,
  DiagnosisStatus,
  DiagnosticTest,
  FAULT_CODES,
  FAULT_LABELS,
  FaultCode,
  FaultHypothesis,
  NextBestAction,
  Observation,
  ProcedureAvailability,
  RepairRecommendation,
  TestAnswer
} from '../../types/diagnostic';
import { analyzeFrame, classifyFramePayload, reasonAboutFault } from '../aiService';
import { resolveScenario } from '../scenarioResolver';
import {
  createSession,
  getSession,
  saveSession
} from './diagnosticSessionStore';
import { getTestById } from './diagnosticTests';
import { selectNextTest } from './diagnosticTestSelector';

/**
 * Which faults each grounded demo procedure actually addresses.
 *
 * This exists so we never silently hand a user a procedure that has nothing to
 * do with their fault. The scenario resolver already gates on the DEVICE; this
 * gates on the FAULT. If a device matches a supported scenario but the
 * diagnosed fault is not in that scenario's list, the procedure stays
 * UNAVAILABLE and the copilot remains advisory — which is the honest answer.
 *
 * Hand-written from the actual step content of demoScenarios. Extend by hand
 * when a scenario is added.
 */
const SCENARIO_FAULTS: Record<string, FaultCode[]> = {
  // Steps cover bottom cover, battery connector, RAM clips, DDR4 module.
  laptop_ram_upgrade: ['loose_connection'],
  // Steps cover side cover, M.2 standoff, NVMe drive seating.
  ssd_installation: ['storage_fault', 'loose_connection'],
  // Steps cover MagSafe LED, battery isolation, SMC reset, external HDMI.
  laptop_not_booting: [
    'battery_fault',
    'power_adapter_fault',
    'mainboard_no_post',
    'display_backlight_fault',
    'loose_connection'
  ],
  // Steps cover the USB-C charging board / flex replacement.
  broken_charging_port: ['charging_port_fault'],
  // Steps cover antenna leads and the wireless chipset.
  wifi_adapter_issue: ['wireless_fault']
};

/** A fault is confident enough to act on at or above this belief. */
export const CONFIRM_CONFIDENCE = 0.7;
/** ...and must also lead the runner-up by at least this much. */
export const CONFIRM_MARGIN = 0.12;
/** Below this, the leading hypothesis is too weak to name as a diagnosis. */
export const MIN_USEFUL_CONFIDENCE = 0.25;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round2 = (value: number): number => Math.round(value * 100) / 100;

const observe = (source: Observation['source'], text: string): Observation => ({
  id: randomUUID(),
  source,
  text,
  at: Date.now()
});

/** Sort hypotheses by confidence, highest first. Pure. */
const ranked = (hypotheses: FaultHypothesis[]): FaultHypothesis[] =>
  [...hypotheses].sort((a, b) => b.confidence - a.confidence);

/**
 * Build the applicability context the selector and tests see. Data-only, so
 * test applicability stays a pure function of the session snapshot.
 */
const contextOf = (session: DiagnosisSession) => ({
  deviceType: session.deviceType,
  hypothesisCodes: session.hypotheses.map((h) => h.code),
  testsPerformed: session.testsPerformed
});

/**
 * Decide whether a grounded, step-by-step procedure exists for this session.
 *
 * Requires BOTH a device match (scenarioResolver, which is conservative and
 * returns null when ambiguous) AND that the diagnosed fault is one the matched
 * procedure actually addresses.
 */
const resolveProcedure = (
  scenarioId: string | null,
  scenarioReason: string,
  fault: FaultCode | null
): ProcedureAvailability => {
  if (!scenarioId || !demoScenarios[scenarioId]) {
    return { status: 'UNAVAILABLE', reason: scenarioReason };
  }
  if (!fault) {
    return {
      status: 'UNAVAILABLE',
      reason: `A guided procedure exists for this device (${scenarioId}), but no fault has been confirmed yet.`
    };
  }
  const addressed = SCENARIO_FAULTS[scenarioId] ?? [];
  if (!addressed.includes(fault)) {
    return {
      status: 'UNAVAILABLE',
      reason:
        `A guided procedure exists for this device (${scenarioId}), but it does not cover ` +
        `"${FAULT_LABELS[fault]}". No step-by-step repair is available for this fault.`
    };
  }
  return { status: 'AVAILABLE', scenarioId };
};

/** Generic, non-procedural advice. Safe to show for ANY device, including unsupported ones. */
const genericAdvice = (fault: FaultCode | null, procedure: ProcedureAvailability): string[] => {
  const advice: string[] = [];

  if (fault) {
    switch (fault) {
      case 'power_adapter_fault':
        advice.push('Replacing the charger or cable with a correctly rated equivalent is usually the lowest-risk fix.');
        break;
      case 'battery_fault':
        advice.push('A battery that no longer holds charge is a consumable part and is normally replaced rather than repaired.');
        break;
      case 'charging_port_fault':
        advice.push('Charging ports are soldered or connected internally; replacement usually needs disassembly and is best done by a technician unless a guided procedure is available.');
        break;
      case 'display_backlight_fault':
        advice.push('If an external display works, the internal panel or its cable is the suspect part.');
        break;
      case 'storage_fault':
        advice.push('Back up any accessible data before further troubleshooting — storage faults can worsen.');
        break;
      case 'thermal_fault':
        advice.push('Clear dust from vents and make sure airflow is unobstructed before considering internal work.');
        break;
      case 'wireless_fault':
        advice.push('Confirm the fault follows the device across different networks before opening anything.');
        break;
      case 'mainboard_no_post':
        advice.push('A board that will not power on generally needs bench-level diagnosis; component-level repair is not a DIY task.');
        break;
      case 'loose_connection':
        advice.push('Loose internal connections are often fixable, but only with proper anti-static handling.');
        break;
      default:
        break;
    }
  }

  if (procedure.status === 'UNAVAILABLE') {
    advice.push(
      'No verified step-by-step procedure is available for this device and fault, so no disassembly instructions will be given. Consider a qualified repair service.'
    );
  }

  return advice;
};

/** Build the advisory recommendation. Never contains physical steps. */
const buildRecommendation = (
  fault: FaultCode | null,
  confidence: number,
  procedure: ProcedureAvailability,
  status: DiagnosisStatus
): RepairRecommendation => {
  let summary: string;
  if (fault && status === 'CONFIRMED') {
    summary = `Most likely cause: ${FAULT_LABELS[fault]}.`;
  } else if (status === 'UNSAFE_TO_GUIDE') {
    summary =
      'The remaining checks that would narrow this down involve opening the device or working with live power, so they will not be guided here.';
  } else if (status === 'UNSUPPORTED') {
    summary = 'This symptom does not map to a fault this assistant can diagnose.';
  } else {
    summary = 'The evidence so far is not strong enough to name a single cause.';
  }

  return {
    summary,
    likelyFault: fault,
    confidence: round2(clamp01(confidence)),
    procedure,
    advice: genericAdvice(fault, procedure)
  };
};

/** Shape a chosen test into the client-facing next action. */
const testAction = (test: DiagnosticTest): NextBestAction => ({
  kind: 'DIAGNOSTIC_TEST',
  testId: test.id,
  title: test.title,
  instruction: test.instruction,
  question: test.question,
  riskLevel: test.riskLevel,
  observe: test.observe
});

/**
 * THE deterministic decision function.
 *
 * Given a session's evidence, decide status, likely fault, procedure
 * availability, recommendation and next action. Pure with respect to the model:
 * it makes no AI calls, so a test result can never trigger new inference, and
 * the same evidence always produces the same decision.
 *
 * Mutates and returns the session (the caller persists it).
 */
export const advanceSession = (
  session: DiagnosisSession,
  scenario: { scenarioId: string | null; reason: string }
): DiagnosisSession => {
  session.hypotheses = ranked(session.hypotheses);
  const top = session.hypotheses[0];

  // The leader that is allowed to become a diagnosis. `unknown` means "cause not
  // determined": it can rank, and it can outrank a real fault, but it can never
  // BE the answer and it never grounds a procedure.
  const lead = session.hypotheses.find((h) => h.code !== 'unknown') ?? null;
  // The strongest competing theory of ANY kind, including `unknown`. Confirming
  // over a stronger "I don't know" would be dishonest, so it counts as a rival.
  const rival = lead ? (session.hypotheses.find((h) => h.code !== lead.code) ?? null) : null;
  // Whether the lead is strong enough to even name as a leading suspicion. This
  // is a reporting floor, not a confirmation gate.
  const leadIsUseful = lead !== null && lead.confidence >= MIN_USEFUL_CONFIDENCE;

  // 1. No usable hypotheses at all (e.g. malformed model output). Fail closed:
  //    never invent a fault, ask the user for more detail instead.
  if (!top) {
    session.likelyFault = null;
    session.currentTestId = null;
    session.status = 'INSUFFICIENT_EVIDENCE';
    session.procedure = resolveProcedure(scenario.scenarioId, scenario.reason, null);
    session.repairRecommendation = buildRecommendation(null, 0, session.procedure, session.status);
    session.nextBestAction = {
      kind: 'ASK_USER',
      prompt:
        'I could not form a reliable theory from that. Can you describe what happens in more detail — when it started, and what the device does when you try to use it?'
    };
    return session;
  }

  // 2. Only "unknown" survived: the supported fault vocabulary does not cover
  //    this symptom. Say so rather than forcing a guess.
  if (top.code === 'unknown' && session.hypotheses.length === 1) {
    session.likelyFault = null;
    session.currentTestId = null;
    session.status = 'UNSUPPORTED';
    session.procedure = resolveProcedure(scenario.scenarioId, scenario.reason, null);
    session.repairRecommendation = buildRecommendation(
      null,
      top.confidence,
      session.procedure,
      session.status
    );
    session.nextBestAction = {
      kind: 'ASK_USER',
      prompt:
        'I do not have a diagnostic path for that symptom yet. If you can describe the problem differently, I will try again.'
    };
    return session;
  }

  // 3. Confident enough to act on? Requires a named fault (never `unknown`), a
  //    high belief in it, and a clear lead over the strongest rival theory — so
  //    two equally plausible faults, or a fault outranked by "cause not
  //    determined", never get "confirmed".
  const decisive =
    lead !== null &&
    lead.confidence >= CONFIRM_CONFIDENCE &&
    (!rival || lead.confidence - rival.confidence >= CONFIRM_MARGIN);

  if (decisive && lead) {
    session.likelyFault = lead.code;
    session.currentTestId = null;
    session.status = 'CONFIRMED';
    session.procedure = resolveProcedure(scenario.scenarioId, scenario.reason, lead.code);
    session.repairRecommendation = buildRecommendation(
      lead.code,
      lead.confidence,
      session.procedure,
      session.status
    );

    // Hand off to the EXISTING repair engine only when a grounded procedure
    // genuinely covers this device and this fault.
    session.nextBestAction =
      session.procedure.status === 'AVAILABLE'
        ? {
            kind: 'REPAIR_STEP',
            scenarioId: session.procedure.scenarioId,
            reason: `A verified guided repair is available for ${FAULT_LABELS[lead.code]} on this device.`
          }
        : { kind: 'COMPLETE', recommendation: session.repairRecommendation };
    return session;
  }

  // 4. Not confident yet — ask the deterministic selector for the safest
  //    remaining test. The model has no say in this.
  const decision = selectNextTest(contextOf(session));

  if (decision.kind === 'TEST') {
    session.likelyFault = null;
    session.currentTestId = decision.test.id;
    session.status = decision.test.observe === 'camera' ? 'NEEDS_VISUAL_EVIDENCE' : 'NEEDS_USER_INPUT';
    session.procedure = resolveProcedure(scenario.scenarioId, scenario.reason, null);
    session.repairRecommendation = null;
    session.nextBestAction = testAction(decision.test);
    return session;
  }

  if (decision.kind === 'ONLY_UNSAFE') {
    // Every remaining discriminating check is gated (high risk / live power /
    // disassembly). Stop rather than walk the user into it.
    session.likelyFault = leadIsUseful && lead ? lead.code : null;
    session.currentTestId = null;
    session.status = 'UNSAFE_TO_GUIDE';
    session.procedure = resolveProcedure(scenario.scenarioId, scenario.reason, session.likelyFault);
    session.repairRecommendation = buildRecommendation(
      session.likelyFault,
      lead?.confidence ?? top.confidence,
      session.procedure,
      session.status
    );
    // Name the actual reason it is gated rather than assuming disassembly: a
    // test can be gated by power, by disassembly, or by risk level alone.
    const hazard = decision.blocked.requiresPowerManipulation
      ? 'working with live electrical power'
      : decision.blocked.requiresDisassembly
        ? 'opening the device'
        : 'a step with a high risk of damage or injury';
    session.nextBestAction = {
      kind: 'STOP_UNSAFE',
      reason:
        `The only remaining check ("${decision.blocked.title}") involves ${hazard}` +
        ', so it will not be guided here. A qualified technician should take it from this point.'
    };
    return session;
  }

  // 5. No applicable tests left and still not confident. Report the best
  //    available theory honestly — but never as a confirmation, and never as a
  //    hand-off into physical repair. Running out of safe questions is not
  //    evidence; only the decisive gate above may start a guided repair.
  session.likelyFault = leadIsUseful && lead ? lead.code : null;
  session.currentTestId = null;
  session.status = 'INSUFFICIENT_EVIDENCE';
  session.procedure = resolveProcedure(scenario.scenarioId, scenario.reason, session.likelyFault);
  session.repairRecommendation = buildRecommendation(
    session.likelyFault,
    lead?.confidence ?? top.confidence,
    session.procedure,
    session.status
  );
  session.nextBestAction = { kind: 'COMPLETE', recommendation: session.repairRecommendation };
  return session;
};

export interface StartDiagnosisInput {
  /** Raw image payload from the request body, if any. */
  image?: unknown;
  /** The user's free-text symptom description. */
  userDescription?: unknown;
}

export interface StartDiagnosisOutcome {
  session: DiagnosisSession;
  /** Non-fatal notes about perception/reasoning quality, surfaced to the client. */
  warnings: string[];
}

/**
 * Begin a diagnosis: perceive (optional), reason once, then decide.
 *
 * The image is OPTIONAL by design: a symptom alone is enough to diagnose
 * generically, which is what makes this work for arbitrary devices. A supplied
 * frame only ever adds device context and, when it matches a supported
 * scenario, unlocks a grounded procedure.
 */
export const startDiagnosis = async (
  input: StartDiagnosisInput
): Promise<StartDiagnosisOutcome> => {
  const warnings: string[] = [];
  const observations: Observation[] = [];

  const symptomText =
    typeof input.userDescription === 'string' && input.userDescription.trim()
      ? input.userDescription.trim().slice(0, 1000)
      : null;

  // --- 1. PERCEPTION (at most one model call, only if a frame was sent) ------
  const frame = classifyFramePayload(input.image);
  let detection: DetectionResult | null = null;

  if (frame.kind === 'image') {
    detection = await analyzeFrame({ image: frame.image });
    warnings.push(...detection.warnings);

    if (detection.device) {
      const described = [detection.device.brand, detection.device.model, detection.device.type]
        .filter((part) => Boolean(part && part.trim()))
        .join(' ');
      observations.push(
        observe('camera', `Identified ${described} (confidence ${round2(detection.device.confidence)}).`)
      );
      for (const component of detection.components.slice(0, 4)) {
        observations.push(
          observe('camera', `Visible: ${component.name} (confidence ${round2(component.confidence)}).`)
        );
      }
    } else {
      observations.push(observe('system', 'No device could be identified from the camera frame.'));
    }
  } else if (frame.kind === 'placeholder') {
    warnings.push(frame.reason);
    observations.push(observe('system', 'No usable camera frame was supplied.'));
  } else if (frame.kind === 'invalid') {
    warnings.push(frame.error);
    observations.push(observe('system', 'The supplied camera frame could not be read.'));
  }

  if (symptomText) {
    observations.push(observe('user', symptomText));
  }

  // Nothing to work with at all: no symptom AND no identified device. Ask for
  // the cheaper input first (a better frame) rather than guessing.
  if (!symptomText && !detection?.device) {
    const session = createSession({
      device: null,
      deviceType: null,
      symptomText: null,
      observations,
      hypotheses: [],
      testsPerformed: [],
      currentTestId: null,
      testResults: [],
      status: 'NEEDS_VISUAL_EVIDENCE',
      likelyFault: null,
      repairRecommendation: null,
      procedure: {
        status: 'UNAVAILABLE',
        reason: 'No device was identified and no symptom was described.'
      },
      nextBestAction: {
        kind: 'RETRY_CAMERA',
        reason:
          'I could not identify the device and no symptom was described. Point the camera at the device in good light, or tell me what problem you are seeing.'
      },
      linkedRepairId: null
    });
    return { session, warnings };
  }

  // --- 2. PROCEDURE LOOKUP (deterministic, no model) ------------------------
  const scenario = detection
    ? resolveScenario(detection)
    : { scenarioId: null, reason: 'No camera frame was supplied, so no device-specific procedure could be matched.' };

  // --- 3. REASONING (exactly one model call, text-only) ---------------------
  const reasoning = await reasonAboutFault({
    symptom: symptomText ?? 'The user did not describe a symptom.',
    device: detection?.device ?? null,
    observations: observations.map((o) => o.text),
    candidateFaults: FAULT_CODES
  });
  warnings.push(...reasoning.warnings);

  for (const text of reasoning.observations) {
    observations.push(observe('system', text));
  }

  // --- 4. DECIDE (deterministic) -------------------------------------------
  const session = createSession({
    device: detection?.device ?? null,
    deviceType: detection?.device?.type ?? null,
    symptomText,
    observations,
    hypotheses: ranked(reasoning.hypotheses),
    testsPerformed: [],
    currentTestId: null,
    testResults: [],
    status: 'DIAGNOSING',
    likelyFault: null,
    repairRecommendation: null,
    procedure: { status: 'UNAVAILABLE', reason: scenario.reason },
    nextBestAction: { kind: 'ASK_USER', prompt: 'Gathering evidence.' },
    linkedRepairId: null
  });

  advanceSession(session, { scenarioId: scenario.scenarioId, reason: scenario.reason });
  saveSession(session);

  return { session, warnings };
};

export interface SubmitResultInput {
  /** The test the answer belongs to. Defaults to the session's current test. */
  testId?: unknown;
  answer?: unknown;
  note?: unknown;
}

export type SubmitResultOutcome =
  | { ok: true; session: DiagnosisSession; warnings: string[] }
  | { ok: false; code: 'NOT_FOUND' | 'NO_CURRENT_TEST' | 'BAD_ANSWER' | 'WRONG_TEST'; message: string };

const readAnswer = (value: unknown): TestAnswer | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'no' || normalized === 'unclear') return normalized;
  if (normalized === 'true') return 'yes';
  if (normalized === 'false') return 'no';
  return null;
};

/**
 * Record a test result and re-decide.
 *
 * Deliberately makes NO model call. Hypothesis confidences are updated by the
 * test's own hand-written `interpret` function, so the update is deterministic,
 * auditable, and free — and a user cannot burn Gemini quota by answering
 * questions repeatedly.
 */
export const submitTestResult = (
  sessionId: string,
  input: SubmitResultInput
): SubmitResultOutcome => {
  const session = getSession(sessionId);
  if (!session) {
    return { ok: false, code: 'NOT_FOUND', message: 'Unknown or expired diagnosis session.' };
  }

  if (!session.currentTestId) {
    return {
      ok: false,
      code: 'NO_CURRENT_TEST',
      message: 'This session is not waiting for a test result.'
    };
  }

  if (typeof input.testId === 'string' && input.testId.trim() && input.testId !== session.currentTestId) {
    return {
      ok: false,
      code: 'WRONG_TEST',
      message: `This session is waiting for the result of "${session.currentTestId}".`
    };
  }

  const answer = readAnswer(input.answer);
  if (!answer) {
    return {
      ok: false,
      code: 'BAD_ANSWER',
      message: 'Answer must be one of "yes", "no", or "unclear".'
    };
  }

  const test = getTestById(session.currentTestId);
  if (!test) {
    // Defensive: a catalog change removed the test mid-session.
    session.currentTestId = null;
    saveSession(session);
    return {
      ok: false,
      code: 'NO_CURRENT_TEST',
      message: 'The pending test is no longer available.'
    };
  }

  const note = typeof input.note === 'string' && input.note.trim()
    ? input.note.trim().slice(0, 300)
    : undefined;

  session.testResults.push({ testId: test.id, observedAt: Date.now(), answer, ...(note ? { note } : {}) });
  session.testsPerformed.push(test.id);
  session.currentTestId = null;
  session.observations.push(
    observe('user', `${test.question} → ${answer}${note ? ` (${note})` : ''}`)
  );

  // Deterministic hypothesis update from the test's own interpretation.
  const warnings: string[] = [];
  const effects = test.interpret(answer);
  if (effects.length === 0) {
    warnings.push('That answer did not change the theory; trying a different check.');
  }

  for (const effect of effects) {
    const existing = session.hypotheses.find((h) => h.code === effect.code);
    if (existing) {
      existing.confidence = clamp01(existing.confidence + effect.delta);
      if (effect.note && !existing.supportedBy.includes(effect.note)) {
        existing.supportedBy.push(effect.note);
      }
      continue;
    }
    // Only a POSITIVE effect may introduce a hypothesis the model did not list,
    // and it starts from zero — evidence, not invention.
    if (effect.delta > 0) {
      session.hypotheses.push({
        code: effect.code,
        label: FAULT_LABELS[effect.code],
        confidence: clamp01(effect.delta),
        rationale: effect.note,
        supportedBy: [effect.note]
      });
    }
  }

  // Drop hypotheses that evidence has effectively eliminated, so the selector
  // stops offering tests for them.
  session.hypotheses = ranked(session.hypotheses).filter((h) => h.confidence > 0.05);

  // Re-derive procedure context deterministically from the stored device.
  const scenario = session.device
    ? resolveScenario({ device: session.device, components: [], source: 'session', warnings: [] })
    : { scenarioId: null, reason: 'No device was identified for this session.' };

  advanceSession(session, {
    scenarioId: scenario.scenarioId,
    reason: 'reason' in scenario ? scenario.reason : 'No supported procedure matched.'
  });
  saveSession(session);

  return { ok: true, session, warnings };
};

/**
 * Record that a grounded repair session was started from this diagnosis, so the
 * diagnostic state links to the existing repair engine's record.
 *
 * Refuses when the session has no grounded procedure. Linking is bookkeeping,
 * but an advisory-only diagnosis must not end up carrying a repair record that
 * implies this build guided a physical repair for it.
 */
export const linkRepair = (
  sessionId: string,
  repairId: string
): { ok: true; session: DiagnosisSession } | { ok: false; code: string; message: string } => {
  const session = getSession(sessionId);
  if (!session) {
    return { ok: false, code: 'NOT_FOUND', message: 'Unknown or expired diagnosis session.' };
  }
  if (session.procedure.status !== 'AVAILABLE') {
    return {
      ok: false,
      code: 'NOT_GROUNDED',
      message:
        'This diagnosis has no grounded repair procedure, so a repair cannot be linked to it.'
    };
  }
  session.linkedRepairId = repairId;
  return { ok: true, session: saveSession(session) };
};

/** Project a session into the client-facing view. */
export const toSessionView = (session: DiagnosisSession): DiagnosisSessionView => ({
  sessionId: session.sessionId,
  status: session.status,
  device: session.device,
  deviceType: session.deviceType,
  symptom: session.symptomText,
  observations: session.observations,
  hypotheses: session.hypotheses.map((h) => ({ ...h, confidence: round2(h.confidence) })),
  testsPerformed: session.testsPerformed,
  currentTestId: session.currentTestId,
  likelyFault: session.likelyFault,
  procedure: session.procedure,
  recommendation: session.repairRecommendation,
  nextBestAction: session.nextBestAction,
  linkedRepairId: session.linkedRepairId,
  updatedAt: session.updatedAt
});

/** Fetch a live session view, or null when unknown/expired. */
export const getSessionView = (sessionId: string): DiagnosisSessionView | null => {
  const session = getSession(sessionId);
  return session ? toSessionView(session) : null;
};
